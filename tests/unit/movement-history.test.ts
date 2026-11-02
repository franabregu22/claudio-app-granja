/** 0113 — Caja → Movimientos: the unified history (data layer and screen). The server pages, counts and filters; the screen only reads. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS } from '../../src/target/db';
import {
  listMovementHistory, movementAccounts, movementAmount, MOVEMENT_KIND_LABEL, movementNote, movementSign, parseAmountSearch,
} from '../../src/target/movementHistory';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const MIG = readFileSync(resolve(__dirname, '../../supabase/target-migrations/0113_fin_movement_history.sql'), 'utf8');
function stub(body: unknown) {
  const seen: { url: string; args: Record<string, unknown> }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), args: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}
const P = (nombre: string, s: number) => ({ posting_id: 1, account_id: nombre, account_name: nombre, signed_amount: s });

describe('0113 — amount in the search box', () => {
  it.each([['1234', 1234], ['1234,5', 1234.5], ['1234,50', 1234.5], ['1234.50', 1234.5], ['1.234', 1234], ['1.234,50', 1234.5], ['$ 1.234.567,89', 1234567.89], ['12.5', 12.5]])('%s → %d', (t, n) => {
    expect(parseAmountSearch(t)).toBe(n);
  });
  it.each(['', 'gasoil', 'MP-PENDING:12', '12-34', '1.23.4', '1,234,5', '0', '-500'])('%s is not an amount', (t) => {
    expect(parseAmountSearch(t)).toBeNull();
  });
});

describe('0113 — how a row reads', () => {
  it('a transfer seen from all the accounts has no sign and shows what it moved', () => {
    const t = { net_amount: 0, moved_amount: 5000 };
    expect(movementSign(t)).toBe('NEUTRAL');
    expect(movementAmount(t)).toMatch(/^\$\s?5\.000,00$/);
  });
  it('seen from one account it is signed, and an ordinary movement shows its amount', () => {
    expect(movementSign({ net_amount: -5000 })).toBe('OUT');
    expect(movementSign({ net_amount: 300 })).toBe('IN');
    expect(movementAmount({ net_amount: -700.5, moved_amount: 700.5 })).toMatch(/^−\$\s?700,50$/);   // to the cent, never rounded
    expect(movementAmount({ net_amount: 0.06, moved_amount: 0.06 })).toMatch(/^\+\$\s?0,06$/);
  });
  it('names the accounts: the money leaves first; one account is just its name', () => {
    expect(movementAccounts({ postings: [P('BNA', 500), P('Caja chica', -500)] })).toBe('Caja chica → BNA');
    expect(movementAccounts({ postings: [P('BNA', -30)] })).toBe('BNA');
  });
  it('a technical trace is not a note; the detail still shows it', () => {
    expect(movementNote({ reason: 'ADR-018 auto-apply' })).toBeNull();
    expect(movementNote({ reason: 'phase31 opening P31-T2' })).toBeNull();
    expect(movementNote({ reason: 'Depósito del lunes' })).toBe('Depósito del lunes');
    expect(movementNote({ reason: null })).toBeNull();
    expect(SRC('features/caja/HistorialFinanciero.tsx')).toMatch(/r\.reason \? dato\('Motivo', r\.reason\)/);
  });
});

describe('0113 — the request', () => {
  it('the page is an offset of the server; numbers arrive as numbers', async () => {
    const { client, seen } = stub({ total: '120', rows: [{ operation_id: 7, net_amount: '-10.50', moved_amount: '10.50', postings: [{ ...P('BNA', 0), signed_amount: '-10.50' }] }] });
    const r = await listMovementHistory(client, {}, 3);
    expect(seen[0].url).toContain('/rpc/fin_movement_history');
    expect(seen[0].args).toEqual({ p_from: null, p_to: null, p_account_id: null, p_kind: null, p_search: null, p_amount: null, p_limit: 50, p_offset: 150 });
    expect(r.total).toBe(120);
    expect(r.rows[0].net_amount).toBe(-10.5);
    expect(r.rows[0].postings[0].signed_amount).toBe(-10.5);
  });
  it('every filter travels; a number in the search also travels as an amount, a text does not', async () => {
    const { client, seen } = stub({ total: 0, rows: [] });
    await listMovementHistory(client, { from: '2026-10-01', to: '2026-10-31', accountId: 'a', kind: 'PAGO', search: ' 1.234,50 ' });
    expect(seen[0].args).toMatchObject({ p_from: '2026-10-01', p_to: '2026-10-31', p_account_id: 'a', p_kind: 'PAGO', p_search: '1.234,50', p_amount: 1234.5, p_offset: 0 });
    await listMovementHistory(client, { search: 'gasoil' });
    expect(seen[1].args).toMatchObject({ p_search: 'gasoil', p_amount: null });
  });
  it('the RPC is in the contract list and the kinds are the ones the server accepts', () => {
    expect(TARGET_RPCS).toContain('fin_movement_history');
    for (const k of Object.keys(MOVEMENT_KIND_LABEL)) expect(MIG).toMatch(new RegExp(`p_kind NOT IN \\(.*'${k}'`));
  });
});

describe('0113 — the screen', () => {
  const h = SRC('features/caja/HistorialFinanciero.tsx');
  const m = SRC('features/caja/Movimientos.tsx');
  it('sits under Por resolver, without removing the account detail or the lists', () => {
    expect(m.indexOf('<TarjetasPorResolver')).toBeLessThan(m.indexOf('<HistorialFinanciero'));
    expect(m).toMatch(/<PanelResolver panel=\{panel\}/);
    expect(m).toMatch(/<CuentaDetalle key=\{c\.id\}/);
  });
  it('period, account, kind and search go to the server; a filter returns to the first page', () => {
    for (const s of ['type="date"', 'Cuenta', 'Tipo', 'Buscar']) expect(h).toContain(s);
    expect(h).toMatch(/useMovementHistory\(filtro, pagina\)/);
    expect(h).toMatch(/setPagina\(0\)/);
    expect(h).toMatch(/<Paginador pagina=\{pagina\}/);
    expect(h).not.toMatch(/\.filter\(\(r\) =>|\.sort\(/);
  });
  it('read-only: no mutation from here, and the detail shows the accounts involved', () => {
    expect(h).not.toMatch(/\.mutate\(|useMutation|\.rpc\(|callRpc/);
    expect(h).toContain('Cuentas involucradas');
    expect(h).toMatch(/r\.postings\.map/);
  });
  it('the query lives under the treasury key, so a registered operation refreshes it', () => {
    expect(SRC('features/caja/useTreasury.ts')).toMatch(/queryKey: \['treasury', 'movements', filter, page\]/);
  });
});

describe('0113 — the migration', () => {
  it('adds no table, column, index, trigger or write', () => {
    const body = MIG.replace(/^--.*$/gm, '');
    expect(body).not.toMatch(/\b(CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TRIGGER|INSERT INTO|UPDATE |DELETE FROM)\b/);
    expect(body).toMatch(/^\s*STABLE$/m);
  });
  it('checks ADMIN before anything else; only authenticated may execute it; no mp_ name', () => {
    const body = MIG.replace(/^--.*$/gm, '');
    expect(body.indexOf("current_app_role() IS DISTINCT FROM 'ADMIN'")).toBeLessThan(body.indexOf('p_limit IS NULL'));
    expect(body).toMatch(/REVOKE ALL\s+ON FUNCTION fin_movement_history\(.*\) FROM PUBLIC, anon, service_role;/);
    expect(body).toMatch(/GRANT\s+EXECUTE ON FUNCTION fin_movement_history\(.*\) TO authenticated;/);
    expect(body).not.toMatch(/FUNCTION mp_/);
  });
  it('orders by date and id, and bounds the page', () => {
    expect(MIG).toMatch(/ORDER BY effective_date DESC, id DESC LIMIT p_limit OFFSET p_offset/);
    expect(MIG).toMatch(/p_limit NOT BETWEEN 1 AND 100/);
  });
});
