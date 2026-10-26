import { describe, expect, test } from 'bun:test';
import {
  buildPoolForecast,
  poolLimitCandidates,
  selectPoolLimitId,
  type PoolAccount,
  type PoolObservation,
  type PoolOptions,
} from '@/features/quota/poolModel';
import type { LedgerMeter } from '@/features/quota/ledgerModel';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0);
const WEEK_HOURS = 168;

const options = (extra: Partial<PoolOptions> = {}): PoolOptions => ({
  nowMs: NOW,
  burnWindowHours: 3,
  futureFactor: 1,
  startMs: NOW - 3 * 24 * HOUR,
  horizonMs: NOW + 11 * 24 * HOUR,
  ...extra,
});

/** Readings every ten minutes from `fromMs` to NOW, falling at `perHour`. */
const watched = (fromMs: number, startRemaining: number, perHour: number, resetAtMs: number) => {
  const points: PoolObservation[] = [];
  for (let atMs = fromMs; atMs <= NOW; atMs += 10 * MINUTE) {
    points.push({
      atMs,
      remaining: startRemaining - ((atMs - fromMs) / HOUR) * perHour,
      resetAtMs,
    });
  }
  return points;
};

const account = (
  key: string,
  reading: PoolAccount['reading'],
  history: PoolObservation[] = []
): PoolAccount => ({ key, name: key, reading, history });

const meter = (id: string, periodHours: number): LedgerMeter => ({
  id,
  label: id,
  remaining: 50,
  resetAtMs: null,
  periodHours,
});

describe('pool limit selection', () => {
  test('prefers the general weekly limit over model-scoped ones', () => {
    const meters = [meter('five-hour', 5), meter('seven-day-opus', 168), meter('seven-day', 168)];
    expect(poolLimitCandidates('claude', meters)).toEqual(['seven-day']);
    expect(selectPoolLimitId('claude', [meters])).toBe('seven-day');
  });

  test('keeps one limit for the whole provider even if one account lacks it', () => {
    const team = [meter('five-hour', 5), meter('monthly', 720)];
    const plus = [meter('five-hour', 5), meter('weekly', 168)];
    expect(selectPoolLimitId('codex', [team, plus])).toBe('weekly');
  });

  test('falls back to the first long window for providers without a preference', () => {
    expect(
      poolLimitCandidates('antigravity', [meter('daily', 5), meter('weekly-pro', 168)])
    ).toEqual(['weekly-pro']);
  });
});

describe('recorded history', () => {
  test('draws observations only and leaves unwatched time blank', () => {
    const resetAtMs = NOW + 48 * HOUR;
    const morning = watched(NOW - 4 * HOUR, 80, 2, resetAtMs).filter(
      (p) => p.atMs <= NOW - 3.5 * HOUR
    );
    const noon = watched(NOW - HOUR, 70, 2, resetAtMs);
    const forecast = buildPoolForecast(
      [account('a', { ...noon[noon.length - 1], periodHours: WEEK_HOURS }, [...morning, ...noon])],
      options()
    );
    expect(forecast.recorded).toHaveLength(2);
    expect(forecast.recorded[0][0]).toEqual({ atMs: NOW - 4 * HOUR, value: 80 });
    expect(forecast.recorded[1].at(-1)?.atMs).toBe(NOW);
  });

  test('breaks the pool line where any included account was not watched', () => {
    const resetAtMs = NOW + 48 * HOUR;
    const a = watched(NOW - 2 * HOUR, 90, 1, resetAtMs);
    const b = watched(NOW - HOUR, 60, 1, resetAtMs);
    const forecast = buildPoolForecast(
      [
        account('a', { ...a[a.length - 1], periodHours: WEEK_HOURS }, a),
        account('b', { ...b[b.length - 1], periodHours: WEEK_HOURS }, b),
      ],
      options()
    );
    expect(forecast.recorded).toHaveLength(1);
    expect(forecast.recorded[0][0].atMs).toBe(NOW - HOUR);
    expect(forecast.recorded[0][0].value).toBeCloseTo(89 + 60, 5);
  });

  test('does not join readings across a reset', () => {
    const before = { atMs: NOW - 30 * MINUTE, remaining: 10, resetAtMs: NOW - 20 * MINUTE };
    const after = { atMs: NOW, remaining: 100, resetAtMs: NOW + WEEK_HOURS * HOUR };
    const forecast = buildPoolForecast(
      [account('a', { ...after, periodHours: WEEK_HOURS }, [before])],
      options()
    );
    expect(forecast.recorded).toHaveLength(2);
  });
});

