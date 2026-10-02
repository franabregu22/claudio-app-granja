import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS, TARGET_VIEWS, TargetDbError } from '../../src/target/db';
import { closeFeriaSummary, listFeriaClosings, openAndCloseFeria, rectifyFeriaClosing } from '../../src/target/feria';
import { FERIA_WORKSHEET_BUCKET, withWorksheet, worksheetSignedUrl } from '../../src/target/feriaWorksheet';
import { listMaster } from '../../src/target/masters';

/** PostgREST + Storage stub recording every call, answering rpc / reads from a queue. */
function stub(results: { data: unknown; error: unknown }[] = [], storage: { upload?: unknown; remove?: unknown; signed?: unknown } = {}) {
  const calls: { kind: string; table?: string; fn?: string; args?: any; bucket?: string; path?: string; filters?: unknown[] }[] = [];
  const next = () => results.shift() ?? { data: {}, error: null };
  const client = {
    from(table: string) {
      const filters: unknown[] = [];
      const q: any = {
        select: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
        then: (res: (v: unknown) => void) => { calls.push({ kind: 'select', table, filters }); res(next()); },
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { calls.push({ kind: 'rpc', fn, args }); return next(); },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => { calls.push({ kind: 'upload', bucket, path }); return { error: storage.upload ?? null }; },
        remove: async (paths: string[]) => { calls.push({ kind: 'remove', bucket, path: paths[0] }); return { error: storage.remove ?? null }; },
        createSignedUrl: async (path: string) => { calls.push({ kind: 'signed', bucket, path }); return storage.signed ?? { data: { signedUrl: 'https://local/signed' }, error: null }; },
      }),
    },
  };
  return { client: client as never, calls };
}
const INPUT = { cashSales: 1000, mpSales: 300, transferSales: 0, expenses: 150, countedCash: 1050, cashAccountId: 'caja', transferAccountId: 'banco', openingFloat: 200 };
const file = (type = 'application/pdf', size = 10) => ({ name: 'planilla.pdf', type, size }) as never;

describe('ADR-016 Feria summarized closing — data layer', () => {
  it('RPC 51 / 52 and report_feria_closing are registered', () => {
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['close_feria_summary', 'rectify_feria_closing']));
    expect(TARGET_VIEWS).toContain('report_feria_closing');
  });

  it('close sends only the summary inputs (no derived value); transfer account dropped when transfer is 0', async () => {
    const { client, calls } = stub();
    await closeFeriaSummary(client, { ...INPUT, sessionId: 's', notes: '  ' });
    expect(calls[0]).toEqual({ kind: 'rpc', fn: 'close_feria_summary', args: {
      p_session_id: 's', p_cash_sales: 1000, p_mp_sales: 300, p_transfer_sales: 0, p_expenses: 150, p_counted_cash: 1050, p_cash_account_id: 'caja',
      p_transfer_account_id: null, p_opening_float: 200, p_merma: null, p_notes: null, p_worksheet: null } });
    expect(Object.keys(calls[0].args)).not.toEqual(expect.arrayContaining(['p_total_sales', 'p_expected_cash', 'p_cash_difference']));
  });

  it('rectify sends the closing id, the reason and keepWorksheet', async () => {
    const { client, calls } = stub();
    await rectifyFeriaClosing(client, { ...INPUT, transferSales: 50, closingId: 'c1', reason: 'error', keepWorksheet: false });
    expect(calls[0]).toMatchObject({ fn: 'rectify_feria_closing', args: { p_closing_id: 'c1', p_reason: 'error', p_transfer_account_id: 'banco', p_keep_worksheet: false } });
  });

  it('history reads report_feria_closing as reported (derived values from the view)', async () => {
    const { client, calls } = stub([{ data: [{ closing_id: 'c', total_sales: '1300', expected_cash: '1050', counted_cash: '1020', cash_difference: '-30', merma: null }], error: null }]);
    const [r] = await listFeriaClosings(client, '2026-01-01', '2026-12-31');
    expect(calls[0].table).toBe('report_feria_closing');
    expect(r).toMatchObject({ total_sales: 1300, expected_cash: 1050, counted_cash: 1020, cash_difference: -30, merma: null });
  });

  it('openAndCloseFeria opens without an opening-fund event, then closes', async () => {
    const { client, calls } = stub([{ data: { session_id: 's9' }, error: null }]);
    await openAndCloseFeria(client, { ...INPUT, date: '2026-09-12', location: 'Feria', idempotencyKey: 'K', worksheet: null });
    expect(calls[0]).toMatchObject({ fn: 'open_sales_session', args: { p_opening_fund: 0, p_cash_account_id: null, p_idempotency_key: 'K' } });
    expect(calls[1]).toMatchObject({ fn: 'close_feria_summary', args: { p_session_id: 's9' } });
  });

  it('retry with the same key reuses the session opened by a failed attempt (DUPLICATE_SESSION)', async () => {
    const { client, calls } = stub([{ data: null, error: { message: 'DUPLICATE_SESSION' } }, { data: [{ id: 's1' }], error: null }]);
    await openAndCloseFeria(client, { ...INPUT, date: '2026-09-12', location: 'Feria', idempotencyKey: 'K', worksheet: null });
    expect(calls[1]).toMatchObject({ kind: 'select', table: 'sales_session', filters: [['idempotency_key', 'K']] });
    expect(calls[2]).toMatchObject({ fn: 'close_feria_summary', args: { p_session_id: 's1' } });
  });

  it('the system summary product is filtered out of product lists', async () => {
    const { client, calls } = stub([{ data: [], error: null }, { data: [], error: null }]);
    await listMaster(client, 'products');
    await listMaster(client, 'clients');
    expect(calls[0].filters).toEqual([['is_system', false]]);
    expect(calls[1].filters).toEqual([]);
  });
});

