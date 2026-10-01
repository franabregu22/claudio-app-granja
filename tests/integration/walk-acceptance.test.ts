/**
 * Phase 27 acceptance fixes (owner walkthrough D-WALK-2 / 4 / 5 / 7) through the frontend data layer against the
 * guarded LOCAL stack only (127.0.0.1, local demo keys read from the running container):
 *   - transfer history from financial_operation / financial_posting, with the related bank tax (ADR-011);
 *   - transfer + tax, partial success and a retry that never repeats the transfer;
 *   - a purchase without attachments (ADR-010) and its rectification with the default line.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npx vitest run tests/integration/walk-acceptance.test.ts
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { TargetDbError } from '../../src/target/db';
import { createPurchaseWithAttachments } from '../../src/target/attachments';
import { createMaster } from '../../src/target/masters';
import {
  listBankTaxPeriods, listLedgerBalances, listPurchases, listTransfers, rectifyPurchase, registerBankTax, transferWithBankTax,
} from '../../src/target/treasury';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

function localKeys(): { anon: string; service: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_edge_runtime', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
    .trim().split('\n')[0];
  if (!c) throw new Error('local edge-runtime container not running');
  const env = (spawnSync('docker', ['inspect', c, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/);
  const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  const keys = { anon: get('SUPABASE_ANON_KEY'), service: get('SUPABASE_SERVICE_ROLE_KEY') };
  for (const [want, jwt] of [['anon', keys.anon], ['service_role', keys.service]] as const) {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
    if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
  }
  return keys;
}
function owner(sql: string): string {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
}

const keys = localKeys();
const service = createClient(LOCAL_URL, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const TAG = `WALK-${run}`;
const password = `Walk-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `walk-admin-${run}@example.invalid` },
  OPERATOR: { email: `walk-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const fx = { a: '', b: '', mp: '', supplierId: '', categoryId: '', day: '' };
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const ref = (s: string) => `${TAG}-${s}`;
const balance = async (id: string) => (await listLedgerBalances(admin(), 'ACCOUNT')).find((b) => b.entity_id === id)?.balance ?? 0;
const opsWithRef = (r: string) => owner(`SELECT count(*) FROM financial_operation WHERE external_ref = '${r}';`);

const TS = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const TA = `(SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _p AS SELECT id FROM purchases WHERE supplier_id IN ${TS};
CREATE TEMP TABLE _o AS
  SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%'
  UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN ${TA};
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM _p UNION SELECT id::TEXT FROM _o);
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchases WHERE id IN (SELECT id FROM _p);
DELETE FROM bank_tax_charge WHERE financial_operation_id IN (SELECT id FROM _o) OR related_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM supplier_ledger WHERE reversal_of_id IS NOT NULL AND supplier_id IN ${TS};
DELETE FROM supplier_ledger WHERE supplier_id IN ${TS};
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';`);
}

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  fx.a = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} Banco A`, account_type: 'BANK_ACCOUNT' })).id;
  fx.b = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} Banco B`, account_type: 'BANK_ACCOUNT' })).id;
  fx.mp = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' LIMIT 1;`);
  fx.supplierId = (await createMaster<{ id: string }>(admin(), 'suppliers', { nombre: `${TAG} proveedor` })).id;
  fx.categoryId = (await createMaster<{ id: string }>(admin(), 'expense_category', { nombre: `${TAG} gastos`, pnl_cost_class: 'DIRECT' })).id;
  fx.day = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;`);
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('D-WALK-2 / D-WALK-7 transfer history and related bank tax', () => {
  it('transfer + tax: history shows origin → destination, the amount and the related tax', async () => {
    const r = await transferWithBankTax(admin(), {
      sourceAccountId: fx.a, destAccountId: fx.b, amount: 100000, effectiveDate: fx.day, externalRef: ref('T1'), tax: { accountId: fx.a, amount: 600 },
    });
    expect(r.taxError).toBeNull();
    expect(await balance(fx.a)).toBe(-100600);
    expect(await balance(fx.b)).toBe(100000);
    const row = (await listTransfers(admin())).find((t) => t.id === r.transferOperationId)!;
    expect(row).toMatchObject({ effective_date: fx.day, amount: 100000, origen: { account_id: fx.a, nombre: `${TAG} Banco A` }, destino: { account_id: fx.b } });
    expect(row.impuestos.map((i) => i.amount)).toEqual([600]);
  });

  it('a transfer without tax shows no tax line', async () => {
    const r = await transferWithBankTax(admin(), { sourceAccountId: fx.b, destAccountId: fx.a, amount: 50, effectiveDate: fx.day, externalRef: ref('T2'), tax: null });
    const row = (await listTransfers(admin())).find((t) => t.id === r.transferOperationId)!;
    expect(row.impuestos).toEqual([]);
    expect(row.origen?.account_id).toBe(fx.b);
  });

  it('tax failure after the transfer = partial success; the retry registers only the tax', async () => {
    const first = await transferWithBankTax(admin(), {
      sourceAccountId: fx.a, destAccountId: fx.b, amount: 1000, effectiveDate: fx.day, externalRef: ref('T3'), tax: { accountId: fx.mp, amount: 6 },
    });
    expect(code(first.taxError)).toBe('MP_ACCOUNT_NOT_ALLOWED');
    expect(opsWithRef(ref('T3'))).toBe('1');
    const retry = await transferWithBankTax(admin(), {
      sourceAccountId: fx.a, destAccountId: fx.b, amount: 1000, effectiveDate: fx.day, externalRef: ref('T3'),
      transferOperationId: first.transferOperationId, tax: { accountId: fx.a, amount: 6 },
    });
    expect(retry).toEqual({ transferOperationId: first.transferOperationId, taxError: null });
    expect(opsWithRef(ref('T3'))).toBe('1');
    const again = await transferWithBankTax(admin(), {
      sourceAccountId: fx.a, destAccountId: fx.b, amount: 1000, effectiveDate: fx.day, externalRef: ref('T3'),
      transferOperationId: first.transferOperationId, tax: { accountId: fx.a, amount: 6 },
    });
    expect(again.taxError).toBeNull();   // exact replay of the tax is idempotent
    expect(opsWithRef(ref('T3-IDC'))).toBe('1');
    const row = (await listTransfers(admin())).find((t) => t.id === first.transferOperationId)!;
    expect(row.impuestos.map((i) => i.amount)).toEqual([6]);
  });

  it('report_bank_tax_period shows the amount paid; OPERATOR reads nothing and cannot register', async () => {
    const rows = (await listBankTaxPeriods(admin())).filter((p) => p.financial_account_id === fx.a);
    expect(rows.map((p) => [p.tax_kind, p.amount_paid])).toEqual([['DEBITOS_CREDITOS', 606]]);
    expect(await listTransfers(operator())).toEqual([]);
    expect(await listBankTaxPeriods(operator())).toEqual([]);
    const denied = await registerBankTax(operator(), { accountId: fx.a, amount: 1, effectiveDate: fx.day, externalRef: ref('OP') }).catch((e) => e);
    expect(code(denied)).toBe('FORBIDDEN');
  });
});

describe('D-WALK-4 / D-WALK-5 purchase without attachments or items', () => {
  it('registers with zero files and zero lines, then rectifies with the default line', async () => {
    const r = await createPurchaseWithAttachments(admin(), {
      userId: users.ADMIN.id!, files: [], supplierId: fx.supplierId, economicDate: fx.day, amountNet: 5000, amountTotal: 5000, categoryId: fx.categoryId,
      nature: 'OPERATING', lines: [], idempotencyKey: ref('P1'),
    });
    expect(r).toMatchObject({ attachment_count: 0, line_count: 0 });
    const rect = await rectifyPurchase(admin(), {
      purchaseId: r.purchase_id, amountNet: 4500, amountTotal: 4500, reason: 'corrección',
      lines: [{ producto_id: null, feed_ingredient_id: null, descripcion: 'Compra', cantidad: 1, unit_type: 'UNIT', precio_unitario: 4500 }],
    });
    const current = (await listPurchases(admin())).find((p) => p.id === rect.new_purchase_id)!;
    expect(current).toMatchObject({ amount_total: 4500 });
    expect(current.lineas.map((l) => [l.descripcion, l.cantidad, l.subtotal])).toEqual([['Compra', 1, 4500]]);
  });
});
