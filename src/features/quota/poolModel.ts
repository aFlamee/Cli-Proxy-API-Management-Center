/**
 * Pool view model: one provider's accounts summed into a single pool, its
 * recorded history and a forecast.
 *
 * Recorded points are real observations only. Two observations are joined
 * when they are close and in the same window; anything else stays blank.
 * The forecast runs from event to event (a reset or an account running dry)
 * instead of on a grid, so an account that empties a minute before its reset
 * is not stepped over.
 *
 * Pure and React-free: the clock and every option are passed in.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { LedgerMeter } from './ledgerModel';
import type { QuotaProviderType } from './providers/types';

/** One stored reading of an account's pool limit. */
export interface PoolObservation {
  atMs: number;
  /** Remaining percent, 0..100. */
  remaining: number;
  resetAtMs: number | null;
}

export interface PoolReading extends PoolObservation {
  periodHours: number | null;
}

export interface PoolAccount {
  key: string;
  name: string;
  /** Latest usable reading; null while the account has not loaded or failed. */
  reading: PoolReading | null;
  /** Earlier observations of the same limit, in any order. */
  history: readonly PoolObservation[];
}

export interface PoolPoint {
  atMs: number;
  value: number;
}

/** Capacity coming back at one instant, in pool percent. */
export interface PoolJump {
  atMs: number;
  gain: number;
}

export interface PoolBurn {
  /** Pool percent per hour. */
  perHour: number;
  /** `recent` is measured over the burn window. `since-reset` averages the window so far. */
  source: 'recent' | 'since-reset';
}

export interface PoolProjection {
  points: PoolPoint[];
  /** Pool percent per hour, as a step line. */
  drain: PoolPoint[];
  jumps: PoolJump[];
  poolEmptyAtMs: number | null;
  firstEmpty: { key: string; name: string; atMs: number } | null;
}

export interface PoolForecast {
  capacity: number;
  /** Included accounts with a usable reading. */
  loaded: number;
  included: number;
  /** Current pool total; null until every included account has a reading. */
  total: number | null;
  /** Observed pool totals, one array per unbroken stretch. */
  recorded: PoolPoint[][];
  /** Observed drain over the burn window, one array per unbroken stretch. */
  recordedDrain: PoolPoint[][];
  burn: PoolBurn | null;
  /** Null until every included account has a reading and a burn estimate. */
  projection: PoolProjection | null;
}

export interface PoolOptions {
  nowMs: number;
  burnWindowHours: number;
  /** Multiplier on today's burn for the forecast: 1 = same as now, 0 = idle. */
  futureFactor: number;
  /** Recorded points before this are dropped. */
  startMs: number;
  /** The forecast runs at least this far. */
  horizonMs: number;
}

/** How far the pool-empty forecast looks ahead. */
export const POOL_FORECAST_MS = 14 * DAY_MS;

/** Observations further apart than this are not joined into one line. */
const MAX_LINK_GAP_MS = 2 * HOUR_MS;
/** An observation stands for its neighbourhood, so batches read seconds apart still line up. */
const SNAP_MS = 5 * MINUTE_MS;
/** Providers recompute reset instants per request, so equal windows differ by seconds. */
const SAME_WINDOW_TOLERANCE_MS = 10 * MINUTE_MS;
const LONG_PERIOD_HOURS = 24;
/** Windows longer than this follow the calendar, so only their next reset is forecast. */
const MAX_REPEATING_PERIOD_HOURS = 27 * 24;
const MAX_FORECAST_EVENTS = 2_000;

/**
 * The general limit each provider's pool measures, best first. Model-scoped or
 * code-review limits would make the pool jump between meanings after a refresh.
 */
const POOL_LIMIT_PREFERENCE: Partial<Record<QuotaProviderType, readonly string[]>> = {
  claude: ['seven-day'],
  codex: ['weekly', 'monthly'],
  xai: ['weekly', 'monthly'],
  meta: ['weekly'],
};

/** Limit ids worth recording for one account: its preferred ones, else its first long one. */
export function poolLimitCandidates(
  provider: QuotaProviderType,
  meters: readonly LedgerMeter[]
): string[] {
  const preferred = POOL_LIMIT_PREFERENCE[provider];
  if (preferred) return preferred.filter((id) => meters.some((meter) => meter.id === id));
  const first = meters.find((meter) => (meter.periodHours ?? 0) >= LONG_PERIOD_HOURS);
  return first ? [first.id] : [];
}

