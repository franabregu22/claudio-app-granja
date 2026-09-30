import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulesFor } from '../../src/target/roles';
import * as mp from '../../src/target/mp';

const ROOT = resolve(__dirname, '../..');
const SRC = resolve(ROOT, 'src');
const CONTRACT_MD = readFileSync(resolve(ROOT, '.planning/implementation-design/ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1.md'), 'utf8');
const C = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(CONTRACT_MD.replace(/\r\n/g, '\n'))![1]);

/** PostgREST-shaped stub recording every read (view / table, columns, filters) and rpc. */
function stub() {
  const calls: { kind: string; rel?: string; columns?: string; filters: unknown[]; fn?: string; args?: any }[] = [];
  const client = {
    from(rel: string) {
      const c = { kind: 'select', rel, columns: '', filters: [] as unknown[] };
      const q: any = {
        select: (cols: string) => { c.columns = cols; return q; },
        eq: (...a: unknown[]) => { c.filters.push(['eq', ...a]); return q; }, is: (...a: unknown[]) => { c.filters.push(['is', ...a]); return q; },
        gte: (...a: unknown[]) => { c.filters.push(['gte', ...a]); return q; }, lte: (...a: unknown[]) => { c.filters.push(['lte', ...a]); return q; },
        order: () => q, limit: () => q,
        then: (res: (v: unknown) => void) => { calls.push(c); res({ data: [], error: null }); },
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { calls.push({ kind: 'rpc', fn, args, filters: [] }); return { data: {}, error: null }; },
  };
  return { client: client as never, calls };
}
const cols = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean).sort();

describe('F27-H follows the Step-14 machine-readable contract (§10)', () => {
  it('labels are exactly the contract labels (axis A, review reasons, axis B)', () => {
    expect(mp.AXIS_A_LABELS).toEqual(C.axis_a_labels);
    expect(mp.REVIEW_REASON_LABELS).toEqual(C.review_reason_labels);
    expect(mp.AXIS_B_LABELS).toEqual(C.axis_b_labels);
    expect(mp.AXIS_B_LABELS.CLIENT_UNASSIGNED).toBe('Sin cliente asignado');
    expect(Object.values(mp.AXIS_B_LABELS).join(' ')).not.toMatch(/pendiente|conciliado|sin conciliar|error/i);
  });

  it('every state read uses its view with exactly the contract field list', async () => {
    const { client, calls } = stub();
    await mp.listReceipts(client, { from: '2026-11-01', to: '2026-11-30', axisA: 'REVIEW_REQUIRED', axisB: null });
    await mp.getReceipt(client, 7);
    await mp.getDeliveryHealth(client);
    await mp.listReportExceptions(client);
    const reads = calls.map((c) => [c.rel, cols(c.columns)]);
    expect(reads).toEqual([
      ['report_mp_receipt_status', [...C.reads['S-A'].fields].sort()],
      ['report_mp_receipt_status', [...C.reads['S-B'].fields].sort()],
      ['report_mp_report_exceptions', [...C.reads['S-B-exceptions'].fields].sort()],
      ['report_mp_delivery_health', [...C.reads['S-E'].fields].sort()],
      ['report_mp_report_exceptions', [...C.reads['S-F'].fields].sort()],
    ]);
    expect(calls.every((c) => C.state_sources.includes(c.rel))).toBe(true);
    expect(calls[0].filters).toEqual([['gte', 'occurred_date', '2026-11-01'], ['lte', 'occurred_date', '2026-11-30'], ['eq', 'axis_a_state', 'REVIEW_REQUIRED']]);
  });

  it('the three lookups use exactly the §5a predicate and allow-listed columns', async () => {
    const { client, calls } = stub();
    await mp.lookupAllocations(client, 42);
    await mp.lookupActiveMappings(client);
    await mp.lookupChargebackSignals(client);
    const byId = Object.fromEntries(C.lookups.map((l: any) => [l.table, l]));
    for (const c of calls) {
      const l = byId[c.rel!];
      expect(l, c.rel).toBeTruthy();
      expect(cols(c.columns)).toEqual([...l.columns].sort());
      const expected = Object.entries(l.predicate).map(([k, v]) => (v === null ? ['is', k, null] : ['eq', k, v === ':selected_receipt' ? 42 : v]));
      expect(c.filters).toEqual(expected);
    }
    expect(calls.map((c) => c.rel)).toEqual(['mp_client_allocation', 'mp_payer_client_map', 'mp_webhook_delivery']);
  });

  it('every active action calls its authorized RPC with exactly the contract argument names; R2 has no call', async () => {
    const { client, calls } = stub();
    const k = mp.uiIdempotencyKey('u');
    await mp.allocateToClient(client, { movementId: 1, clienteId: 'c', amount: 1, effectiveDate: 'd', idempotencyKey: k, reason: 'r' });
    await mp.reverseAllocation(client, { allocationId: 'a', amount: 1, idempotencyKey: k, reason: 'r' });
    await mp.flagForAttribution(client, { movementId: 1, reason: 'r' });
    await mp.clearAttributionFlag(client, { flagId: 'f', reason: 'r' });
    await mp.mapPayerToClient(client, { payerId: '1', clienteId: 'c', reason: 'r' });
    await mp.unmapPayer(client, { mappingId: 'm', reason: 'r' });
    await mp.resolveMatch(client, { matchId: 'x', resolution: 'EXPLAINED', reason: 'r' });
    await mp.requeueConfigBlocked(client, { reason: 'r' });
    await mp.requestRefetch(client, { paymentId: '1', reason: 'r' });
    await mp.resolveChargebackSignal(client, { deliveryId: 'd', resolution: 'DISMISSED', paymentId: '9', reason: 'r' });
    const active = C.actions.filter((a: any) => a.availability === 'ACTIVE');
    expect(calls.map((c) => c.fn)).toEqual(active.map((a: any) => a.rpc));
    for (const c of calls) {
      const a = active.find((x: any) => x.rpc === c.fn);
      const names = a.args.split(',').map((s: string) => s.trim().split(' ')[0]);
      expect(Object.keys(c.args).sort(), c.fn).toEqual(names.sort());
    }
    expect(k).toBe('ui:u');
    expect(calls.at(-1)!.args.p_payment_id).toBeNull();   // DISMISSED links no payment
    expect(C.actions.find((a: any) => a.id === 'R2').availability).toBe(mp.R2_AVAILABILITY);
    expect(Object.values(mp).some((v) => typeof v === 'function' && /mp_normalize_report_fallback/.test(String(v)))).toBe(false);
  });

  it('C1 availability mirrors §5 (POSTED / REPORT_CONFIRMED); CLIENT_UNASSIGNED never makes a work item', () => {
    expect(['NORMALIZED', 'POSTED', 'REPORT_CONFIRMED', 'REVIEW_REQUIRED'].filter((a) => mp.canAllocate({ axis_a_state: a }))).toEqual(['POSTED', 'REPORT_CONFIRMED']);
    const workItemAxisB = C.work_items.filter((w: any) => w.where.axis_b_state).map((w: any) => w.where.axis_b_state);
    expect(workItemAxisB).toEqual(['CLIENT_RESOLUTION_REQUESTED']);
  });

  it('Mercado Pago is an ADMIN module only', () => {
    expect(modulesFor('ADMIN')).toContain('mercadopago');
    expect(modulesFor('OPERATOR')).not.toContain('mercadopago');
  });
});

describe('F27-H: no legacy MP path survives in src/', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(resolve(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [resolve(dir, e.name)] : []));
  // code only: comments may name forbidden things to document that they are forbidden
  const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // src/target/db.ts is the registry of allowed relations (report_mp_movement_status stays registered for use outside
  // the MP screens, plan §5), not a read: it is checked separately below
  const all = files(SRC).filter((f) => !/target[\\/]db\.ts$/.test(f)).map((f) => [f, code(readFileSync(f, 'utf8'))] as const);
  const MP_FILES = all.filter(([f]) => /features[\\/]mercadopago|target[\\/]mp\.ts/.test(f));

  it('the legacy MP frontend files are gone', () => {
    for (const f of ['api/mercadopago.ts', 'api/mercadopago-monthly.ts', 'features/mercadopago/UnclassifiedMovements.tsx', 'features/mercadopago/MonthlyReport.tsx',
      'features/mercadopago/MovementsTable.tsx', 'features/mercadopago/SummaryCards.tsx', 'features/mercadopago/DateFilter.tsx', 'features/mercadopago/TypeFilter.tsx']) {
      expect(existsSync(resolve(SRC, f)), f).toBe(false);
    }
  });

  it('no src file reaches a legacy MP table, a sync / debug path, a service-only or forbidden RPC', () => {
    for (const [f, t] of all) {
      expect(t, f).not.toMatch(/['"`](ledger_entry|account_balance|mp_financial_movement|mercadopago_raw|mercadopago_movements|sync_metadata|report_mp_movement_status)['"`]/);
      expect(t, f).not.toMatch(/sync-mercadopago|sync-settlement|\/\.netlify\/functions|MercadoPagoDebug|useMercadoPago|api\.mercadopago\.com/);
      for (const rpc of C.forbidden_rpcs.filter((r: string) => r !== 'register_collection')) expect(t, f).not.toMatch(new RegExp(`['"\`]${rpc}['"\`]`));
    }
  });

  it('the registry lists no legacy MP table', () => {
    const db = readFileSync(resolve(SRC, 'target/db.ts'), 'utf8');
    expect(db).not.toMatch(/['"`](ledger_entry|account_balance|mp_financial_movement|mercadopago_raw|mercadopago_movements|sync_metadata)['"`]/);
  });

  it('the MP screens compute no state or amount, never register a collection and write no MP table directly', () => {
    for (const [f, t] of MP_FILES) {
      expect(t, f).not.toMatch(/register_collection|registerCollection|useRegisterCollection/);
      expect(t, f).not.toMatch(/(?<!Array)\.from\(/);
      expect(t, f).not.toMatch(/\.(insert|update|delete|upsert)\(/);
      expect(t, f).not.toMatch(/\.reduce\(|effective_applied_receipt\s*-|pendiente de identificar/i);
      expect(t, f).not.toMatch(/notification_payload|notification_sha256|delivery_key|x_request_id|claim_token/);
    }
  });
});