describe('ADR-016 worksheet (private bucket feria-worksheets)', () => {
  it('optional: no file → no Storage call', async () => {
    const { client, calls } = stub();
    expect(await withWorksheet(client, { userId: 'u', file: null }, async (w) => w)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('valid upload goes to feria-worksheets under the user folder and the metadata reaches the backend', async () => {
    const { client, calls } = stub();
    const meta = await withWorksheet(client, { userId: 'u1', file: file() }, async (w) => w);
    expect(calls[0]).toMatchObject({ kind: 'upload', bucket: FERIA_WORKSHEET_BUCKET });
    expect(calls[0].path).toMatch(/^u1\/[0-9a-f-]+\.pdf$/);
    expect(meta).toMatchObject({ file_name: 'planilla.pdf', content_type: 'application/pdf', byte_size: 10 });
    expect(FERIA_WORKSHEET_BUCKET).not.toBe('purchase-attachments');
  });

  it('MIME and size are validated before any request', async () => {
    const { client, calls } = stub();
    await expect(withWorksheet(client, { userId: 'u', file: file('text/plain') }, async () => 1)).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_NOT_ALLOWED' });
    await expect(withWorksheet(client, { userId: 'u', file: file('image/png', 10 * 1024 * 1024 + 1) }, async () => 1)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
    expect(calls).toEqual([]);
  });

  it('compensation: a failed backend close deletes the uploaded file and rethrows the ORIGINAL error', async () => {
    const { client, calls } = stub();
    const original = new TargetDbError('SESSION_ALREADY_CLOSED', '');
    await expect(withWorksheet(client, { userId: 'u', file: file() }, async () => { throw original; })).rejects.toBe(original);
    expect(calls.map((c) => c.kind)).toEqual(['upload', 'remove']);
    expect(calls[1].path).toBe(calls[0].path);
  });

  it('a failed cleanup is reported (object key only) and never replaces the original error', async () => {
    const { client } = stub([], { remove: { message: 'boom' } });
    const reported: string[][] = [];
    const original = new TargetDbError('PERIOD_CLOSED', '');
    await expect(withWorksheet(client, { userId: 'u', file: file(), onCleanupFailure: (p) => reported.push(p) }, async () => { throw original; })).rejects.toBe(original);
    expect(reported).toHaveLength(1);
  });

  it('a failed upload stops before the backend call', async () => {
    const { client } = stub([], { upload: { message: 'denied' } });
    let called = false;
    await expect(withWorksheet(client, { userId: 'u', file: file() }, async () => { called = true; })).rejects.toMatchObject({ code: 'WORKSHEET_UPLOAD_FAILED' });
    expect(called).toBe(false);
  });

  it('access is a short-lived signed URL (no public URL)', async () => {
    const { client, calls } = stub();
    expect(await worksheetSignedUrl(client, 'u/x.pdf')).toBe('https://local/signed');
    expect(calls[0]).toMatchObject({ kind: 'signed', bucket: FERIA_WORKSHEET_BUCKET });
    const src = readFileSync(resolve(__dirname, '../../src/target/feriaWorksheet.ts'), 'utf8');
    expect(src).not.toMatch(/getPublicUrl/);
  });
});

describe('ADR-016 Feria UI', () => {
  const ui = readFileSync(resolve(__dirname, '../../src/features/feria/FeriaApp.tsx'), 'utf8');
  it('no authoritative arithmetic in React: expected cash / difference / total come from the backend', () => {
    expect(ui).not.toMatch(/expected_cash\s*[-+]|counted_cash\s*-|cash_sales\s*\+|n\(efectivo\)\s*[-+]|n\(fondo\)\s*[-+]/);
  });
  it('the granular actions and the product-line closing form are not offered in the primary UI', () => {
    for (const s of ['register_session_movement', 'registerSessionCashEvent', 'Conteo de caja', 'closeSalesSession', 'MovimientoModal', 'CajaModal', 'ProductoSelect']) {
      expect(ui).not.toContain(s);
    }
    expect(ui).toContain('Cierre de Feria');
    expect(ui).toContain('Más datos');
  });
});