/** The one limit a provider's pool measures: the best candidate any account reports. */
export function selectPoolLimitId(
  provider: QuotaProviderType,
  meterLists: readonly (readonly LedgerMeter[])[]
): string | null {
  const preferred = POOL_LIMIT_PREFERENCE[provider];
  if (preferred) {
    return (
      preferred.find((id) => meterLists.some((meters) => meters.some((m) => m.id === id))) ?? null
    );
  }
  for (const meters of meterLists) {
    const [id] = poolLimitCandidates(provider, meters);
    if (id) return id;
  }
  return null;
}

const sameWindow = (a: PoolObservation, b: PoolObservation) =>
  a.resetAtMs === null || b.resetAtMs === null
    ? a.resetAtMs === b.resetAtMs
    : Math.abs(a.resetAtMs - b.resetAtMs) <= SAME_WINDOW_TOLERANCE_MS;

const linked = (a: PoolObservation, b: PoolObservation) =>
  b.atMs - a.atMs <= MAX_LINK_GAP_MS && sameWindow(a, b);

/** History plus the current reading, oldest first, one point per instant. */
function observationsOf(account: PoolAccount): PoolObservation[] {
  const byInstant = new Map<number, PoolObservation>();
  for (const observation of account.history) byInstant.set(observation.atMs, observation);
  if (account.reading) byInstant.set(account.reading.atMs, account.reading);
  return [...byInstant.values()].sort((a, b) => a.atMs - b.atMs);
}

