/**
 * 0113 / 0116 — Caja → Movimientos: the unified list (data layer and screen). The server pages, counts and filters (period, account,
 * kind, search, Por resolver); the screen reads, and money moves only through the existing routes of a row's action.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS } from '../../src/target/db';
import {
  listMovements, movementAccounts, movementAmount, MOVEMENT_KIND_LABEL, movementNote, movementSign, parseAmountSearch, pendingHasScope, pendingMpSource,
  PENDING_FILTER_REQUIRED, rowKey, rowStatusLabel, rowStatusTone,
} from '../../src/target/movementHistory';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const MIG = readFileSync(resolve(__dirname, '../../supabase/target-migrations/0113_fin_movement_history.sql'), 'utf8');
const MIG16 = readFileSync(resolve(__dirname, '../../supabase/target-migrations/0116_caja_movements_transfers.sql'), 'utf8');
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

describe('0113 / 0116 — how a row reads', () => {
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
    expect(SRC('features/caja/MovimientosHistoricos.tsx')).toMatch(/r\.reason \? dato\('Motivo', r\.reason\)/);
  });
  it('the state: a transfer reads registered / pending link / reconciled; what needs someone is amber, what is reconciled green', () => {
    expect(rowStatusLabel({ kind: 'TRANSFERENCIA', status: 'SIN_CONCILIAR' })).toBe('Pendiente de vinculación');
    expect(rowStatusLabel({ kind: 'TRANSFERENCIA', status: 'CONCILIADO' })).toBe('Conciliada');
    expect(rowStatusLabel({ kind: 'TRANSFERENCIA', status: 'REGISTRADO' })).toBe('Registrada');
    expect(rowStatusLabel({ kind: 'PAGO', status: 'SIN_CONCILIAR' })).toBe('Sin conciliar');
    expect(rowStatusLabel({ kind: 'SIN_VINCULAR', status: 'SIN_VINCULAR' })).toBe('Sin vincular');
    for (const s of ['PENDIENTE_CLASIFICAR', 'SIN_CLASIFICAR', 'SIN_CONCILIAR', 'SIN_VINCULAR'] as const) expect(rowStatusTone(s)).toBe('action');
    expect(rowStatusTone('CONCILIADO')).toBe('done');
    expect(rowStatusTone('REGISTRADO')).toBe('neutral');
  });
  it('an operation and a bank line never share a key (one row each, even with the same number)', () => {
    expect(rowKey({ row_type: 'OP', operation_id: 7 } as never)).toBe('op:7');
    expect(rowKey({ row_type: 'LINE', statement_line_id: 7 } as never)).toBe('line:7');
  });
  it('a provisional Mercado Pago outflow carries its SOURCE_ID, so its classification is reachable without the filter', () => {
    expect(pendingMpSource({ kind: 'PENDIENTE_MP', external_ref: 'MP-PENDING:186516120301' })).toBe('186516120301');
    expect(pendingMpSource({ kind: 'PENDIENTE_MP', external_ref: 'MP-PENDING-RELEASE:1' })).toBeNull();
    expect(pendingMpSource({ kind: 'PAGO', external_ref: 'MP-PENDING:1' })).toBeNull();
  });
  it('Por resolver: two need action, inflows are optional; only Mercado Pago pendings and inflows have current / historical', () => {
    expect(PENDING_FILTER_REQUIRED).toEqual({ MP_CLASIFICAR: true, GASTO_SIN_CLASIFICAR: true, ENTRADA_SIN_VINCULAR: false });
    expect([pendingHasScope('MP_CLASIFICAR'), pendingHasScope('GASTO_SIN_CLASIFICAR'), pendingHasScope('ENTRADA_SIN_VINCULAR')]).toEqual([true, false, true]);
  });
});

describe('0116 — the request', () => {
  it('the page is an offset of the server; numbers arrive as numbers; lines and operations come apart', async () => {
    const { client, seen } = stub({ total: '120', lines_total: '3', rows: [
      { row_type: 'OP', operation_id: 7, net_amount: '-10.50', moved_amount: '10.50', postings: [{ ...P('BNA', 0), signed_amount: '-10.50' }], status: 'CONCILIADO',
        bank: [{ statement_line_id: 9, signed_amount: '-10.50', running_balance: '99.00' }], mp: [], pending: null, related_taxes: null, transfer_intent: null },
      { row_type: 'LINE', statement_line_id: 4, signed_amount: '-5.00', running_balance: null, status: 'SIN_VINCULAR' },
    ] });
    const r = await listMovements(client, {}, 3);
    expect(seen[0].url).toContain('/rpc/fin_movement_list');
    expect(seen[0].args).toEqual({ p_from: null, p_to: null, p_account_id: null, p_kind: null, p_search: null, p_amount: null, p_pending: null, p_scope: null, p_limit: 50, p_offset: 150 });
    expect([r.total, r.linesTotal]).toEqual([120, 3]);
    const op = r.rows[0];
    const ln = r.rows[1];
    if (op.row_type !== 'OP' || ln.row_type !== 'LINE') throw new Error('row types');
    expect([op.net_amount, op.postings[0].signed_amount, op.bank[0].signed_amount, op.bank[0].running_balance]).toEqual([-10.5, -10.5, -10.5, 99]);
    expect([ln.signed_amount, ln.running_balance]).toEqual([-5, null]);
  });
  it('every filter travels; a number in the search also travels as an amount; the scope only with a filter that has one', async () => {
    const { client, seen } = stub({ total: 0, lines_total: 0, rows: [] });
    await listMovements(client, { from: '2026-10-01', to: '2026-10-31', accountId: 'a', kind: 'PAGO', search: ' 1.234,50 ' });
    expect(seen[0].args).toMatchObject({ p_from: '2026-10-01', p_to: '2026-10-31', p_account_id: 'a', p_kind: 'PAGO', p_search: '1.234,50', p_amount: 1234.5, p_offset: 0 });
    await listMovements(client, { search: 'gasoil' });
    expect(seen[1].args).toMatchObject({ p_search: 'gasoil', p_amount: null });
    await listMovements(client, { pending: 'ENTRADA_SIN_VINCULAR', scope: 'CURRENT' });
    expect(seen[2].args).toMatchObject({ p_pending: 'ENTRADA_SIN_VINCULAR', p_scope: 'CURRENT' });
    await listMovements(client, { pending: 'GASTO_SIN_CLASIFICAR', scope: 'CURRENT' });
    expect(seen[3].args).toMatchObject({ p_pending: 'GASTO_SIN_CLASIFICAR', p_scope: null });
  });
  it('the RPC is in the contract list and the kinds are the ones the server accepts', () => {
    expect(TARGET_RPCS).toContain('fin_movement_list');
    for (const k of Object.keys(MOVEMENT_KIND_LABEL)) expect(MIG16).toMatch(new RegExp(`p_kind NOT IN \\(.*'${k}'`));
  });
});

describe('0116 — the screen', () => {
  const h = SRC('features/caja/MovimientosHistoricos.tsx');
  const m = SRC('features/caja/Movimientos.tsx');
  it('one list under Por resolver, titled "Movimientos históricos"; the cards and indicators filter it, no secondary list', () => {
    expect(m.indexOf('<TarjetasPorResolver')).toBeLessThan(m.indexOf('<MovimientosHistoricos'));
    expect(h).toContain('>Movimientos históricos<');
    expect(h).not.toContain('Historial financiero');
    expect(m).not.toMatch(/PanelResolver|CuentaDetalle|HistorialFinanciero/);
    expect(m).toMatch(/<TarjetasPorResolver activo=\{pendiente\} onFiltro=\{setPendiente\} \/>/);
    expect(m).toContain('Todas las cuentas');
  });
  it('period, account, kind, search and the Por resolver filter go to the server; any change returns to the first page', () => {
    for (const s of ['type="date"', 'Cuenta', 'Tipo', 'Buscar']) expect(h).toContain(s);
    expect(h).toMatch(/useMovementList\(filtro, pagina\)/);
    expect(h).toMatch(/const pagina = pag\.firma === firma \? pag\.n : 0;/);
    expect(h).toMatch(/<Paginador pagina=\{pagina\}/);
    expect(h).not.toMatch(/\.filter\(\(r\) =>|\.sort\(/);
  });
  it('the list itself writes nothing; a row action is an existing route (classify, link), and the detail shows the accounts and the evidence', () => {
    expect(h).not.toMatch(/\.mutate\(|useMutation|\.rpc\(|callRpc/);
    expect(h).toContain('Cuentas involucradas');
    expect(h).toMatch(/r\.postings\.map/);
    expect(h).toMatch(/<AccionPendienteMp sourceId=\{fuenteMp\} \/>/);
    expect(h).toMatch(/<AccionGastoSinClasificar pendingId=\{r\.pending\.pending_id\} \/>/);
    expect(h).toMatch(/<AccionEntrada movementId=\{r\.pending\.movement_id\} \/>/);
  });
  it('the query lives under the treasury key, so a registered operation (and a match) refreshes it', () => {
    expect(SRC('features/caja/useTreasury.ts')).toMatch(/queryKey: \['treasury', 'movement-list', filter, page\]/);
    expect(SRC('features/caja/useReconciliation.ts')).toMatch(/match: useMutation\([\s\S]*?\[ROOT, \['treasury'\]\]/);
  });
});

describe('0113 — the migration (unchanged; the published frontend still reads it)', () => {
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

describe('0116 — the migration', () => {
  const body = MIG16.replace(/^--.*$/gm, '');
  const fn = (name: string) => body.slice(body.indexOf(`CREATE FUNCTION ${name}(`), body.indexOf('$$;', body.indexOf(`CREATE FUNCTION ${name}(`)));
  it('fin_movement_list: STABLE, ADMIN first, bounded page, a stable order (date, operations before lines, id)', () => {
    const f = fn('fin_movement_list');
    expect(f).toMatch(/^\s*STABLE$/m);
    expect(f.indexOf("current_app_role() IS DISTINCT FROM 'ADMIN'")).toBeLessThan(f.indexOf('p_limit IS NULL'));
    expect(f).toMatch(/p_limit NOT BETWEEN 1 AND 100/);
    expect(f).toMatch(/ORDER BY d DESC, \(t = 'OP'\) DESC, id DESC LIMIT p_limit OFFSET p_offset/);
    expect(f).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });
  it('the lines to resolve are after the active cut, unmatched and not settled before the cut (shown once)', () => {
    const f = fn('fin_movement_list');
    expect(f).toMatch(/NOT EXISTS \(SELECT 1 FROM fin_statement_match m WHERE m\.statement_line_id = l\.id AND m\.reversed_at IS NULL\)/);
    expect(f).toMatch(/NOT EXISTS \(SELECT 1 FROM fin_instrument_precut_debit d WHERE d\.statement_line_id = l\.id\)/);
    expect(f).toMatch(/fin_statement_line_cut_class\(l\.id\) = 'POST_CUTOVER'/);
  });
  it('every new RPC: ADMIN only, EXECUTE for authenticated only; the helpers have no API EXECUTE', () => {
    for (const [name, args] of [['fin_movement_list', 'DATE, DATE, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER'], ['fin_register_transfer_intent', 'UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT'],
      ['fin_link_transfer_intent', 'BIGINT, TEXT, BIGINT'], ['fin_cancel_transfer_intent', 'BIGINT, TEXT'], ['fin_relate_bank_tax', 'BIGINT, BIGINT, TEXT']] as const) {
      expect(fn(name)).toContain("IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN");
      expect(body).toContain(`REVOKE ALL     ON FUNCTION ${name}(${args}) FROM PUBLIC, anon, service_role;`);
      expect(body).toContain(`GRANT  EXECUTE ON FUNCTION ${name}(${args}) TO authenticated;`);
    }
    for (const helper of ['fin_transfer_intent_route(UUID, UUID)', 'fin_statement_recorded_charges(BIGINT, TEXT)']) {
      expect(body).toContain(`REVOKE ALL ON FUNCTION ${helper} FROM PUBLIC, anon, authenticated, service_role;`);
    }
  });
});