describe('burn rate', () => {
  test('measures recent use when the window was watched', () => {
    const history = watched(NOW - 3 * HOUR, 80, 2, NOW + 48 * HOUR);
    const forecast = buildPoolForecast(
      [account('a', { ...history[history.length - 1], periodHours: WEEK_HOURS }, history)],
      options()
    );
    expect(forecast.burn?.source).toBe('recent');
    expect(forecast.burn?.perHour).toBeCloseTo(2, 5);
  });

  test('falls back to the average since the window opened', () => {
    // Opened 72 hours ago (reset in 96 of 168), 36% used.
    const forecast = buildPoolForecast(
      [
        account('a', {
          atMs: NOW,
          remaining: 64,
          resetAtMs: NOW + 96 * HOUR,
          periodHours: WEEK_HOURS,
        }),
      ],
      options()
    );
    expect(forecast.burn).toEqual({ perHour: 0.5, source: 'since-reset' });
  });

  test('withholds the forecast until every included account has a reading', () => {
    const forecast = buildPoolForecast(
      [
        account('a', { atMs: NOW, remaining: 64, resetAtMs: NOW + 96 * HOUR, periodHours: 168 }),
        account('b', null),
      ],
      options()
    );
    expect(forecast.total).toBeNull();
    expect(forecast.loaded).toBe(1);
    expect(forecast.projection).toBeNull();
  });
});

describe('projection', () => {
  test('empties the pool between events and resets each account to 100', () => {
    // 10% left, burning 1%/h since reset (90% in 90h): empty in 10h, reset in 78h.
    const forecast = buildPoolForecast(
      [
        account('a', {
          atMs: NOW,
          remaining: 10,
          resetAtMs: NOW + 78 * HOUR,
          periodHours: WEEK_HOURS,
        }),
      ],
      options()
    );
    const projection = forecast.projection;
    expect(projection?.firstEmpty?.atMs).toBe(NOW + 10 * HOUR);
    expect(projection?.poolEmptyAtMs).toBe(NOW + 10 * HOUR);
    expect(projection?.jumps[0]).toEqual({ atMs: NOW + 78 * HOUR, gain: 100 });
  });

  test('catches an account that runs dry a minute before its reset', () => {
    const forecast = buildPoolForecast(
      [
        account('a', {
          atMs: NOW,
          remaining: 1,
          // 99% used over 99 hours → 1%/h, so empty in 1h, reset in 61 minutes.
          resetAtMs: NOW + 61 * MINUTE,
          periodHours: 99 + 61 / 60,
        }),
      ],
      options()
    );
    expect(forecast.projection?.poolEmptyAtMs).toBeCloseTo(NOW + HOUR, -1);
    expect(forecast.projection?.jumps[0]).toEqual({ atMs: NOW + 61 * MINUTE, gain: 100 });
  });

  test('moves demand from an empty account to the ones still serving', () => {
    const reading = (remaining: number) => ({
      atMs: NOW,
      remaining,
      resetAtMs: NOW + 200 * HOUR,
      periodHours: 400,
    });
    // Both opened 200h ago. a used 98% (0.49%/h), b used 10% (0.05%/h): demand 0.54%/h.
    const forecast = buildPoolForecast(
      [account('a', reading(2)), account('b', reading(90))],
      options({ horizonMs: NOW + 400 * HOUR })
    );
    const projection = forecast.projection;
    expect(projection?.firstEmpty?.key).toBe('a');
    // a empties after 2 / 0.49 hours; b then carries the whole 0.54%/h.
    const aEmptyMs = NOW + (2 / 0.49) * HOUR;
    expect(projection?.firstEmpty?.atMs).toBeCloseTo(aEmptyMs, -1);
    const bLeft = 90 - 0.05 * (2 / 0.49);
    expect(projection?.poolEmptyAtMs).toBeCloseTo(aEmptyMs + (bLeft / 0.54) * HOUR, -1);
  });

  test('reports the gain at a reset as what the account had used', () => {
    const forecast = buildPoolForecast(
      [account('a', { atMs: NOW, remaining: 64, resetAtMs: NOW + 96 * HOUR, periodHours: 168 })],
      options({ futureFactor: 0 })
    );
    expect(forecast.projection?.jumps[0]).toEqual({ atMs: NOW + 96 * HOUR, gain: 36 });
    expect(forecast.projection?.poolEmptyAtMs).toBeNull();
  });
});
