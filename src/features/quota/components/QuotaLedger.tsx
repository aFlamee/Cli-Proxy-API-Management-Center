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
import { Modal } from '@/components/ui/Modal';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import {
  buildClaudeResetDetail,
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
  const { entry, quota, meters } = row;
  const adapter = QUOTA_ADAPTERS[entry.type];
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const fileName = getQuotaDisplayName(entry.file);
  const name = showEmails ? fileName : maskEmails(fileName);
  // Claude's reset grants are read per credential, apart from its quota.
  const claudeReset = useClaudeResetGrants(
    entry.file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const details =
    entry.type === 'claude' && status === 'success'
      ? [buildClaudeResetDetail(claudeReset, quota, t)]
      : row.details;
  // Claude spends the chosen grant. Codex spends one credit of OpenAI's choosing.
  const redeem: Redeem =
    entry.type === 'claude'
      ? { can: claudeReset.canRedeem, run: claudeReset.redeem, busy: claudeReset.busy }
      : {
          can: () => showReset && canRefresh && !loading && !resetting,
          run: onReset,
          busy: resetting,
        };
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
          <DetailCell
            key={detail.id}
            detail={detail}
            credential={name}
            meters={meters}
            redeem={redeem}
            now={now}
            locale={i18n.resolvedLanguage}
          />
        ))}
      </div>
    );
  }

  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <span className={styles.fileName} title={showEmails ? name : undefined}>
          {name}
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

/** `preview` is the remaining percent a reset would leave; it shows only when it adds some. */
function MeterCell({
  meter,
  dimmed,
  preview,
  now,
  locale,
  t,
}: {
  meter: LedgerMeter;
  dimmed: boolean;
  preview?: number;
  now: number;
  locale: string | undefined;
  t: TFunction;
}) {
  const gain = preview !== undefined && preview > (meter.remaining ?? 0) ? preview : null;
  return (
    <div className={`${styles.meter} ${dimmed ? styles.meterDimmed : ''}`}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel} title={meter.label}>
          {meter.label}
        </span>
        <span className={styles.meterValue}>
          {formatPercent(meter.remaining)}
          {gain !== null && <span className={styles.meterGain}> → {formatPercent(gain)}</span>}
        </span>
      </div>
      <span className={styles.track}>
        {gain !== null && (
          <span
            className={`${styles.fill} ${styles.fillPreview} ${toneClass(gain)}`}
            style={{ width: `${gain}%` }}
          />
        )}
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

/** Spends one of a credential's manual resets by id. */
interface Redeem {
  can: (resetId: string) => boolean;
  run: (resetId: string) => void;
  busy: boolean;
}

/**
 * "Manual resets · 2 available · Reset 1 · in 22 days · 10/03, 17:02" as one column,
 * as wide as its text. A detail holding resets opens the list of all of them.
 */
function DetailCell({
  detail,
  credential,
  meters,
  redeem,
  now,
  locale,
}: {
  detail: LedgerDetail;
  credential: string;
  meters: LedgerMeter[];
  redeem: Redeem;
  now: number;
  locale: string | undefined;
}) {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewed = detail.resets.find((reset) => reset.id === previewId);
  return (
    <div className={`${styles.meter} ${styles.detail}`}>
      <div className={`${styles.meterHead} ${styles.detailHead}`}>
        <span className={styles.meterLabel}>{detail.label}</span>
        {detail.resets.length > 0 && (
          <button
            type="button"
            className={styles.detailToggle}
            aria-haspopup="dialog"
            onClick={() => setListOpen(true)}
          >
            {t('quota_management.ledger_show_all')}
          </button>
        )}
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
      <Modal open={listOpen} onClose={() => setListOpen(false)} title={detail.label} width={620}>
        <div className={styles.fileName}>{credential}</div>
        {meters.length > 0 && (
          <>
            <div className={`${styles.meters} ${styles.resetPreview}`}>
              {meters.map((meter) => (
                <MeterCell
                  key={meter.id}
                  meter={meter}
                  dimmed={false}
                  preview={previewed?.after[meter.id]}
                  now={now}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
            <div className={styles.resetItemNote}>
              {t('quota_management.ledger_reset_preview_hint')}
            </div>
          </>
        )}
        <ul className={styles.resetList}>
          {detail.resets.map((reset) => (
            <li
              key={reset.id}
              className={`${styles.resetItem} ${reset.id === previewId ? styles.resetItemActive : ''}`}
              tabIndex={0}
              onMouseEnter={() => setPreviewId(reset.id)}
              onMouseLeave={() => setPreviewId(null)}
              onFocus={() => setPreviewId(reset.id)}
              onBlur={() => setPreviewId(null)}
            >
              <div className={styles.resetItemName}>
                <span className={styles.resetItemLabel}>{reset.label}</span>
                {reset.note && <span className={styles.resetItemNote}>{reset.note}</span>}
              </div>
              <div className={styles.resetItemSide}>
                {reset.expiresAtMs === null ? (
                  <span className={styles.resetItemNote}>{t('claude_reset.expiry_unknown')}</span>
                ) : (
                  <div className={styles.resetItemExpiry}>
                    <span className={styles.resetItemLabel}>
                      {formatRelativeInstant(reset.expiresAtMs, now, locale)}
                    </span>
                    <span className={styles.resetItemNote}>
                      {t('claude_reset.ends', { date: formatInstantShort(reset.expiresAtMs) })}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  className={styles.action}
                  disabled={!redeem.can(reset.id)}
                  onClick={() => {
                    // The confirmation is its own dialog. Close this one so focus is not trapped.
                    setListOpen(false);
                    redeem.run(reset.id);
                  }}
                >
                  <IconRefreshCw size={12} className={redeem.busy ? styles.spinning : undefined} />
                  {t('quota_management.ledger_redeem')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
