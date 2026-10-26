import {
  POOL_BURN_WINDOWS,
  POOL_FUTURE_USAGE,
  POOL_METRICS,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  QUOTA_VIEW_MODES,
  type PoolBurnWindow,
  type PoolFutureUsage,
  type PoolMetric,
  type QuotaSortMode,
  type QuotaTabId,
  type QuotaViewMode,
} from './constants';

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
  view?: QuotaViewMode;
  poolMetric?: PoolMetric;
  poolBurnWindow?: PoolBurnWindow;
  poolFutureUsage?: PoolFutureUsage;
  /** Credential cache keys left out of the pool totals. */
  poolExcluded?: string[];
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);
const QUOTA_VIEW_MODE_SET = new Set<string>(QUOTA_VIEW_MODES);
const POOL_METRIC_SET = new Set<string>(POOL_METRICS);
const POOL_BURN_WINDOW_SET = new Set<number>(POOL_BURN_WINDOWS);
const POOL_FUTURE_USAGE_SET = new Set<string>(Object.keys(POOL_FUTURE_USAGE));

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const isQuotaViewMode = (value: unknown): value is QuotaViewMode =>
  typeof value === 'string' && QUOTA_VIEW_MODE_SET.has(value);

export const isPoolMetric = (value: unknown): value is PoolMetric =>
  typeof value === 'string' && POOL_METRIC_SET.has(value);

export const isPoolBurnWindow = (value: unknown): value is PoolBurnWindow =>
  typeof value === 'number' && POOL_BURN_WINDOW_SET.has(value);

export const isPoolFutureUsage = (value: unknown): value is PoolFutureUsage =>
  typeof value === 'string' && POOL_FUTURE_USAGE_SET.has(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const state = parsed as Record<string, unknown>;
    return {
      tab: isQuotaTabId(state.tab) ? state.tab : undefined,
      sortMode: isQuotaSortMode(state.sortMode) ? state.sortMode : undefined,
      view: isQuotaViewMode(state.view) ? state.view : undefined,
      poolMetric: isPoolMetric(state.poolMetric) ? state.poolMetric : undefined,
      poolBurnWindow: isPoolBurnWindow(state.poolBurnWindow) ? state.poolBurnWindow : undefined,
      poolFutureUsage: isPoolFutureUsage(state.poolFutureUsage) ? state.poolFutureUsage : undefined,
      poolExcluded: isStringList(state.poolExcluded) ? state.poolExcluded : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};
