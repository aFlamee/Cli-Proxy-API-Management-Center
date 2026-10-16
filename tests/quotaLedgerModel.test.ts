import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
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
