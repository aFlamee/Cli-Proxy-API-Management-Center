/**
 * Ledger view of the quota page: a summary strip that totals each provider's
 * long limits, then one compact row per credential with its limits side by side.
 *
 * Rendering only — meters, totals, and column order come from ledgerModel.ts.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import {
  buildLedgerDetails,
  buildLedgerMeters,
  ledgerColumns,
  ledgerIdentity,
  maskEmails,
  summarizeLedgerProvider,
  type LedgerColumn,
  type LedgerDetail,
  type LedgerLimitTotal,
  type LedgerMeter,
  type LedgerProviderSummary,
} from '../ledgerModel';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import { QuotaProviderIcon } from './QuotaProviderIcon';
import styles from './QuotaLedger.module.scss';

export type QuotaLedgerProps = {
  /** Entries already grouped by provider, in display order. */
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  showEmails: boolean;
  canRefresh: (entry: QuotaFileEntry) => boolean;
  onRefresh: (entry: QuotaFileEntry) => void;
  /** Cache key of the credential whose quota reset is in flight. */
  resettingKey: string | null;
  onReset: (entry: QuotaFileEntry) => void;
};

interface LedgerRow {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  meters: LedgerMeter[];
  details: LedgerDetail[];
}

interface LedgerGroup {
  provider: QuotaProviderType;
  rows: LedgerRow[];
  summary: LedgerProviderSummary;
  columns: LedgerColumn[];
}

const toneClass = (percent: number) =>
  percent >= QUOTA_PROGRESS_HIGH_THRESHOLD
    ? styles.toneHigh
    : percent >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
      ? styles.toneMedium
      : styles.toneLow;

const formatPercent = (value: number | null) => (value === null ? '--' : `${Math.round(value)}%`);

