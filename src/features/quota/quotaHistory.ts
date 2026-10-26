/**
 * Quota observations kept in the browser, so the pool view can draw what the
 * dashboard has seen. Points are written only when a fetch lands, never on a
 * remount or an enrichment pass, so every stored point is a real reading.
 *
 * One series per connection, provider, credential and limit, in localStorage.
 */

import { useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { normalizeApiBase } from '@/utils/connection';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';
import { buildLedgerMeters } from './ledgerModel';
import { poolLimitCandidates, type PoolReading } from './poolModel';
import type { QuotaProviderType } from './providers/types';

const STORAGE_PREFIX = 'quotaPool.history.v1:';
export const HISTORY_RETENTION_MS = 28 * DAY_MS;
/** An unchanged reading closer than this to the previous one adds nothing. */
const MIN_SPACING_MS = 5 * MINUTE_MS;
/** 28 days of readings every ten minutes, with headroom. */
const MAX_POINTS_PER_SERIES = 4_500;

type StoredPoint = [
  atMs: number,
  remaining: number,
  resetAtMs: number | null,
  periodHours: number | null,
];
export type QuotaHistory = Record<string, StoredPoint[]>;

export interface QuotaObservationInput {
  provider: QuotaProviderType;
  cacheKey: string;
  limitId: string;
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
}

export const historySeriesKey = (provider: QuotaProviderType, cacheKey: string, limitId: string) =>
  `${provider}\u0000${cacheKey}\u0000${limitId}`;

const isFiniteOrNull = (value: unknown) => value === null || Number.isFinite(value);

const isStoredPoint = (value: unknown): value is StoredPoint =>
  Array.isArray(value) &&
  value.length === 4 &&
  Number.isFinite(value[0]) &&
  Number.isFinite(value[1]) &&
  isFiniteOrNull(value[2]) &&
  isFiniteOrNull(value[3]);

export function parseQuotaHistory(raw: string | null): QuotaHistory {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const history: QuotaHistory = {};
    for (const [key, points] of Object.entries(parsed)) {
      if (Array.isArray(points)) history[key] = points.filter(isStoredPoint);
    }
    return history;
  } catch {
    return {};
  }
}

/** Add one fetch's readings and drop expired ones. Returns a new history. */
export function appendQuotaObservations(
  history: QuotaHistory,
  atMs: number,
  inputs: readonly QuotaObservationInput[]
): QuotaHistory {
  const cutoff = atMs - HISTORY_RETENTION_MS;
  const next: QuotaHistory = {};
  for (const [key, points] of Object.entries(history)) {
    const kept = points.filter((point) => point[0] >= cutoff);
    if (kept.length > 0) next[key] = kept;
  }
  for (const input of inputs) {
    const key = historySeriesKey(input.provider, input.cacheKey, input.limitId);
    const points = next[key] ?? [];
    const last = points[points.length - 1];
    if (last && last[0] >= atMs) continue;
    if (last && atMs - last[0] < MIN_SPACING_MS && last[1] === input.remaining) continue;
    points.push([atMs, input.remaining, input.resetAtMs, input.periodHours]);
    next[key] =
      points.length > MAX_POINTS_PER_SERIES ? points.slice(-MAX_POINTS_PER_SERIES) : points;
  }
  return next;
}

/** Every stored reading of one series, oldest first. */
export function historyFor(
  history: QuotaHistory,
  provider: QuotaProviderType,
  cacheKey: string,
  limitId: string
): PoolReading[] {
  return (history[historySeriesKey(provider, cacheKey, limitId)] ?? []).map(
    ([atMs, remaining, resetAtMs, periodHours]) => ({ atMs, remaining, resetAtMs, periodHours })
  );
}

const storageKey = (apiBase: string) => `${STORAGE_PREFIX}${normalizeApiBase(apiBase)}`;

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
let snapshot: { apiBase: string; version: number; history: QuotaHistory } | null = null;

/** The stored history of one connection, re-read whenever this tab records a fetch. */
export function useQuotaHistory(apiBase: string): QuotaHistory {
  const getSnapshot = () => {
    if (!snapshot || snapshot.apiBase !== apiBase || snapshot.version !== version) {
      snapshot = { apiBase, version, history: readQuotaHistory(apiBase) };
    }
    return snapshot.history;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function readQuotaHistory(apiBase: string): QuotaHistory {
  if (typeof window === 'undefined' || !apiBase) return {};
  try {
    return parseQuotaHistory(window.localStorage.getItem(storageKey(apiBase)));
  } catch {
    return {};
  }
}

/**
 * Record a quota fetch that just landed. Storage is read fresh before the
 * write, so points another tab added in the meantime survive.
 */
export function recordQuotaFetch(
  provider: QuotaProviderType,
  file: AuthFileItem,
  state: unknown,
  t: TFunction
) {
  const apiBase = useAuthStore.getState().apiBase;
  if (typeof window === 'undefined' || !apiBase) return;
  const meters = buildLedgerMeters(provider, state, t);
  const cacheKey = getQuotaCacheKey(file);
  const inputs = poolLimitCandidates(provider, meters).flatMap((limitId) => {
    const meter = meters.find((item) => item.id === limitId);
    return meter && meter.remaining !== null
      ? [
          {
            provider,
            cacheKey,
            limitId,
            remaining: meter.remaining,
            resetAtMs: meter.resetAtMs,
            periodHours: meter.periodHours,
          },
        ]
      : [];
  });
  if (inputs.length === 0) return;
  try {
    const key = storageKey(apiBase);
    const current = parseQuotaHistory(window.localStorage.getItem(key));
    window.localStorage.setItem(
      key,
      JSON.stringify(appendQuotaObservations(current, Date.now(), inputs))
    );
  } catch {
    // Full or blocked storage only costs history; the live reading still renders.
    return;
  }
  version += 1;
  listeners.forEach((listener) => listener());
}