/** Index of the last observation at or before `atMs`, or -1. */
function lastIndexAtOrBefore(observations: readonly PoolObservation[], atMs: number): number {
  let low = 0;
  let high = observations.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (observations[mid].atMs <= atMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

interface WatchedSeries {
  observations: PoolObservation[];
  /** Per observation, the index where its run of joined observations starts. */
  runStarts: number[];
}

function watchedSeries(observations: PoolObservation[]): WatchedSeries {
  const runStarts: number[] = [];
  observations.forEach((observation, index) => {
    const previous = observations[index - 1];
    runStarts.push(previous && linked(previous, observation) ? runStarts[index - 1] : index);
  });
  return { observations, runStarts };
}

/**
 * Observed remaining at `atMs` and the run it belongs to, or null where the
 * account was not watched. Two points of a pool line join only within one run.
 */
function observedValueAt(
  series: WatchedSeries,
  atMs: number
): { value: number; run: number } | null {
  const { observations, runStarts } = series;
  const index = lastIndexAtOrBefore(observations, atMs);
  const before = index >= 0 ? observations[index] : undefined;
  const after = observations[index + 1];
  if (before && after && linked(before, after)) {
    const span = after.atMs - before.atMs;
    const share = span === 0 ? 0 : (atMs - before.atMs) / span;
    return {
      value: before.remaining + (after.remaining - before.remaining) * share,
      run: runStarts[index],
    };
  }
  if (before && atMs - before.atMs <= SNAP_MS) {
    return { value: before.remaining, run: runStarts[index] };
  }
  if (after && after.atMs - atMs <= SNAP_MS) {
    return { value: after.remaining, run: runStarts[index + 1] };
  }
  return null;
}

/**
 * Percent per hour used inside `[endMs - windowMs, endMs]`, from joined
 * observations only. Null when less than half the window was watched.
 * Rises across a pair (a reset or a reset credit) count as zero use.
 */
function observedBurn(
  observations: readonly PoolObservation[],
  endMs: number,
  windowMs: number
): number | null {
  const startMs = endMs - windowMs;
  let used = 0;
  let watchedMs = 0;
  const first = Math.max(0, lastIndexAtOrBefore(observations, startMs));
  for (let index = first; index < observations.length - 1; index += 1) {
    const before = observations[index];
    const after = observations[index + 1];
    if (before.atMs >= endMs) break;
    if (!linked(before, after)) continue;
    const from = Math.max(before.atMs, startMs);
    const to = Math.min(after.atMs, endMs);
    if (to <= from) continue;
    const span = after.atMs - before.atMs;
    used += Math.max(0, before.remaining - after.remaining) * ((to - from) / span);
    watchedMs += to - from;
  }
  if (watchedMs < windowMs / 2) return null;
  return used / (watchedMs / HOUR_MS);
}

/** Average use since the window opened: a calculation, not a measurement. */
function sinceResetBurn(reading: PoolReading): number | null {
  if (reading.resetAtMs === null || reading.periodHours === null) return null;
  const openedAtMs = reading.resetAtMs - reading.periodHours * HOUR_MS;
  const elapsedHours = (reading.atMs - openedAtMs) / HOUR_MS;
  if (elapsedHours <= 0) return null;
  return Math.max(0, 100 - reading.remaining) / elapsedHours;
}

function collectRecorded(
  series: readonly WatchedSeries[],
  options: PoolOptions
): { recorded: PoolPoint[][]; recordedDrain: PoolPoint[][] } {
  const windowMs = options.burnWindowHours * HOUR_MS;
  const instants = [
    ...new Set(series.flatMap((item) => item.observations.map((point) => point.atMs))),
  ]
    // One linkable step before the range keeps the line running into its left edge.
    .filter((atMs) => atMs >= options.startMs - MAX_LINK_GAP_MS && atMs <= options.nowMs)
    .sort((a, b) => a - b);

  const recorded: PoolPoint[][] = [];
  const recordedDrain: PoolPoint[][] = [];
  let line: PoolPoint[] = [];
  let drainLine: PoolPoint[] = [];
  let lastAtMs = -Infinity;
  let lastRuns: number[] | null = null;
  const flush = () => {
    if (line.length > 0) recorded.push(line);
    if (drainLine.length > 0) recordedDrain.push(drainLine);
    line = [];
    drainLine = [];
    lastRuns = null;
  };

  for (const atMs of instants) {
    // A batch reads its accounts seconds apart: keep one point per batch.
    if (atMs - lastAtMs < MINUTE_MS) continue;
    lastAtMs = atMs;

    const values = series.map((item) => observedValueAt(item, atMs));
    if (values.some((value) => value === null)) {
      flush();
      continue;
    }
    const runs = values.map((value) => value?.run ?? -1);
    const previousRuns: number[] | null = lastRuns;
    if (previousRuns && runs.some((run, index) => run !== previousRuns[index])) flush();
    lastRuns = runs;
    line.push({
      atMs,
      value: values.reduce<number>((sum, value) => sum + (value?.value ?? 0), 0),
    });

    const drains = series.map((item) => observedBurn(item.observations, atMs, windowMs));
    if (drains.some((value) => value === null)) {
      if (drainLine.length > 0) recordedDrain.push(drainLine);
      drainLine = [];
    } else {
      drainLine.push({
        atMs,
        value: drains.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      });
    }
  }
  flush();
  return { recorded, recordedDrain };
}

interface SimAccount {
  key: string;
  name: string;
  remaining: number;
  /** Share of the pool's demand, from this account's own burn. */
  weight: number;
  nextResetMs: number;
  periodMs: number | null;
}

/** First reset after `nowMs`, rolling a stale one forward by whole periods. */
function nextResetAfter(resetAtMs: number | null, periodMs: number | null, nowMs: number) {
  if (resetAtMs === null) return Infinity;
  if (resetAtMs > nowMs) return resetAtMs;
  if (periodMs === null) return Infinity;
  return resetAtMs + Math.ceil((nowMs - resetAtMs) / periodMs) * periodMs;
}

const poolTotal = (accounts: readonly SimAccount[]) =>
  accounts.reduce((sum, account) => sum + account.remaining, 0);

/**
 * Forecast the pool event by event. The hub routes around an exhausted
 * account, so its share of the demand moves to the accounts still serving.
 */
function project(
  readings: readonly { account: PoolAccount; reading: PoolReading; burn: number }[],
  options: PoolOptions
): PoolProjection {
  const { nowMs } = options;
  const endMs = Math.max(options.horizonMs, nowMs + POOL_FORECAST_MS);
  const demand = readings.reduce((sum, item) => sum + item.burn, 0) * options.futureFactor;

  const accounts: SimAccount[] = readings.map(({ account, reading, burn }) => {
    const periodMs =
      reading.periodHours !== null && reading.periodHours <= MAX_REPEATING_PERIOD_HOURS
        ? reading.periodHours * HOUR_MS
        : null;
    const resetPassed = reading.resetAtMs !== null && reading.resetAtMs <= nowMs;
    return {
      key: account.key,
      name: account.name,
      remaining: resetPassed ? 100 : reading.remaining,
      weight: burn,
      nextResetMs: nextResetAfter(reading.resetAtMs, periodMs, nowMs),
      periodMs,
    };
  });

  const ratesFor = (): number[] => {
    const serving = accounts.filter((account) => account.remaining > 0);
    if (demand <= 0 || serving.length === 0) return accounts.map(() => 0);
    const weights = serving.reduce((sum, account) => sum + account.weight, 0);
    return accounts.map((account) => {
      if (account.remaining <= 0) return 0;
      return weights > 0 ? (demand * account.weight) / weights : demand / serving.length;
    });
  };

  const points: PoolPoint[] = [{ atMs: nowMs, value: poolTotal(accounts) }];
  const drain: PoolPoint[] = [];
  const jumps: PoolJump[] = [];
  let poolEmptyAtMs: number | null = poolTotal(accounts) <= 0 ? nowMs : null;
  const emptyNow = accounts.find((account) => account.remaining <= 0);
  let firstEmpty: PoolProjection['firstEmpty'] = emptyNow
    ? { key: emptyNow.key, name: emptyNow.name, atMs: nowMs }
    : null;
  let atMs = nowMs;

  for (let step = 0; step < MAX_FORECAST_EVENTS && atMs < endMs; step += 1) {
    const rates = ratesFor();
    const drainNow = rates.reduce((sum, rate) => sum + rate, 0);
    const emptiesAt = accounts.map((account, index) =>
      rates[index] > 0 ? atMs + (account.remaining / rates[index]) * HOUR_MS : Infinity
    );
    const nextMs = Math.min(endMs, ...emptiesAt, ...accounts.map((a) => a.nextResetMs));

    accounts.forEach((account, index) => {
      const used = rates[index] * ((nextMs - atMs) / HOUR_MS);
      account.remaining = emptiesAt[index] <= nextMs ? 0 : Math.max(0, account.remaining - used);
    });
    drain.push({ atMs, value: drainNow }, { atMs: nextMs, value: drainNow });
    points.push({ atMs: nextMs, value: poolTotal(accounts) });
    atMs = nextMs;

    accounts.forEach((account, index) => {
      if (emptiesAt[index] <= nextMs && firstEmpty === null) {
        firstEmpty = { key: account.key, name: account.name, atMs: nextMs };
      }
    });
    if (poolEmptyAtMs === null && poolTotal(accounts) <= 0) poolEmptyAtMs = nextMs;

    let gain = 0;
    for (const account of accounts) {
      if (account.nextResetMs > nextMs) continue;
      gain += 100 - account.remaining;
      account.remaining = 100;
      account.nextResetMs =
        account.periodMs === null ? Infinity : account.nextResetMs + account.periodMs;
    }
    if (gain > 0) {
      jumps.push({ atMs: nextMs, gain });
      points.push({ atMs: nextMs, value: poolTotal(accounts) });
    }
  }

  return { points, drain, jumps, poolEmptyAtMs, firstEmpty };
}

export function buildPoolForecast(
  accounts: readonly PoolAccount[],
  options: PoolOptions
): PoolForecast {
  const capacity = accounts.length * 100;
  const series = accounts.map((account) => watchedSeries(observationsOf(account)));
  const { recorded, recordedDrain } = collectRecorded(series, options);
  const readings = accounts.flatMap((account) =>
    account.reading ? [{ account, reading: account.reading }] : []
  );
  const complete = accounts.length > 0 && readings.length === accounts.length;

  const base = {
    capacity,
    loaded: readings.length,
    included: accounts.length,
    total: complete ? readings.reduce((sum, item) => sum + item.reading.remaining, 0) : null,
    recorded,
    recordedDrain,
  };
  if (!complete) return { ...base, burn: null, projection: null };

  const windowMs = options.burnWindowHours * HOUR_MS;
  const recent = series.map((item) => observedBurn(item.observations, options.nowMs, windowMs));
  const allRecent = recent.every((value) => value !== null);
  const burns = readings.map(({ reading }, index) =>
    allRecent ? recent[index] : sinceResetBurn(reading)
  );
  if (burns.some((value) => value === null)) return { ...base, burn: null, projection: null };

  const withBurn = readings.map((item, index) => ({ ...item, burn: burns[index] ?? 0 }));
  return {
    ...base,
    burn: {
      perHour: withBurn.reduce((sum, item) => sum + item.burn, 0),
      source: allRecent ? 'recent' : 'since-reset',
    },
    projection: project(withBurn, options),
  };
}
