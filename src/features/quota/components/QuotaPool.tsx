/**
 * Pool view of the quota page: each provider's accounts summed into one pool,
 * drawn with its recorded line and a forecast, under one toolbar.
 *
 * Rendering and wiring only. Pool totals, history joins and the forecast come
 * from poolModel.ts, stored observations from quotaHistory.ts.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { IconChevronLeft } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { TYPE_COLORS } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { MINUTE_MS } from '@/utils/time/durations';
import { getTypeLabel } from '@/features/authFiles/constants';
import {
  POOL_BURN_WINDOWS,
  POOL_FUTURE_USAGE,
  POOL_METRICS,
  QUOTA_TAB_ORDER,
  type PoolBurnWindow,
  type PoolFutureUsage,
  type PoolMetric,
} from '../constants';
import { buildLedgerMeters, maskEmails, type LedgerMeter } from '../ledgerModel';
import type { QuotaFileEntry } from '../logic';
import {
  buildPoolForecast,
  POOL_FORECAST_MS,
  selectPoolLimitId,
  type PoolAccount,
  type PoolForecast,
  type PoolPoint,
} from '../poolModel';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { historyFor, useQuotaHistory } from '../quotaHistory';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import { QuotaPoolChart, type PoolChartMark } from './QuotaPoolChart';
import { QuotaProviderIcon } from './QuotaProviderIcon';
import styles from './QuotaPool.module.scss';

export type QuotaPoolProps = {
  /** Every credential of the active tab, not just one page. */
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  showEmails: boolean;
};

/** The range shows this many days, starting a few days before today. */
const RANGE_DAYS = 14;
const RANGE_DAYS_BEFORE_TODAY = 3;
const RANGE_STEP_DAYS = 7;

interface PoolGroupAccount {
  entry: QuotaFileEntry;
  key: string;
  name: string;
  included: boolean;
  remaining: number | null;
}

interface PoolGroup {
  provider: QuotaProviderType;
  accounts: PoolGroupAccount[];
  forecast: PoolForecast;
}

/** Local midnight `days` after the one on or before `ms`; DST-safe through the Date API. */
const localMidnight = (ms: number, days = 0) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};

/** A note or the account email reads better than the filename where the UI is tight. */
const accountName = (file: AuthFileItem, showEmails: boolean) => {
  const note = typeof file.note === 'string' ? file.note.trim() : '';
  const name = note || file.email?.trim() || file.name;
  return showEmails ? name : maskEmails(name);
};

const poolAccent = (provider: QuotaProviderType, resolvedTheme: ResolvedTheme) => {
  const colors = TYPE_COLORS[provider] ?? TYPE_COLORS.unknown;
  return resolvedTheme === 'dark' && colors.dark ? colors.dark.text : colors.light.text;
};

const formatPercent = (value: number) => `${Math.round(value)}%`;

/** A round axis top for the drain chart, never below 1%/h. */
const niceCeil = (value: number) => {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
};

function formatDuration(ms: number, t: TFunction): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (days > 0) return t('quota_management.pool_duration_days', { days, hours });
  if (hours > 0) return t('quota_management.pool_duration_hours', { hours, minutes: minutes % 60 });
  return t('quota_management.pool_duration_minutes', { minutes });
}

