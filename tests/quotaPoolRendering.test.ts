import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { QuotaPool } from '../src/features/quota/components/QuotaPool';
import type { QuotaFileEntry } from '../src/features/quota/logic';

const HOUR = 3_600_000;

const entries: QuotaFileEntry[] = [
  { file: { name: 'claude-a.json', type: 'claude', email: 'tom@acme.dev' }, type: 'claude' },
];

describe('QuotaPool rendering', () => {
  test('shows the pool total, the reset gain and the masked account that runs dry', () => {
    // 10% left of a weekly window that opened 96 hours ago and resets in 72.
    const quota = {
      status: 'success' as const,
      windows: [
        {
          id: 'seven-day',
          label: '7-day',
          usedPercent: 90,
          resetAtMs: Date.now() + 72 * HOUR,
          periodHours: 168,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(QuotaPool, {
        entries,
        quotaFor: () => quota,
        resolvedTheme: 'dark',
        showEmails: false,
      })
    );

    expect(markup).toContain('>10%<');
    expect(markup).toContain(i18n.t('quota_management.ledger_of', { capacity: 100 }));
    expect(markup).toContain(i18n.t('quota_management.pool_burn_since_reset'));
    // 90% used over 96h burns 0.94%/h: dry in under 11 hours, so the reset returns all 100%.
    expect(markup).toContain('+100%');
    expect(markup).toContain('t•••@a•••.dev');
    expect(markup).not.toContain('tom@acme.dev');
  });
});
