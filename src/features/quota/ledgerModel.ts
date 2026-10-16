/**
 * Ledger view model: every credential's limits as comparable meters, plus the
 * per-provider totals shown in the summary strip.
 *
 * The cards render each provider's state in its own shape. The ledger needs
 * the opposite — one row format for every provider and limits that line up
 * across credentials — so each state is read once here into `LedgerMeter`s.
 *
 * Pure and React-free: `t` and `nowMs` are injected, so totals and ordering
 * are directly testable.
 */

import type { TFunction } from 'i18next';
import { parseIsoToMs, resolvePlanTier, resolveResetMs } from '@/utils/quota';
import type { QuotaProviderType } from './providers/types';
import { codexPlanLabel } from './providers/codex/data';
import {
  antigravityPlanLabel,
  resolveAntigravityBucketLabelKey,
  resolveAntigravityGroupLabelKey,
} from './providers/antigravity/labels';

/** One limit on one credential. */
export interface LedgerMeter {
  /** Stable across the credentials of a provider, so totals can line up. */
  id: string;
  label: string;
  /** Remaining percent, 0..100; null when the provider reported no figure. */
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

/** A limit summed across one provider's credentials. */
export interface LedgerLimitTotal {
  id: string;
  label: string;
  /** Sum of the known remaining percents; null when no credential reported one. */
  total: number | null;
  /** Credentials × 100: the total when every credential is untouched. */
  capacity: number;
  /** Remaining percent per credential, in row order; null where unknown. */
  segments: (number | null)[];
  /** Soonest upcoming reset across credentials. */
  nextResetMs: number | null;
}

export interface LedgerProviderSummary {
  provider: QuotaProviderType;
  credentialCount: number;
  /** Long limits, most constrained first. The first one is the headline. */
  limits: LedgerLimitTotal[];
}

/** Windows at least this long are summarized; shorter ones only appear in rows. */
const SUMMARY_MIN_PERIOD_HOURS = 24;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const remainingFromUsed = (used: number | null | undefined): number | null =>
  typeof used === 'number' && Number.isFinite(used) ? clampPercent(100 - used) : null;

const usableMs = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

interface WindowLike {
  id: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const windowLabel = (window: WindowLike, t: TFunction): string =>
  window.labelKey ? String(t(window.labelKey, window.labelParams)) : (window.label ?? window.id);

/**
 * Read one credential's quota state into meters, in the provider's own order.
 * Anything but a successful read yields no meters.
 */
export function buildLedgerMeters(
  provider: QuotaProviderType,
  quota: unknown,
  t: TFunction
): LedgerMeter[] {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return [];

  if (provider === 'claude' || provider === 'codex') {
    return ((quota as { windows?: WindowLike[] }).windows ?? []).map((window) => ({
      id: window.id,
      label: windowLabel(window, t),
      remaining: remainingFromUsed(window.usedPercent),
      resetAtMs: usableMs(window.resetAtMs),
      periodHours: usableMs(window.periodHours),
    }));
  }

  if (provider === 'devin') {
    const windows =
      (
        quota as {
          windows?: {
            id: string;
            remainingPercent: number | null;
            resetAtMs: number | null;
            periodHours: number;
          }[];
        }
      ).windows ?? [];
    return windows.map((window) => ({
      id: window.id,
      label: String(t(`devin_quota.${window.id}`)),
      remaining: window.remainingPercent === null ? null : clampPercent(window.remainingPercent),
      resetAtMs: usableMs(window.resetAtMs),
      periodHours: usableMs(window.periodHours),
    }));
  }

  if (provider === 'kimi') {
    const rows =
      (
        quota as {
          rows?: (Omit<WindowLike, 'usedPercent'> & { used: number; limit: number })[];
        }
      ).rows ?? [];
    return rows.map((row) => ({
      id: row.id,
      label: windowLabel(row, t),
      remaining: row.limit > 0 ? clampPercent(((row.limit - row.used) / row.limit) * 100) : null,
      resetAtMs: usableMs(row.resetAtMs),
      periodHours: usableMs(row.periodHours),
    }));
  }

  if (provider === 'xai') {
    const billing = (
      quota as {
        billing?: {
          mode?: string;
          periodType?: string;
          usagePercent?: number | null;
          usedPercent?: number | null;
          resetAtMs?: number | null;
          periodHours?: number | null;
          billingPeriodEnd?: string;
        } | null;
      }
    ).billing;
    if (!billing || billing.mode === 'paid-health') return [];
    if (billing.periodType === 'weekly') {
      return [
        {
          id: 'weekly',
          label: String(t('xai_quota.weekly_limit')),
          remaining: remainingFromUsed(billing.usagePercent),
          resetAtMs: usableMs(billing.resetAtMs),
          periodHours: usableMs(billing.periodHours) ?? 24 * 7,
        },
      ];
    }
    return [
      {
        id: 'monthly',
        label: String(t('xai_quota.monthly_credits')),
        remaining: remainingFromUsed(billing.usedPercent),
        resetAtMs: parseIsoToMs(billing.billingPeriodEnd),
        periodHours: usableMs(billing.periodHours) ?? 24 * 30,
      },
    ];
  }

  if (provider === 'antigravity' || provider === 'plugin') {
    const groups =
      (
        quota as {
          groups?: {
            label: string;
            buckets?: {
              id: string;
              label: string;
              window?: string;
              remainingFraction?: number | null;
              resetAtMs?: number | null;
              periodHours?: number | null;
            }[];
          }[];
        }
      ).groups ?? [];
    const translate = (value: string, key: string | null) =>
      key ? String(t(`antigravity_quota.${key}`)) : value;
    return groups.flatMap((group) =>
      (group.buckets ?? []).map((bucket) => {
        const bucketLabel = translate(
          bucket.label,
          resolveAntigravityBucketLabelKey(bucket.label, bucket.window)
        );
        // Several groups share bucket names ("Weekly limit"), so the group leads.
        const groupLabel = translate(group.label, resolveAntigravityGroupLabelKey(group.label));
        return {
          id: bucket.id,
          label: groups.length > 1 ? `${groupLabel} · ${bucketLabel}` : bucketLabel,
          // Antigravity reports the fraction REMAINING, not percent used.
          remaining:
            typeof bucket.remainingFraction === 'number'
              ? clampPercent(bucket.remainingFraction * 100)
              : null,
          resetAtMs: usableMs(bucket.resetAtMs),
          periodHours: usableMs(bucket.periodHours),
        };
      })
    );
  }

  if (provider === 'meta') {
    const windows =
      (
        quota as {
          data?: {
            windows?: {
              id: 'window' | 'weekly';
              usedPercent: number | null;
              resetAt?: number;
              durationMinutes?: number;
            }[];
          };
        }
      ).data?.windows ?? [];
    return windows.map((window) => {
      const minutes = window.id === 'weekly' ? 7 * 24 * 60 : window.durationMinutes;
      return {
        id: window.id,
        label: String(t(`meta_quota.${window.id}`)),
        remaining: remainingFromUsed(window.usedPercent),
        resetAtMs: typeof window.resetAt === 'number' ? window.resetAt * 1000 : null,
        periodHours: typeof minutes === 'number' ? minutes / 60 : null,
      };
    });
  }

  return [];
}

/** The line under a credential's filename. */
export interface LedgerIdentity {
  /** Plan name; null when the provider reports none (the row then shows the provider). */
  plan: string | null;
  /** Paid top tiers read brighter, matching the gold/platinum chips on the cards. */
  premium: boolean;
  /** Codex subscription renewal; the instant may be in the past. */
  renewsAtMs: number | null;
}

export function ledgerIdentity(
  provider: QuotaProviderType,
  quota: unknown,
  t: TFunction
): LedgerIdentity {
  const none: LedgerIdentity = { plan: null, premium: false, renewsAtMs: null };
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return none;

  if (provider === 'claude') {
    const planType = (quota as { planType?: string | null }).planType;
    return { ...none, plan: planType ? String(t(`claude_quota.${planType}`)) : null };
  }
  if (provider === 'codex') {
    const codex = quota as {
      planType?: string | null;
      subscriptionActiveUntil?: string | number | null;
    };
    return {
      plan: codexPlanLabel(codex.planType, t),
      premium: resolvePlanTier(codex.planType) !== 'plain',
      renewsAtMs: resolveResetMs([codex.subscriptionActiveUntil]),
    };
  }
  if (provider === 'xai') {
    const billing = (quota as { billing?: { planLabel?: string; planTier?: string } | null })
      .billing;
    return {
      ...none,
      plan: billing?.planLabel ?? null,
      premium: billing?.planTier === 'elite' || billing?.planTier === 'premium',
    };
  }
  if (provider === 'antigravity') {
    return {
      ...none,
      plan: antigravityPlanLabel(
        (quota as { subscription?: Parameters<typeof antigravityPlanLabel>[0] }).subscription,
        t
      ),
    };
  }
  if (provider === 'devin')
    return { ...none, plan: (quota as { plan?: string | null }).plan ?? null };
  if (provider === 'meta') {
    return { ...none, plan: (quota as { data?: { planName?: string } }).data?.planName ?? null };
  }
  return none;
}

/**
 * A non-meter figure shown after a row's limits: Codex manual resets
 * ("2 available · Reset 1 in 22 days") or xAI monthly credits ("$0.00 / $5.00").
 */
export interface LedgerDetail {
  id: string;
  label: string;
  value: string;
  suffix: string;
  /** Lead-in for the countdown line, e.g. "Reset 1"; null when there is none. */
  note: string | null;
  noteAtMs: number | null;
}

const formatUsdFromCents = (cents: number | null | undefined): string | null =>
  typeof cents === 'number' && Number.isFinite(cents)
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100)
    : null;

export function buildLedgerDetails(
  provider: QuotaProviderType,
  quota: unknown,
  t: TFunction
): LedgerDetail[] {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return [];

  if (provider === 'codex') {
    const codex = quota as {
      rateLimitResetCreditsAvailableCount?: number | null;
      rateLimitResetCredits?: { status?: string; expiresAt?: string }[];
    };
    const available = codex.rateLimitResetCreditsAvailableCount;
    if (typeof available !== 'number') return [];
    // Numbered like the card's expiry list, so "Reset 1" means the same credit in both views.
    const credits = codex.rateLimitResetCredits ?? [];
    const firstIndex = credits.findIndex((credit) => parseIsoToMs(credit.expiresAt) !== null);
    return [
      {
        id: 'reset-credits',
        label: String(t('codex_quota.reset_credits_label')),
        value: String(available),
        suffix: String(t('quota_management.ledger_available')),
        note:
          firstIndex === -1
            ? null
            : String(t('codex_quota.reset_credit_number', { index: firstIndex + 1 })),
        noteAtMs: firstIndex === -1 ? null : parseIsoToMs(credits[firstIndex].expiresAt),
      },
    ];
  }

  if (provider === 'xai') {
    const billing = (
      quota as {
        billing?: {
          mode?: string;
          monthlyLimitCents?: number | null;
          includedUsedCents?: number | null;
          usedCents?: number | null;
          onDemandCapCents?: number | null;
          billingPeriodEnd?: string;
        } | null;
      }
    ).billing;
    if (!billing || billing.mode === 'paid-health') return [];
    const limit = billing.monthlyLimitCents ?? null;
    const used = billing.includedUsedCents ?? billing.usedCents ?? null;
    if (limit === null && used === null) return [];
    const remaining = limit !== null && used !== null ? Math.max(0, limit - used) : null;
    const cap = billing.onDemandCapCents ?? 0;
    const payAsYouGo =
      cap > 0
        ? t('xai_quota.pay_as_you_go_enabled', { cap: formatUsdFromCents(cap) })
        : t('xai_quota.pay_as_you_go_disabled');
    return [
      {
        id: 'monthly-credits',
        label: String(t('xai_quota.monthly_credits')),
        value: formatUsdFromCents(remaining) ?? '--',
        suffix: limit === null ? '' : `/ ${formatUsdFromCents(limit)}`,
        note: `${t('xai_quota.pay_as_you_go_label')}: ${payAsYouGo}`,
        noteAtMs: parseIsoToMs(billing.billingPeriodEnd),
      },
    ];
  }

  return [];
}

/**
 * Sum one provider's long limits across its credentials.
 *
 * `meterLists` holds one entry per credential in row order; a credential that
 * has not loaded contributes an empty list and therefore an empty segment.
 * The most constrained limit leads, since it decides how much work is left.
 */
export function summarizeLedgerProvider(
  provider: QuotaProviderType,
  meterLists: readonly LedgerMeter[][],
  nowMs: number
): LedgerProviderSummary {
  const labels = new Map<string, string>();
  const longIds = new Set<string>();
  for (const meters of meterLists) {
    for (const meter of meters) {
      if (!labels.has(meter.id)) labels.set(meter.id, meter.label);
      if ((meter.periodHours ?? 0) >= SUMMARY_MIN_PERIOD_HOURS) longIds.add(meter.id);
    }
  }

  const limits = [...longIds].map((id): LedgerLimitTotal => {
    const found = meterLists.map((meters) => meters.find((meter) => meter.id === id));
    const segments = found.map((meter) => meter?.remaining ?? null);
    const known = segments.filter((value): value is number => value !== null);
    const upcoming = found
      .map((meter) => meter?.resetAtMs ?? null)
      .filter((ms): ms is number => ms !== null && ms > nowMs);
    return {
      id,
      label: labels.get(id) ?? id,
      total: known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null,
      capacity: meterLists.length * 100,
      segments,
      nextResetMs: upcoming.length > 0 ? Math.min(...upcoming) : null,
    };
  });

  // Stable: equal totals keep first-appearance order; unknown totals go last.
  limits.sort((a, b) => {
    if (a.total === null || b.total === null)
      return (a.total === null ? 1 : 0) - (b.total === null ? 1 : 0);
    return a.total - b.total;
  });

  return { provider, credentialCount: meterLists.length, limits };
}

/** A column in a provider group: one limit id, dimmed when it is a secondary total. */
export interface LedgerColumn {
  id: string;
  dimmed: boolean;
}

/**
 * Column order for a provider group, shared by every row so limits line up:
 * the headline limit, then the short windows, then the remaining long limits.
 * The trailing long limits are dimmed — the headline already covers them.
 */
export function ledgerColumns(
  summary: LedgerProviderSummary,
  meterLists: readonly LedgerMeter[][]
): LedgerColumn[] {
  const [headline, ...secondary] = summary.limits.map((limit) => limit.id);
  const summarized = new Set(summary.limits.map((limit) => limit.id));
  const short: string[] = [];
  for (const meters of meterLists) {
    for (const meter of meters) {
      if (!summarized.has(meter.id) && !short.includes(meter.id)) short.push(meter.id);
    }
  }
  return [
    ...(headline ? [{ id: headline, dimmed: false }] : []),
    ...short.map((id) => ({ id, dimmed: false })),
    ...secondary.map((id) => ({ id, dimmed: true })),
  ];
}

// The mailbox excludes `-` so a `claude-` style filename prefix is not swallowed.
const EMAIL_PATTERN =
  /([A-Za-z0-9._%+])[A-Za-z0-9._%+]*@([A-Za-z0-9])[A-Za-z0-9-]*((?:\.[A-Za-z0-9-]+)+)/g;

/**
 * Hide the identifying part of any email inside a credential name:
 * `claude-tom@acme.dev.json` → `claude-t•••@a•••.dev.json`.
 * The first character of the mailbox and domain stay as a hint; the TLD and
 * file suffix stay so files remain distinguishable by type.
 */
export function maskEmails(value: string): string {
  return value.replace(
    EMAIL_PATTERN,
    (_match, local: string, domain: string, rest: string) => `${local}•••@${domain}•••${rest}`
  );
}
