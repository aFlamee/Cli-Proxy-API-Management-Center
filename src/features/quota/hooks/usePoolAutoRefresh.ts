/**
 * Keeps the pool view current without clicks: credentials that have never
 * loaded load when the view opens, and every credential refreshes on an
 * interval while the page is visible. Each refresh also adds a history point.
 */

import { useEffect, useRef } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { POOL_REFRESH_INTERVAL_MS } from '../constants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';

export function usePoolAutoRefresh({
  enabled,
  entries,
  quotaFor,
  loadQuota,
}: {
  enabled: boolean;
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  loadQuota: (targets: QuotaFileEntry[]) => Promise<void>;
}) {
  const latest = useRef({ entries, quotaFor, loadQuota });
  useEffect(() => {
    latest.current = { entries, quotaFor, loadQuota };
  });
  const lastRefreshRef = useRef(0);

  const refreshAll = () => {
    const targets = latest.current.entries.filter((entry) => !entry.file.disabled);
    if (targets.length === 0) return;
    lastRefreshRef.current = Date.now();
    void latest.current.loadQuota(targets);
  };

  // Keyed on identities, not on quota state, so a landing result never re-triggers a load.
  const entryKeys = entries
    .map((entry) => `${entry.type}:${getQuotaCacheKey(entry.file)}`)
    .join('|');
  useEffect(() => {
    if (!enabled) return;
    const unloaded = latest.current.entries.filter((entry) => {
      const status = latest.current.quotaFor(entry)?.status;
      return !entry.file.disabled && (status === undefined || status === 'idle');
    });
    if (unloaded.length === 0) return;
    lastRefreshRef.current = Date.now();
    void latest.current.loadQuota(unloaded);
  }, [enabled, entryKeys]);

  useInterval(
    () => {
      if (document.visibilityState === 'visible') refreshAll();
    },
    enabled ? POOL_REFRESH_INTERVAL_MS : null
  );

  // Back from a closed laptop or another tab: catch up at once instead of on the next tick.
  useEffect(() => {
    if (!enabled) return;
    const handleVisibility = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastRefreshRef.current >= POOL_REFRESH_INTERVAL_MS
      ) {
        refreshAll();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [enabled]);
}
