import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTodayDate, obtenerHoyBA } from '../../src/utils/dateUtils';

/** Business "today" = calendar date in America/Argentina/Buenos_Aires (UTC-3, no DST), never the device zone. */
describe('getTodayDate — Buenos Aires business date (timezone contract)', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['2026-10-15T02:59:59.999Z', '2026-10-14'],   // 23:59:59.999 in Argentina: UTC is already the next day
    ['2026-10-15T00:30:00.000Z', '2026-10-14'],   // 21:30 in Argentina (the window where UTC CURRENT_DATE was wrong)
    ['2026-10-15T03:00:00.000Z', '2026-10-15'],   // 00:00 in Argentina
    ['2027-01-01T02:30:00.000Z', '2026-12-31'],   // year boundary: still New Year's Eve in Argentina
    ['2026-03-01T02:00:00.000Z', '2026-02-28'],   // month boundary (non-leap February)
    ['2026-10-15T15:00:00.000Z', '2026-10-15'],   // midday: every zone agrees
  ])('%s → %s', (instant, expected) => {
    expect(getTodayDate(new Date(instant))).toBe(expected);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    expect(getTodayDate()).toBe(expected);       // default argument path used by the 58 callers
  });

  it('getTodayDate and obtenerHoyBA are one definition', () => {
    const t = new Date('2026-10-15T01:00:00.000Z');
    expect(getTodayDate(t)).toBe(obtenerHoyBA(t));
  });

  it('format is YYYY-MM-DD (the shape every caller and <input type="date"> expects)', () => {
    expect(getTodayDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the result does not depend on the device / process timezone', () => {
    const root = resolve(__dirname, '../..');
    const probe = `import('./src/utils/dateUtils.ts').then((m) => console.log(m.getTodayDate(new Date('2026-10-15T01:30:00.000Z'))))`;
    const out = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/Madrid'].map((tz) => {
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', probe], { cwd: root, encoding: 'utf8', env: { ...process.env, TZ: tz } });
      return (r.stdout || r.stderr).trim();
    });
    expect(out).toEqual(['2026-10-14', '2026-10-14', '2026-10-14', '2026-10-14']);
  });
});
