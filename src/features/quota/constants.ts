import type { QuotaProviderType } from './providers/types';

/** tab 顺序 = 旧页五分区的纵向顺序，'全部' tab 下卡片也按此分组排列。 */
export const QUOTA_TAB_ORDER: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
  'plugin',
];

export type QuotaTabId = 'all' | QuotaProviderType;

/** 页级分页固定 20/页，同时把「刷新全部」的上游并发限制在 20。 */
export const QUOTA_PAGE_SIZE = 20;

/** 卡片排序：默认 = provider 分组序；soonest = 最快恢复优先。 */
export const QUOTA_SORT_MODES = ['default', 'soonest'] as const;

export type QuotaSortMode = (typeof QUOTA_SORT_MODES)[number];

/**
 * Page layouts: ledger = summary strip + compact rows (default); cards = the card grid;
 * pool = each provider's accounts summed into one chart with a forecast.
 */
export const QUOTA_VIEW_MODES = ['ledger', 'cards', 'pool'] as const;

export type QuotaViewMode = (typeof QUOTA_VIEW_MODES)[number];

/** What the pool chart plots: pool percent left, or percent used per hour. */
export const POOL_METRICS = ['remaining', 'drain'] as const;

export type PoolMetric = (typeof POOL_METRICS)[number];

/** Hours of observations the burn rate is measured over. */
export const POOL_BURN_WINDOWS = [1, 3, 6] as const;

export type PoolBurnWindow = (typeof POOL_BURN_WINDOWS)[number];

/** Future usage presets and the multiplier each applies to today's burn. */
export const POOL_FUTURE_USAGE = {
  same: 1,
  half: 0.5,
  double: 2,
  idle: 0,
} as const;

export type PoolFutureUsage = keyof typeof POOL_FUTURE_USAGE;

/** The pool view refreshes every credential this often while it is on screen. */
export const POOL_REFRESH_INTERVAL_MS = 10 * 60_000;

/** Provider tabs shown even when empty; the others appear once they have credentials. */
export const QUOTA_PINNED_TABS: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
];

/** 与 useRevealGroup 的 GROUP_MAX_TOTAL 一致：卡片级联总预算 360ms。 */
export const CARD_ENTRANCE_BUDGET_MS = 360;