export function QuotaLedger(props: QuotaLedgerProps) {
  const {
    entries,
    quotaFor,
    resolvedTheme,
    showEmails,
    canRefresh,
    onRefresh,
    resettingKey,
    onReset,
  } = props;
  const { t } = useTranslation();
  const now = useNow();

  const groups = useMemo(() => {
    const byProvider = new Map<QuotaProviderType, LedgerRow[]>();
    for (const entry of entries) {
      const quota = quotaFor(entry);
      const rows = byProvider.get(entry.type) ?? [];
      rows.push({
        entry,
        quota,
        meters: buildLedgerMeters(entry.type, quota, t),
        details: buildLedgerDetails(entry.type, quota, t),
      });
      byProvider.set(entry.type, rows);
    }
    return [...byProvider].map(([provider, rows]): LedgerGroup => {
      const meterLists = rows.map((row) => row.meters);
      const summary = summarizeLedgerProvider(provider, meterLists, now);
      return { provider, rows, summary, columns: ledgerColumns(summary, meterLists) };
    });
  }, [entries, quotaFor, t, now]);

  if (groups.length === 0) return null;

  return (
    <div className={styles.ledger}>
      <section
        className={styles.summary}
        style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}
        aria-label={t('quota_management.ledger_summary_label')}
      >
        {groups.map((group) => (
          <SummaryColumn
            key={group.provider}
            summary={group.summary}
            resolvedTheme={resolvedTheme}
            now={now}
          />
        ))}
      </section>

      {groups.map((group) => (
        <section key={group.provider} className={styles.group}>
          <h2 className={styles.groupTitle}>
            {getTypeLabel(t, group.provider)}
            <span className={styles.groupCount}>{group.rows.length}</span>
          </h2>
          <ul className={styles.rows}>
            {group.rows.map((row) => (
              <CredentialRow
                key={getQuotaCacheKey(row.entry.file)}
                row={row}
                columns={group.columns}
                showEmails={showEmails}
                canRefresh={canRefresh(row.entry)}
                onRefresh={() => onRefresh(row.entry)}
                resetting={resettingKey === getQuotaCacheKey(row.entry.file)}
                onReset={() => onReset(row.entry)}
                now={now}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ---------- summary strip ---------- */

function SummaryColumn({
  summary,
  resolvedTheme,
  now,
}: {
  summary: LedgerProviderSummary;
  resolvedTheme: ResolvedTheme;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [headline, ...secondary] = summary.limits;

  return (
    <div className={styles.summaryColumn}>
      <header className={styles.summaryHead}>
        <QuotaProviderIcon provider={summary.provider} resolvedTheme={resolvedTheme} />
        <span className={styles.summaryName}>{getTypeLabel(t, summary.provider)}</span>
        <span className={styles.summaryCount}>
          {t('quota_management.ledger_credentials', { count: summary.credentialCount })}
        </span>
      </header>

      {headline ? (
        <>
          <div className={styles.summaryLabel}>{headline.label}</div>
          <div className={styles.summaryTotal}>
            <span className={styles.summaryValue}>{formatPercent(headline.total)}</span>
            <span className={styles.summaryOf}>
              {t('quota_management.ledger_of', { capacity: headline.capacity })}
            </span>
          </div>
          <SegmentBar limit={headline} />
          <ResetLine atMs={headline.nextResetMs} now={now} locale={i18n.resolvedLanguage} t={t} />

          {secondary.length > 0 && (
            <div className={styles.summarySecondary}>
              {secondary.map((limit) => (
                <div key={limit.id} className={styles.secondaryLimit}>
                  <div className={styles.secondaryLine}>
                    <span className={styles.secondaryLabel}>{limit.label}</span>
                    <span className={styles.secondaryValue}>{formatPercent(limit.total)}</span>
                  </div>
                  {expanded && (
                    <>
                      <SegmentBar limit={limit} />
                      <ResetLine
                        atMs={limit.nextResetMs}
                        now={now}
                        locale={i18n.resolvedLanguage}
                        t={t}
                      />
                    </>
                  )}
                </div>
              ))}
              <button
                type="button"
                className={styles.secondaryToggle}
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {t(expanded ? 'quota_management.ledger_hide' : 'quota_management.ledger_show')}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className={styles.summaryEmpty}>{t('quota_management.ledger_not_loaded')}</div>
      )}
    </div>
  );
}

/** One segment per credential, each filled to that credential's remaining share. */
function SegmentBar({ limit }: { limit: LedgerLimitTotal }) {
  return (
    <div className={styles.segments} aria-hidden="true">
      {limit.segments.map((value, index) => (
        <span key={index} className={styles.track}>
          {value !== null && value > 0 && (
            <span className={`${styles.fill} ${toneClass(value)}`} style={{ width: `${value}%` }} />
          )}
        </span>
      ))}
    </div>
  );
}

/** `in 1 day · 09/12, 23:00`, or a quiet placeholder when nothing is counting down. */
function ResetLine({
  atMs,
  now,
  locale,
  t,
}: {
  atMs: number | null;
  now: number;
  locale: string | undefined;
  t: TFunction;
}) {
  if (atMs === null) {
    return <div className={styles.resetNone}>{t('quota_management.ledger_no_reset')}</div>;
  }
  return (
    <div className={styles.reset}>
      <span className={styles.resetRelative}>{formatRelativeInstant(atMs, now, locale)}</span>
      <span className={styles.dot}>·</span>
      <span className={styles.resetAbsolute}>{formatInstantShort(atMs)}</span>
    </div>
  );
}

/* ---------- credential rows ---------- */

function CredentialRow({
  row,
  columns,
  showEmails,
  canRefresh,
  onRefresh,
  resetting,
  onReset,
  now,
}: {
  row: LedgerRow;
  columns: LedgerColumn[];
  showEmails: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  resetting: boolean;
  onReset: () => void;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const { entry, quota, meters, details } = row;
  const adapter = QUOTA_ADAPTERS[entry.type];
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const name = getQuotaDisplayName(entry.file);
  const identity = ledgerIdentity(entry.type, quota, t);
  const showReset =
    status === 'success' &&
    quota !== undefined &&
    Boolean(adapter.resetQuota) &&
    Boolean(adapter.canResetQuota?.(quota));

  let body;
  if (status === 'idle') {
    body = (
      <button type="button" className={styles.rowHint} onClick={onRefresh} disabled={!canRefresh}>
        {t(`${adapter.i18nPrefix}.idle`)}
      </button>
    );
  } else if (loading) {
    body = (
      <div className={styles.meters} aria-busy="true">
        <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
        {(columns.length > 0 ? columns : [{ id: 'a' }, { id: 'b' }]).map((column) => (
          <div key={column.id} className={styles.meterSkeleton} aria-hidden="true" />
        ))}
      </div>
    );
  } else if (status === 'error') {
    const message = resolveQuotaErrorMessage(
      t,
      quota?.errorStatus,
      quota?.error || t('common.unknown_error')
    );
    body = (
      <div className={styles.rowError} role="alert">
        {t(`${adapter.i18nPrefix}.load_failed`, { message })}
      </div>
    );
  } else if (meters.length === 0 && details.length === 0) {
    body = <div className={styles.rowHint}>{t('quota_management.ledger_no_limits')}</div>;
  } else {
    body = (
      <div className={styles.meters}>
        {columns.map((column) => {
          const meter = meters.find((candidate) => candidate.id === column.id);
          return meter ? (
            <MeterCell
              key={column.id}
              meter={meter}
              dimmed={column.dimmed}
              now={now}
              locale={i18n.resolvedLanguage}
              t={t}
            />
          ) : (
            <div key={column.id} className={styles.meter} aria-hidden="true" />
          );
        })}
        {details.map((detail) => (
          <DetailCell key={detail.id} detail={detail} now={now} locale={i18n.resolvedLanguage} />
        ))}
      </div>
    );
  }

  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <span className={styles.fileName} title={showEmails ? name : undefined}>
          {showEmails ? name : maskEmails(name)}
        </span>
        <span className={styles.plan}>
          <span className={identity.premium ? styles.planPremium : undefined}>
            {identity.plan ?? getTypeLabel(t, entry.type)}
          </span>
          {identity.renewsAtMs !== null && (
            <>
              <span className={styles.dot}>·</span>
              {t('quota_management.ledger_renews')}{' '}
              <span className={styles.planDate}>{formatInstantShort(identity.renewsAtMs)}</span>
              <span className={styles.dot}>·</span>
              {formatRelativeInstant(identity.renewsAtMs, now, i18n.resolvedLanguage)}
            </>
          )}
        </span>
      </div>
      {body}
      <div className={styles.actions}>
        {showReset && (
          <button
            type="button"
            className={styles.action}
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
            title={t('codex_quota.reset_button')}
          >
            <IconRefreshCw size={12} className={resetting ? styles.spinning : undefined} />
            {t('codex_quota.reset_button')}
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw size={12} className={loading ? styles.spinning : undefined} />
          {t('auth_files.quota_refresh_single')}
        </button>
      </div>
    </li>
  );
}

function MeterCell({
  meter,
  dimmed,
  now,
  locale,
  t,
}: {
  meter: LedgerMeter;
  dimmed: boolean;
  now: number;
  locale: string | undefined;
  t: TFunction;
}) {
  return (
    <div className={`${styles.meter} ${dimmed ? styles.meterDimmed : ''}`}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel} title={meter.label}>
          {meter.label}
        </span>
        <span className={styles.meterValue}>{formatPercent(meter.remaining)}</span>
      </div>
      <span className={styles.track}>
        {meter.remaining !== null && meter.remaining > 0 && (
          <span
            className={`${styles.fill} ${toneClass(meter.remaining)}`}
            style={{ width: `${meter.remaining}%` }}
          />
        )}
      </span>
      <ResetLine
        atMs={meter.resetAtMs !== null && meter.resetAtMs > now ? meter.resetAtMs : null}
        now={now}
        locale={locale}
        t={t}
      />
    </div>
  );
}

/** "Manual resets · 2 available · Reset 1 · in 22 days · 10/03, 17:02" as one column. */
function DetailCell({
  detail,
  now,
  locale,
}: {
  detail: LedgerDetail;
  now: number;
  locale: string | undefined;
}) {
  return (
    <div className={styles.meter}>
      <div className={`${styles.meterHead} ${styles.detailHead}`}>
        <span className={styles.meterLabel}>{detail.label}</span>
      </div>
      <div className={styles.detailValue}>
        <strong>{detail.value}</strong>
        {detail.suffix && <span className={styles.detailSuffix}>{detail.suffix}</span>}
      </div>
      {(detail.note || detail.noteAtMs !== null) && (
        <div className={styles.reset}>
          {detail.note && <span className={styles.resetAbsolute}>{detail.note}</span>}
          {detail.noteAtMs !== null && (
            <>
              <span className={styles.dot}>·</span>
              <span className={styles.resetRelative}>
                {formatRelativeInstant(detail.noteAtMs, now, locale)}
              </span>
              <span className={styles.dot}>·</span>
              <span className={styles.resetAbsolute}>{formatInstantShort(detail.noteAtMs)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