export function QuotaPool({ entries, quotaFor, resolvedTheme, showEmails }: QuotaPoolProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const apiBase = useAuthStore((state) => state.apiBase);
  const history = useQuotaHistory(apiBase);

  const [metric, setMetric] = useState<PoolMetric>(
    () => readQuotaUiState()?.poolMetric ?? 'remaining'
  );
  const [burnWindow, setBurnWindow] = useState<PoolBurnWindow>(
    () => readQuotaUiState()?.poolBurnWindow ?? 3
  );
  const [futureUsage, setFutureUsage] = useState<PoolFutureUsage>(
    () => readQuotaUiState()?.poolFutureUsage ?? 'same'
  );
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(
    () => new Set(readQuotaUiState()?.poolExcluded ?? [])
  );
  const [rangeOffsetDays, setRangeOffsetDays] = useState(0);

  const locale = i18n.resolvedLanguage;
  const formats = useMemo(() => {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const dayOfMonth = new Intl.DateTimeFormat(locale, { day: 'numeric' });
    const weekdayTime = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    const monthDay = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    return {
      day: (ms: number) => `${weekday.format(ms)} ${dayOfMonth.format(ms)}`,
      weekdayTime: (ms: number) => weekdayTime.format(ms),
      monthDay: (ms: number) => monthDay.format(ms),
    };
  }, [locale]);

  const range = useMemo(() => {
    const startMs = localMidnight(now, rangeOffsetDays - RANGE_DAYS_BEFORE_TODAY);
    const dayStartsMs = Array.from({ length: RANGE_DAYS }, (_, day) => localMidnight(startMs, day));
    return { startMs, endMs: localMidnight(startMs, RANGE_DAYS), dayStartsMs };
  }, [now, rangeOffsetDays]);

  const loadedMeters = useMemo(() => {
    const result = new Map<string, LedgerMeter[]>();
    for (const entry of entries) {
      const meters = buildLedgerMeters(entry.type, quotaFor(entry), t);
      if (meters.length > 0) result.set(getQuotaCacheKey(entry.file), meters);
    }
    return result;
  }, [entries, quotaFor, t]);

  // A refresh puts every account in a loading state; the pool keeps its last reading meanwhile.
  const [previousMeters, setPreviousMeters] = useState<ReadonlyMap<string, LedgerMeter[]>>(
    () => new Map()
  );
  useEffect(() => {
    if (loadedMeters.size === 0) return;
    setPreviousMeters((previous) => new Map([...previous, ...loadedMeters]));
  }, [loadedMeters]);
  const metersByKey = useMemo(() => {
    const result = new Map(loadedMeters);
    for (const entry of entries) {
      const key = getQuotaCacheKey(entry.file);
      const previous = previousMeters.get(key);
      if (!result.has(key) && previous && quotaFor(entry)?.status === 'loading') {
        result.set(key, previous);
      }
    }
    return result;
  }, [entries, loadedMeters, previousMeters, quotaFor]);

  const groups = useMemo((): PoolGroup[] => {
    const futureFactor = POOL_FUTURE_USAGE[futureUsage];
    return QUOTA_TAB_ORDER.flatMap((provider): PoolGroup[] => {
      const providerEntries = entries.filter(
        (entry) => entry.type === provider && !entry.file.disabled
      );
      if (providerEntries.length === 0) return [];
      const limitId = selectPoolLimitId(
        provider,
        providerEntries.map((entry) => metersByKey.get(getQuotaCacheKey(entry.file)) ?? [])
      );

      const accounts = providerEntries.map((entry): PoolGroupAccount & { pool: PoolAccount } => {
        const key = getQuotaCacheKey(entry.file);
        const name = accountName(entry.file, showEmails);
        const meter = limitId
          ? metersByKey.get(key)?.find((item) => item.id === limitId)
          : undefined;
        const observations = limitId ? historyFor(history, provider, key, limitId) : [];
        const last = observations[observations.length - 1];
        const reading =
          meter && meter.remaining !== null
            ? {
                // The fetch that produced this meter also stored it, so its point dates it.
                atMs: last && last.remaining === meter.remaining ? last.atMs : now,
                remaining: meter.remaining,
                resetAtMs: meter.resetAtMs,
                periodHours: meter.periodHours,
              }
            : null;
        return {
          entry,
          key,
          name,
          included: !excluded.has(key),
          remaining: reading?.remaining ?? null,
          pool: { key, name, reading, history: observations },
        };
      });

      const forecast = buildPoolForecast(
        accounts.filter((account) => account.included).map((account) => account.pool),
        {
          nowMs: now,
          burnWindowHours: burnWindow,
          futureFactor,
          startMs: range.startMs,
          horizonMs: range.endMs,
        }
      );
      return [{ provider, accounts, forecast }];
    });
  }, [burnWindow, entries, excluded, futureUsage, history, metersByKey, now, range, showEmails]);

  const changeMetric = (next: PoolMetric) => {
    setMetric(next);
    writeQuotaUiState({ poolMetric: next });
  };
  const changeBurnWindow = (next: PoolBurnWindow) => {
    setBurnWindow(next);
    writeQuotaUiState({ poolBurnWindow: next });
  };
  const changeFutureUsage = (next: PoolFutureUsage) => {
    setFutureUsage(next);
    writeQuotaUiState({ poolFutureUsage: next });
  };
  const toggleAccount = (key: string, include: boolean) => {
    setExcluded((previous) => {
      const next = new Set(previous);
      if (include) next.delete(key);
      else next.add(key);
      writeQuotaUiState({ poolExcluded: [...next] });
      return next;
    });
  };

  const futureOptions = useMemo(
    () =>
      (Object.keys(POOL_FUTURE_USAGE) as PoolFutureUsage[]).map((value) => ({
        value,
        label: t(`quota_management.pool_future_${value}`),
      })),
    [t]
  );

  if (groups.length === 0) return null;

  return (
    <div className={styles.pool}>
      <div className={styles.toolbar}>
        <div className={styles.controls}>
          <div
            className={styles.segmented}
            role="group"
            aria-label={t('quota_management.pool_metric_label')}
          >
            {POOL_METRICS.map((value) => (
              <button
                key={value}
                type="button"
                className={`${styles.segment} ${metric === value ? styles.segmentActive : ''}`}
                aria-pressed={metric === value}
                onClick={() => changeMetric(value)}
              >
                {t(`quota_management.pool_metric_${value}`)}
              </button>
            ))}
          </div>

          <span className={styles.controlLabel} id="quota-pool-burn-label">
            {t('quota_management.pool_burn_rate')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby="quota-pool-burn-label">
            {POOL_BURN_WINDOWS.map((hours) => (
              <button
                key={hours}
                type="button"
                className={`${styles.segment} ${burnWindow === hours ? styles.segmentActive : ''}`}
                aria-pressed={burnWindow === hours}
                onClick={() => changeBurnWindow(hours)}
              >
                {t('quota_management.pool_hours', { hours })}
              </button>
            ))}
          </div>

          <span className={styles.controlLabel}>{t('quota_management.pool_future_usage')}</span>
          <div className={styles.futureSelect}>
            <Select
              value={futureUsage}
              options={futureOptions}
              onChange={(value) => changeFutureUsage(value as PoolFutureUsage)}
              ariaLabel={t('quota_management.pool_future_usage')}
              size="sm"
            />
          </div>

          <AccountsMenu groups={groups} onToggle={toggleAccount} />
        </div>

        <div className={styles.range}>
          <span className={styles.rangeLabel}>
            {t('quota_management.pool_range', {
              start: formats.monthDay(range.startMs),
              end: formats.monthDay(range.dayStartsMs[range.dayStartsMs.length - 1]),
            })}
          </span>
          <button
            type="button"
            className={styles.rangeStep}
            aria-label={t('quota_management.pool_range_earlier')}
            onClick={() => setRangeOffsetDays((days) => days - RANGE_STEP_DAYS)}
          >
            <IconChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={styles.rangeToday}
            disabled={rangeOffsetDays === 0}
            onClick={() => setRangeOffsetDays(0)}
          >
            {t('quota_management.pool_today')}
          </button>
          <button
            type="button"
            className={`${styles.rangeStep} ${styles.rangeStepNext}`}
            aria-label={t('quota_management.pool_range_later')}
            onClick={() => setRangeOffsetDays((days) => days + RANGE_STEP_DAYS)}
          >
            <IconChevronLeft size={16} />
          </button>
        </div>
      </div>

      {groups.map((group) => (
        <PoolCard
          key={group.provider}
          group={group}
          metric={metric}
          burnWindow={burnWindow}
          now={now}
          range={range}
          formats={formats}
          resolvedTheme={resolvedTheme}
        />
      ))}
    </div>
  );
}

function AccountsMenu({
  groups,
  onToggle,
}: {
  groups: PoolGroup[];
  onToggle: (key: string, include: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.accounts} ref={rootRef}>
      <button
        type="button"
        className={`${styles.accountsButton} ${open ? styles.accountsButtonActive : ''}`}
        aria-expanded={open}
        aria-controls="quota-pool-accounts"
        onClick={() => setOpen((value) => !value)}
      >
        {t('quota_management.pool_accounts')}
      </button>
      {open && (
        <div id="quota-pool-accounts" className={styles.popover}>
          <p className={styles.popoverHint}>{t('quota_management.pool_accounts_hint')}</p>
          {groups.map((group) => (
            <div key={group.provider} className={styles.popoverGroup}>
              <div className={styles.popoverGroupTitle}>{getTypeLabel(t, group.provider)}</div>
              {group.accounts.map((account) => (
                <div key={account.key} className={styles.popoverRow}>
                  <SelectionCheckbox
                    checked={account.included}
                    onChange={(value) => onToggle(account.key, value)}
                    label={<span className={styles.popoverName}>{account.name}</span>}
                    title={account.name}
                  />
                  <span className={styles.popoverValue}>
                    {account.remaining === null ? '--' : formatPercent(account.remaining)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PoolFormats {
  day: (ms: number) => string;
  weekdayTime: (ms: number) => string;
  monthDay: (ms: number) => string;
}

function PoolCard({
  group,
  metric,
  burnWindow,
  now,
  range,
  formats,
  resolvedTheme,
}: {
  group: PoolGroup;
  metric: PoolMetric;
  burnWindow: PoolBurnWindow;
  now: number;
  range: { startMs: number; endMs: number; dayStartsMs: number[] };
  formats: PoolFormats;
  resolvedTheme: ResolvedTheme;
}) {
  const { t } = useTranslation();
  const { provider, forecast } = group;
  const { projection } = forecast;
  const providerName = getTypeLabel(t, provider);
  const notBy = t('quota_management.pool_not_by', {
    date: formats.monthDay(now + POOL_FORECAST_MS),
  });

  const stats = [
    {
      id: 'pool-empty',
      label: t('quota_management.pool_empty'),
      value: !projection
        ? '--'
        : projection.poolEmptyAtMs === null
          ? notBy
          : formats.weekdayTime(projection.poolEmptyAtMs),
    },
    {
      id: 'first-empty',
      label: t('quota_management.pool_first_empty'),
      value: !projection
        ? '--'
        : projection.firstEmpty === null
          ? notBy
          : t('quota_management.pool_first_empty_value', {
              name: projection.firstEmpty.name,
              duration: formatDuration(projection.firstEmpty.atMs - now, t),
            }),
    },
    {
      id: 'next-reset',
      label: t('quota_management.pool_next_reset'),
      value: projection?.jumps[0] ? (
        <>
          <strong>+{formatPercent(projection.jumps[0].gain)}</strong>{' '}
          {formats.weekdayTime(projection.jumps[0].atMs)}
        </>
      ) : (
        '--'
      ),
    },
    {
      id: 'burn',
      label:
        forecast.burn?.source === 'since-reset'
          ? t('quota_management.pool_burn_since_reset')
          : t('quota_management.pool_burn_recent', { hours: burnWindow }),
      value: forecast.burn
        ? t('quota_management.pool_per_hour', { value: forecast.burn.perHour.toFixed(1) })
        : '--',
    },
  ];

  const isDrain = metric === 'drain';
  const drainPeak = Math.max(
    0,
    ...forecast.recordedDrain.flat().map((point) => point.value),
    ...(projection?.drain ?? []).map((point) => point.value)
  );
  const yMax = isDrain ? niceCeil(drainPeak) : Math.max(forecast.capacity, 100);
  const yLabel = (value: number) =>
    isDrain ? t('quota_management.pool_per_hour', { value: String(value) }) : formatPercent(value);

  const jumps: PoolChartMark[] = isDrain
    ? []
    : (projection?.jumps ?? []).map((jump) => ({
        atMs: jump.atMs,
        value: valueAfter(projection?.points ?? [], jump.atMs),
        label: `+${formatPercent(jump.gain)}`,
      }));
  const emptyAtMs = projection?.poolEmptyAtMs ?? null;
  const accent = poolAccent(provider, resolvedTheme);

  return (
    <section
      className={styles.card}
      aria-label={providerName}
      style={{ '--pool-accent': accent } as CSSProperties}
    >
      <header className={styles.cardHead}>
        <div className={styles.headline}>
          <div className={styles.title}>
            <QuotaProviderIcon
              provider={provider}
              resolvedTheme={resolvedTheme}
              className={styles.titleIcon}
            />
            <span className={styles.titleName}>{providerName}</span>
            <span className={styles.titleCount}>
              {t('quota_management.pool_account_count', { count: forecast.included })}
            </span>
          </div>
          <div className={styles.total}>
            <span className={styles.totalValue}>
              {forecast.total === null ? '--' : formatPercent(forecast.total)}
            </span>
            <span className={styles.totalOf}>
              {t('quota_management.ledger_of', { capacity: forecast.capacity })}
            </span>
            {forecast.loaded < forecast.included && (
              <span className={styles.totalNote}>
                {t('quota_management.pool_loaded_of', {
                  loaded: forecast.loaded,
                  total: forecast.included,
                })}
              </span>
            )}
          </div>
        </div>
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.id} className={styles.stat}>
              <dt className={styles.statLabel}>{stat.label}</dt>
              <dd className={styles.statValue}>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <QuotaPoolChart
        startMs={range.startMs}
        endMs={range.endMs}
        nowMs={now}
        dayStartsMs={range.dayStartsMs}
        formatDay={formats.day}
        yMax={yMax}
        yLabels={[yMax, yMax / 2, 0].map((value) => ({ value, label: yLabel(value) }))}
        recorded={isDrain ? forecast.recordedDrain : forecast.recorded}
        projected={isDrain ? (projection?.drain ?? []) : (projection?.points ?? [])}
        nowValue={isDrain ? (forecast.burn?.perHour ?? null) : forecast.total}
        nowLabel={t('quota_management.pool_now')}
        jumps={jumps}
        empty={
          !isDrain && emptyAtMs !== null
            ? {
                atMs: emptyAtMs,
                value: 0,
                label: t('quota_management.pool_empty_at', {
                  time: formats.weekdayTime(emptyAtMs),
                }),
              }
            : null
        }
        accent={accent}
        ariaLabel={t('quota_management.pool_chart_label', { provider: providerName })}
      />

      <footer className={styles.legend}>
        <span className={styles.legendTitle}>{t('quota_management.pool_legend')}</span>
        <span className={styles.legendItem}>
          <span className={styles.legendRecorded} aria-hidden="true" />
          {t('quota_management.pool_recorded')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendProjected} aria-hidden="true" />
          {t('quota_management.pool_projected')}
        </span>
      </footer>
    </section>
  );
}

/** The pool value right after `atMs`: the projection repeats an instant for a jump. */
function valueAfter(points: readonly PoolPoint[], atMs: number): number {
  let value = 0;
  for (const point of points) {
    if (point.atMs > atMs) break;
    if (point.atMs === atMs) value = point.value;
  }
  return value;
}
