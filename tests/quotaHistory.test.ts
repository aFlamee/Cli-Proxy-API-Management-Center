import { describe, expect, test } from 'bun:test';
import {
  appendQuotaObservations,
  HISTORY_RETENTION_MS,
  historyFor,
  parseQuotaHistory,
  type QuotaObservationInput,
} from '@/features/quota/quotaHistory';

const NOW = Date.UTC(2026, 9, 26, 12, 0);
const MINUTE = 60_000;

const reading = (remaining: number, extra: Partial<QuotaObservationInput> = {}) => ({
  provider: 'claude' as const,
  cacheKey: 'claude-a.json',
  limitId: 'seven-day',
  remaining,
  resetAtMs: NOW + 1000 * MINUTE,
  periodHours: 168,
  ...extra,
});

describe('appendQuotaObservations', () => {
  test('keeps one series per credential and limit', () => {
    const history = appendQuotaObservations({}, NOW, [
      reading(80),
      reading(40, { cacheKey: 'claude-b.json' }),
    ]);
    expect(historyFor(history, 'claude', 'claude-a.json', 'seven-day')).toEqual([
      { atMs: NOW, remaining: 80, resetAtMs: NOW + 1000 * MINUTE, periodHours: 168 },
    ]);
    expect(historyFor(history, 'claude', 'claude-b.json', 'seven-day')).toHaveLength(1);
  });

  test('drops an unchanged reading taken right after the previous one', () => {
    let history = appendQuotaObservations({}, NOW, [reading(80)]);
    history = appendQuotaObservations(history, NOW + 2 * MINUTE, [reading(80)]);
    history = appendQuotaObservations(history, NOW + 3 * MINUTE, [reading(79)]);
    history = appendQuotaObservations(history, NOW + 20 * MINUTE, [reading(79)]);
    expect(historyFor(history, 'claude', 'claude-a.json', 'seven-day').map((p) => p.atMs)).toEqual([
      NOW,
      NOW + 3 * MINUTE,
      NOW + 20 * MINUTE,
    ]);
  });

  test('ignores a reading older than the last stored one', () => {
    let history = appendQuotaObservations({}, NOW, [reading(80)]);
    history = appendQuotaObservations(history, NOW - MINUTE, [reading(90)]);
    expect(historyFor(history, 'claude', 'claude-a.json', 'seven-day')).toHaveLength(1);
  });

  test('expires readings past the retention window', () => {
    let history = appendQuotaObservations({}, NOW, [reading(80)]);
    history = appendQuotaObservations(history, NOW + HISTORY_RETENTION_MS + MINUTE, [
      reading(60, { cacheKey: 'claude-b.json' }),
    ]);
    expect(historyFor(history, 'claude', 'claude-a.json', 'seven-day')).toEqual([]);
  });
});

describe('parseQuotaHistory', () => {
  test('keeps valid points and discards the rest', () => {
    const raw = JSON.stringify({
      good: [
        [NOW, 50, null, 168],
        [NOW, 'x', null, 168],
        [NOW, 50, null],
      ],
      bad: 'nope',
    });
    expect(parseQuotaHistory(raw)).toEqual({ good: [[NOW, 50, null, 168]] });
    expect(parseQuotaHistory('{oops')).toEqual({});
    expect(parseQuotaHistory('[1,2]')).toEqual({});
  });
});
