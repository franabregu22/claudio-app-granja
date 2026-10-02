/**
 * ADR-016 — Feria V1 summarized closing against the guarded LOCAL stack only (RPC 51 / 52, report_feria_closing,
 * pnl_summary.diferencia_caja, private bucket `feria-worksheets` through the real Storage API).
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { TargetDbError } from '../../src/target/db';
import { closeFeriaSummary, listFeriaClosings, openAndCloseFeria, rectifyFeriaClosing } from '../../src/target/feria';
import { FERIA_WORKSHEET_BUCKET, withWorksheet, worksheetSignedUrl } from '../../src/target/feriaWorksheet';
import { createMaster } from '../../src/target/masters';
import { listPnlSummary } from '../../src/target/pnl';

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
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(LOCAL_URL, keys.service, opts);
const anon = createClient(LOCAL_URL, keys.anon, opts);
const run = randomUUID().slice(0, 8);
const TAG = `ADR16-${run}`;
const password = `Adr16-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `adr16-admin-${run}@example.invalid` },
  OPERATOR: { email: `adr16-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const denied = (e: unknown) => e instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED', 'FORBIDDEN'].includes(e.code);
const fx = { cash: '', bank: '', today: '' };
const pdf = (name = 'planilla.pdf') => new File([Buffer.from('%PDF-1.4\n% adr016 test\n')], name, { type: 'application/pdf' }) as never;
const bal = (acc: string) => Number(owner(`SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = '${acc}';`));
const objects = () => Number(owner(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${FERIA_WORKSHEET_BUCKET}' AND name LIKE '${users.ADMIN.id}/%';`));

const TS = `(SELECT id FROM sales_session WHERE location LIKE '${TAG}%')`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _c AS SELECT id FROM sales_session_closing WHERE sales_session_id IN ${TS};
CREATE TEMP TABLE _p AS SELECT id FROM pedidos WHERE sales_session_id IN ${TS};
CREATE TEMP TABLE _col AS SELECT id FROM collections WHERE sales_session_id IN ${TS};
CREATE TEMP TABLE _o AS SELECT id FROM financial_operation
  WHERE (source_entity_type = 'sales_session_closing' AND source_entity_id IN (SELECT id::TEXT FROM _c))
     OR (source_entity_type = 'collections' AND source_entity_id IN (SELECT id::TEXT FROM _col));
DO $$ BEGIN
  WHILE EXISTS (SELECT 1 FROM sales_session_closing WHERE id IN (SELECT id FROM _c)) LOOP
    DELETE FROM sales_session_closing WHERE id IN (SELECT id FROM _c) AND id NOT IN (SELECT supersedes_id FROM sales_session_closing WHERE supersedes_id IS NOT NULL);
  END LOOP;
END $$;
DELETE FROM client_ledger WHERE reversal_of_id IS NOT NULL AND source_entity_type = 'sales_session_closing' AND source_entity_id IN (SELECT id::TEXT FROM _c);
DELETE FROM client_ledger WHERE (source_entity_type = 'collections' AND source_entity_id IN (SELECT id::TEXT FROM _col))
   OR (source_entity_type = 'pedido' AND source_entity_id IN (SELECT id::TEXT FROM _p));
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM collections WHERE id IN (SELECT id FROM _col);
UPDATE sales_session SET aggregated_pedido_id = NULL WHERE id IN ${TS};
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM _p);
DELETE FROM pedidos WHERE id IN (SELECT id FROM _p);
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM _c UNION SELECT id::TEXT FROM _p UNION SELECT id::TEXT FROM _col UNION SELECT id::TEXT FROM ${TS} s);
DELETE FROM sales_session WHERE id IN ${TS};
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';`);
}

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, opts);
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  fx.today = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE::TEXT;`);
  fx.cash = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} caja`, account_type: 'CASH' })).id;
  fx.bank = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} banco`, account_type: 'BANK_ACCOUNT' })).id;
});

afterAll(async () => {
  const names = owner(`SELECT string_agg(name, E'\\n') FROM storage.objects WHERE bucket_id = '${FERIA_WORKSHEET_BUCKET}'
    AND (name LIKE '${users.ADMIN.id}/%' OR name LIKE '${users.OPERATOR.id}/%');`).split('\n').filter(Boolean);
  if (names.length) await service.storage.from(FERIA_WORKSHEET_BUCKET).remove(names);
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('ADR-016 summarized closing through the frontend data layer', () => {
  let closingId = '';
  let sessionId = '';
  let firstPath = '';
  const base = { cashSales: 1000, mpSales: 300, transferSales: 400, expenses: 150, countedCash: 1020, openingFloat: 200 };

  it('ADMIN closes a new Feria with a worksheet: backend-derived values, treasury = counted − float, transfer only to its account', async () => {
    const pnl0 = (await listPnlSummary(admin(), fx.today.slice(0, 8) + '01', fx.today.slice(0, 8) + '01'))[0];
    const res = await withWorksheet(admin(), { userId: users.ADMIN.id!, file: pdf() }, (worksheet) => openAndCloseFeria(admin(), {
      ...base, cashAccountId: fx.cash, transferAccountId: fx.bank, date: fx.today, location: `${TAG} plaza`, idempotencyKey: `${TAG}-K1`, worksheet,
    }));
    expect(res).toMatchObject({ total_sales: 1700, expected_cash: 1050, cash_difference: -30 });
    closingId = res.closing_id;
    const [row] = (await listFeriaClosings(admin(), fx.today, fx.today)).filter((c) => c.closing_id === closingId);
    sessionId = row.sales_session_id;
    firstPath = row.worksheet_path!;
    expect(row).toMatchObject({ total_sales: 1700, expected_cash: 1050, counted_cash: 1020, cash_difference: -30, has_worksheet: true, is_current: true });
    expect(firstPath.startsWith(`${users.ADMIN.id}/`)).toBe(true);
    expect(bal(fx.cash)).toBe(820);   // counted 1020 − float 200
    expect(bal(fx.bank)).toBe(400);
    const pnl1 = (await listPnlSummary(admin(), fx.today.slice(0, 8) + '01', fx.today.slice(0, 8) + '01'))[0];
    expect(Math.round((pnl1.ventas_netas_devengadas - (pnl0?.ventas_netas_devengadas ?? 0)) * 100) / 100).toBe(1700);
    expect(Math.round((pnl1.diferencia_caja - (pnl0?.diferencia_caja ?? 0)) * 100) / 100).toBe(-30);
  });

  it('the worksheet is private: signed URL works for ADMIN; public URL and anon get nothing; OPERATOR cannot download', async () => {
    const url = await worksheetSignedUrl(admin(), firstPath);
    expect((await fetch(url)).status).toBe(200);
    const pub = anon.storage.from(FERIA_WORKSHEET_BUCKET).getPublicUrl(firstPath).data.publicUrl;
    expect((await fetch(pub)).status).not.toBe(200);
    expect((await operator().storage.from(FERIA_WORKSHEET_BUCKET).download(firstPath)).error).toBeTruthy();
    expect((await anon.storage.from(FERIA_WORKSHEET_BUCKET).download(firstPath)).error).toBeTruthy();
  });

  it('compensation: a failed backend close removes the worksheet it uploaded and surfaces the original error', async () => {
    const before = objects();
    const err = await withWorksheet(admin(), { userId: users.ADMIN.id!, file: pdf('again.pdf') }, (worksheet) =>
      closeFeriaSummary(admin(), { ...base, cashAccountId: fx.cash, transferAccountId: fx.bank, sessionId, worksheet })).catch((e) => e);
    expect(code(err)).toBe('SESSION_ALREADY_CLOSED');
    expect(objects()).toBe(before);
  });

  it('the bucket rejects other MIME types and files over 10 MB', async () => {
    const txt = await admin().storage.from(FERIA_WORKSHEET_BUCKET).upload(`${users.ADMIN.id}/${randomUUID()}.txt`, new Blob(['x'], { type: 'text/plain' }), { contentType: 'text/plain' });
    expect(txt.error).toBeTruthy();
    const big = await admin().storage.from(FERIA_WORKSHEET_BUCKET).upload(`${users.ADMIN.id}/${randomUUID()}.pdf`,
      new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'application/pdf' }), { contentType: 'application/pdf' });
    expect(big.error).toBeTruthy();
  });

  it('OPERATOR cannot close, rectify, read closings or upload a worksheet', async () => {
    expect(denied(await rectifyFeriaClosing(operator(), { ...base, cashAccountId: fx.cash, closingId, reason: 'x' }).catch((e) => e))).toBe(true);
    expect(await listFeriaClosings(operator(), fx.today, fx.today)).toEqual([]);
    expect((await operator().storage.from(FERIA_WORKSHEET_BUCKET).upload(`${users.OPERATOR.id}/${randomUUID()}.pdf`, pdf(), { contentType: 'application/pdf' })).error).toBeTruthy();
    const err = await openAndCloseFeria(operator(), { ...base, cashAccountId: fx.cash, date: fx.today, location: `${TAG} op`, idempotencyKey: `${TAG}-OP`, worksheet: null }).catch((e) => e);
    expect(denied(err)).toBe(true);
  });

  it('rectification: reason required; original immutable; current version effective; treasury compensated; worksheet history kept', async () => {
    expect(code(await rectifyFeriaClosing(admin(), { ...base, cashAccountId: fx.cash, closingId, reason: ' ' }).catch((e) => e))).toBe('REASON_REQUIRED');
    const res = await withWorksheet(admin(), { userId: users.ADMIN.id!, file: pdf('corregida.pdf') }, (worksheet) => rectifyFeriaClosing(admin(), {
      cashSales: 900, mpSales: 300, transferSales: 0, expenses: 100, countedCash: 1000, openingFloat: 200, cashAccountId: fx.cash,
      closingId, reason: 'planilla mal sumada', worksheet,
    }));
    expect(res).toMatchObject({ version_seq: 1, total_sales: 1200, expected_cash: 1000, cash_difference: 0 });
    const rows = (await listFeriaClosings(admin(), fx.today, fx.today)).filter((c) => c.sales_session_id === sessionId);
    expect(rows.map((r) => [r.version_seq, r.is_current, r.worksheet_file_name])).toEqual([[1, true, 'corregida.pdf'], [0, false, 'planilla.pdf']]);
    expect(rows[1]).toMatchObject({ total_sales: 1700, cash_difference: -30 });
    expect(bal(fx.cash)).toBe(800);   // counted 1000 − float 200, previous version fully compensated
    expect(bal(fx.bank)).toBe(0);
    expect(objects()).toBe(2);   // previous worksheet stays as history
  });
});
