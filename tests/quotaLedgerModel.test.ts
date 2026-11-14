import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import {
  buildClaudeResetDetail,
  buildLedgerDetails,
  buildLedgerMeters,
  ledgerColumns,
  maskEmails,
  summarizeLedgerProvider,
  type LedgerMeter,
} from '@/features/quota/ledgerModel';

const t = ((key: string, params?: Record<string, unknown>) =>
  params && 'index' in params ? `${key}#${params.index}` : key) as unknown as TFunction;

const NOW = Date.UTC(2026, 8, 11, 18, 0);
const HOUR = 3_600_000;

const meter = (id: string, remaining: number | null, extra: Partial<LedgerMeter> = {}) =>
  ({
    id,
    label: id,
    remaining,
    resetAtMs: null,
    periodHours: id === 'five-hour' ? 5 : 168,
    ...extra,
  }) as LedgerMeter;

describe('summarizeLedgerProvider', () => {
  const lists = [
    [
      meter('five-hour', 100),
      meter('weekly', 79, { resetAtMs: NOW + 40 * HOUR }),
      meter('fable', 58),
    ],
    [
      meter('five-hour', 99),
      meter('weekly', 75, { resetAtMs: NOW + 26 * HOUR }),
      meter('fable', 51),
    ],
    [], // not loaded yet
  ];
  const summary = summarizeLedgerProvider('claude', lists, NOW);

  test('totals long limits only and leads with the most constrained one', () => {
    expect(summary.limits.map((limit) => [limit.id, limit.total])).toEqual([
      ['fable', 109],
      ['weekly', 154],
    ]);
  });

  test('counts every credential in the capacity and leaves unloaded segments empty', () => {
    expect(summary.limits[0].capacity).toBe(300);
    expect(summary.limits[0].segments).toEqual([58, 51, null]);
  });

  test('reports the soonest upcoming reset', () => {
    expect(summary.limits[1].nextResetMs).toBe(NOW + 26 * HOUR);
  });

  test('orders row columns as headline, short windows, then dimmed secondary limits', () => {
    expect(ledgerColumns(summary, lists)).toEqual([
      { id: 'fable', dimmed: false },
      { id: 'five-hour', dimmed: false },
      { id: 'weekly', dimmed: true },
    ]);
  });

  test('has no headline when no credential reported a figure', () => {
    expect(summarizeLedgerProvider('xai', [[], []], NOW).limits).toEqual([]);
  });
});

describe('buildLedgerMeters', () => {
  test('converts Kimi counts into remaining percent', () => {
    const meters = buildLedgerMeters(
      'kimi',
      { status: 'success', rows: [{ id: 'weekly', label: 'Weekly', used: 25, limit: 100 }] },
      t
    );
    expect(meters[0].remaining).toBe(75);
  });

  test('yields nothing until the quota loaded', () => {
    expect(buildLedgerMeters('claude', { status: 'loading', windows: [] }, t)).toEqual([]);
  });
});

describe('buildLedgerDetails', () => {
  test('numbers Codex manual resets like the card list', () => {
    const [detail] = buildLedgerDetails(
      'codex',
      {
        status: 'success',
        rateLimitResetCreditsAvailableCount: 2,
        rateLimitResetCredits: [
          { status: 'available', expiresAt: 'not a date' },
          { status: 'available', expiresAt: '2026-10-03T15:02:00Z' },
        ],
      },
      t
    );
    expect(detail.value).toBe('2');
    expect(detail.note).toBe('codex_quota.reset_credit_number#2');
    expect(detail.noteAtMs).toBe(Date.parse('2026-10-03T15:02:00Z'));
    expect(detail.resets.map((reset) => [reset.label, reset.expiresAtMs])).toEqual([
      ['codex_quota.reset_credit_number#1', null],
      ['codex_quota.reset_credit_number#2', Date.parse('2026-10-03T15:02:00Z')],
    ]);
    expect(detail.resets[0].after).toEqual({});
  });
});

describe('buildClaudeResetDetail', () => {
  const grant = (
    id: string,
    endsAt: string,
    clears: AnthropicResetGrant['clears'],
    givesBackWeekly = false
  ) =>
    ({
      id,
      label: id,
      resetsTotal: 1,
      resetsLeft: 1,
      endsAt,
      clears,
      givesBackWeekly,
    }) as AnthropicResetGrant;
  const window = (id: string, usedPercent: number) => ({ id, label: id, usedPercent });
  const quota = {
    status: 'success',
    windows: [window('five-hour', 64), window('seven-day', 55), window('seven-day-fable', 78)],
    fableWeeklyShare: 39,
  };
  const grants = [
    grant('fable', '2027-03-09T07:59:00Z', ['five_hour', 'seven_day_overage_included'], true),
    grant('full', '2026-12-10T22:00:00Z', ['five_hour', 'seven_day', 'seven_day_overage_included']),
  ];

  test('lists every grant, soonest expiry first, with the limits it refills', () => {
    const detail = buildClaudeResetDetail({ count: 2, grants, message: '' }, quota, ((
      key: string,
      params?: { limits?: string }
    ) => (params?.limits ? `${key}:${params.limits}` : key)) as unknown as TFunction);
    expect(detail.value).toBe('2');
    expect(detail.noteAtMs).toBe(Date.parse('2026-12-10T22:00:00Z'));
    expect(detail.resets.map((reset) => reset.id)).toEqual(['full', 'fable']);
    expect(detail.resets[1].note).toBe(
      'quota_management.ledger_reset_refills:claude_quota.five_hour, claude_quota.seven_day_fable'
    );
  });

  test('a full reset refills everything, a Fable reset gives back only its weekly share', () => {
    const [full, fable] = buildClaudeResetDetail(
      { count: 2, grants, message: '' },
      quota,
      t
    ).resets;
    expect(full.after).toEqual({ 'five-hour': 100, 'seven-day': 100, 'seven-day-fable': 100 });
    // 45% left on the weekly limit plus the 39% Fable used of it.
    expect(fable.after).toEqual({ 'five-hour': 100, 'seven-day-fable': 100, 'seven-day': 84 });
  });

  test('shows why the grants are missing when their read failed', () => {
    const detail = buildClaudeResetDetail(
      { count: null, grants: [], message: 'read_error' },
      quota,
      t
    );
    expect(detail.value).toBe('--');
    expect(detail.note).toBe('claude_reset.read_error');
    expect(detail.resets).toEqual([]);
  });
});

describe('maskEmails', () => {
  test('keeps the filename prefix and suffix around a masked address', () => {
    expect(maskEmails('claude-tobi@1337.dev.json')).toBe('claude-t•••@1•••.dev.json');
    expect(maskEmails('codex-ae5d455f-tobi@1337.dev-pro.json')).toBe(
      'codex-ae5d455f-t•••@1•••.dev-pro.json'
    );
  });

  test('leaves names without an address untouched', () => {
    expect(maskEmails('vertex-project.json')).toBe('vertex-project.json');
  });
});
