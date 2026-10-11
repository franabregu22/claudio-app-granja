/**
 * ADR-018 — fin-statement-import end-to-end against a LOCAL Supabase stack (gateway with verify_jwt, GoTrue,
 * PostgREST, Storage, edge-runtime serving supabase/functions, target migrations 0001–0076 applied).
 *
 * Writes immutable rows (fin_import_run, fin_statement_line) and Storage evidence, so it refuses to run against
 * the main local project: run it only on a disposable project (FIN_E2E_PROJECT = its project_id).
 * SYNTHETIC statements only; the optional real smoke reads local PDFs given by path and never prints their content.
 *
 *   FIN_E2E_PROJECT=granja_fresh_0073 deno test --node-modules-dir=none --allow-read --allow-net=127.0.0.1:54321 \
 *     --allow-env --allow-run=docker scripts/adr018/fin-statement-import.e2e.test.ts
 *   optional real smoke: FIN_E2E_REAL_BNA=<file.pdf> FIN_E2E_REAL_PATAGONIA=<file.pdf> (accounts seeded by 0074)
 */
// deno-lint-ignore no-import-prefix -- pinned test-only dependency (no deno.json in this repository)
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13';
import type { StatementAccountConfig, TextItem } from '../../supabase/functions/_shared/bank-statement/index.ts';
import { buildPdf } from './synthetic-pdf.ts';

const BASE = 'http://127.0.0.1:54321';
const FN = `${BASE}/functions/v1/fin-statement-import`;
const PROJECT = Deno.env.get('FIN_E2E_PROJECT') ?? '';
if (!PROJECT || PROJECT === 'Claudio_app_Granja') throw new Error('FIN_E2E_PROJECT must name a disposable local project');

const docker = async (args: string[], input?: string) => {
  const p = new Deno.Command('docker', { args, stdin: input ? 'piped' : 'null', stdout: 'piped', stderr: 'piped' }).spawn();
  if (input) { const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(input)); await w.close(); }
  const o = await p.output();
  return { ok: o.success, out: new TextDecoder().decode(o.stdout).trim(), err: new TextDecoder().decode(o.stderr) };
};
const DB = `supabase_db_${PROJECT}`;
const EDGE = `supabase_edge_runtime_${PROJECT}`;
const running = (await docker(['ps', '--format', '{{.Names}}'])).out.split('\n');
if (!running.includes(DB) || !running.includes(EDGE) || running.some((n) => n.endsWith('_Claudio_app_Granja'))) {
  throw new Error(`the disposable project ${PROJECT} must be the only local stack running`);
}
const psql = async (sql: string) => {
  const r = await docker(['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);
  if (!r.ok) throw new Error(r.err);
  return r.out;
};
const envOf = (await docker(['inspect', EDGE, '--format', '{{range .Config.Env}}{{println .}}{{end}}'])).out.split(/\r?\n/);
const key = (k: string) => (envOf.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
const ANON = key('SUPABASE_ANON_KEY');
const SERVICE = key('SUPABASE_SERVICE_ROLE_KEY');
for (const [want, jwt] of [['anon', ANON], ['service_role', SERVICE]] as const) {
  const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))) || '{}');
  if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
}
const svc = { apikey: SERVICE, authorization: `Bearer ${SERVICE}` };

type Fixture = { name: string; format: StatementAccountConfig['format_code']; config: Omit<StatementAccountConfig, 'format_code'>;
  pages: { n: number; items: TextItem[] }[]; expect: { lines: unknown[] } };
const FIXTURES: Fixture[] = JSON.parse(await Deno.readTextFile(new URL('./fixtures/unpdf-synthetic-statements.json', import.meta.url))).fixtures;
const BNA = FIXTURES.find((f) => f.name === 'bna-synthetic') as Fixture;
const PAT = FIXTURES.find((f) => f.name === 'patagonia-synthetic') as Fixture;
const BNA_PDF = buildPdf(BNA.pages);
const PAT_PDF = buildPdf(PAT.pages);
const variant = (b: Uint8Array, tag: string) => new Uint8Array([...b, ...new TextEncoder().encode(`% ${tag}\n`)]);   // new hash, same content

async function sha256(b: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const tag = crypto.randomUUID().slice(0, 8);

// every configured identifier (synthetic and seeded) must stay out of responses
const SECRETS = (await psql(`SELECT expected_account_number, expected_cbu FROM fin_statement_account_config;`)).split(/[|\r\n]+/)
  .concat(BNA.config.expected_account_number, BNA.config.expected_cbu, PAT.config.expected_account_number).filter((x) => x.length >= 6);

// ── fixtures: synthetic bank accounts and users ────────────────────────────────────────────────────────────
const cfgSql = (name: string, f: Fixture) => `WITH a AS (INSERT INTO financial_account (nombre, account_type) VALUES ('${name}', 'BANK_ACCOUNT') RETURNING id),
  c AS (INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu, expected_extra)
        SELECT id, '${f.format}', '${f.config.expected_account_number}', '${f.config.expected_cbu}', '${JSON.stringify(f.config.expected_extra)}'::jsonb FROM a RETURNING financial_account_id)
  SELECT financial_account_id FROM c;`;
const ACC_BNA = await psql(cfgSql(`E2E BNA ${tag}`, BNA));
const ACC_PAT = await psql(cfgSql(`E2E PAT ${tag}`, PAT));
const ACC_CASH = await psql(`INSERT INTO financial_account (nombre, account_type) VALUES ('E2E CASH ${tag}', 'CASH') RETURNING id;`);

async function user(role: 'ADMIN' | 'OPERATOR' | null, activo = true) {
  const email = `fin-e2e-${role ?? 'none'}-${activo ? 'a' : 'i'}-${tag}@example.invalid`;
  const password = `Fe2e-${crypto.randomUUID()}`;
  const c = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...svc, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }) });
  const id = (await c.json()).id as string;
  if (role) await psql(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${id}', '${email}', '${role}', ${activo});`);
  const s = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }) });
  return { id, jwt: (await s.json()).access_token as string };
}
const ADMIN = await user('ADMIN');
const OPERATOR = await user('OPERATOR');
const INACTIVE = await user('ADMIN', false);
const NOPROFILE = await user(null);

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
async function upload(jwt: string | null, account: string, bytes: Uint8Array, extra: Record<string, string> = {}, type = 'application/pdf') {
  const form = new FormData();
  form.append('financial_account_id', account);
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), 'extracto.pdf');
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const headers: Record<string, string> = { apikey: ANON };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  return parse(await fetch(FN, { method: 'POST', headers, body: form }));
}
async function reprocess(jwt: string, body: unknown) {
  return parse(await fetch(FN, { method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
async function parse(res: Response) {
  const text = await res.text();
  for (const s of SECRETS) assert(!text.includes(s), 'response leaks an account identifier');
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* gateway errors may not be JSON */ }
  return { status: res.status, body };
}
const runsOf = async (account: string) => Number(await psql(`SELECT count(*) FROM fin_import_run WHERE financial_account_id = '${account}';`));
const objectsOf = async (account: string) =>
  Number(await psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'financial-statements' AND name LIKE 'bank/${account}/%';`));
const storedBytes = async (path: string) => {
  const r = await fetch(`${BASE}/storage/v1/object/financial-statements/${path}`, { headers: svc });
  return new Uint8Array(await r.arrayBuffer());
};
/** A REJECTED attempt by an older parser version, created the way the Edge does (stored evidence + RPC as service role). */
async function olderRejectedAttempt(account: string, bytes: Uint8Array, format: string) {
  const sha = await sha256(bytes);
  const path = `bank/${account}/${sha}.pdf`;
  const up = await fetch(`${BASE}/storage/v1/object/financial-statements/${path}`, { method: 'POST',
    headers: { ...svc, 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: bytes as Uint8Array<ArrayBuffer> });
  assert(up.ok, `seed upload ${up.status}`);
  const r = await fetch(`${BASE}/rest/v1/rpc/fin_import_bank_statement`, { method: 'POST', headers: { ...svc, 'content-type': 'application/json' },
    body: JSON.stringify({ p_actor: ADMIN.id, p_account_id: account, p_parser_version: `${format}/0.0.1 e2e-old`, p_format_code: format,
      p_file_sha256: sha, p_storage_path: path, p_file_name: 'extracto.pdf', p_byte_size: bytes.length, p_coverage_from: null, p_coverage_to: null,
      p_source_meta: null, p_previous_run_id: null, p_reject_reason: 'UNCLASSIFIABLE_ROW: e2e older parser', p_rows: null }) });
  const body = await r.json();
  assert(r.ok, JSON.stringify(body));
  return { id: body.run_id as string, sha, path };
}

// ── auth and permissions ───────────────────────────────────────────────────────────────────────────────────
Deno.test('e2e auth: no JWT → 401 at the gateway; anon key → 401; operator / inactive / no profile → 403; nothing stored', async () => {
  assertEquals((await upload(null, ACC_BNA, BNA_PDF)).status, 401);
  assertEquals((await upload(ANON, ACC_BNA, BNA_PDF)).status, 401);
  assertEquals((await upload(OPERATOR.jwt, ACC_BNA, BNA_PDF)).status, 403);
  assertEquals((await upload(INACTIVE.jwt, ACC_BNA, BNA_PDF)).status, 403);
  assertEquals((await upload(NOPROFILE.jwt, ACC_BNA, BNA_PDF)).status, 403);
  assertEquals((await reprocess(OPERATOR.jwt, { action: 'reprocess', previous_run_id: crypto.randomUUID() })).status, 403);
  assertEquals([await runsOf(ACC_BNA), await objectsOf(ACC_BNA)], [0, 0]);
});

Deno.test('e2e permissions: browser roles cannot write the bucket nor call the import RPC', async () => {
  const path = `bank/${ACC_BNA}/${'0'.repeat(64)}.pdf`;
  for (const jwt of [ADMIN.jwt, OPERATOR.jwt]) {
    const up = await fetch(`${BASE}/storage/v1/object/financial-statements/${path}`, { method: 'POST',
      headers: { apikey: ANON, authorization: `Bearer ${jwt}`, 'content-type': 'application/pdf' }, body: BNA_PDF as Uint8Array<ArrayBuffer> });
    await up.body?.cancel();
    assert(!up.ok, 'a browser JWT must not upload evidence');
    const rpc = await fetch(`${BASE}/rest/v1/rpc/fin_import_bank_statement`, { method: 'POST',
      headers: { apikey: ANON, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: '{}' });
    await rpc.body?.cancel();
    assert(!rpc.ok, 'a browser JWT must not call fin_import_bank_statement');
  }
  assertEquals(await objectsOf(ACC_BNA), 0);
});

// ── request and file validation ───────────────────────────────────────────────────────────────────────────
Deno.test('e2e request: invalid input refused before Storage; client-controlled fields refused', async () => {
  const html = new TextEncoder().encode('<html>no</html>');
  assertEquals((await upload(ADMIN.jwt, ACC_BNA, html)).body.error, 'NOT_A_PDF');
  assertEquals((await upload(ADMIN.jwt, ACC_BNA, BNA_PDF, {}, 'text/plain')).body.error, 'UNSUPPORTED_MEDIA_TYPE');
  assertEquals((await upload(ADMIN.jwt, ACC_CASH, BNA_PDF)).body.error, 'ACCOUNT_NOT_FOUND_OR_NOT_BANK');
  for (const k of ['format_code', 'actor', 'storage_path', 'parser_version', 'cbu']) {
    assertEquals((await upload(ADMIN.jwt, ACC_BNA, BNA_PDF, { [k]: 'x' })).body.error, 'UNEXPECTED_FIELD');
  }
  assertEquals([await runsOf(ACC_BNA), await objectsOf(ACC_BNA), await objectsOf(ACC_CASH)], [0, 0, 0]);
});

// ── upload ─────────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('e2e upload BNA: PARSED run by the authenticated ADMIN, evidence at the canonical path; same bytes again replays', async () => {
  const sha = await sha256(BNA_PDF);
  const r = await upload(ADMIN.jwt, ACC_BNA, BNA_PDF);
  assertEquals([r.status, r.body.status, r.body.replayed, r.body.file_sha256, r.body.financial_account_id], [200, 'PARSED', false, sha, ACC_BNA]);
  const [createdBy, path, fmt, lines] = (await psql(`SELECT created_by, storage_path, format_code,
      (SELECT count(*) FROM fin_import_run_line l WHERE l.run_id = r.id AND l.statement_line_id IS NOT NULL)
     FROM fin_import_run r WHERE id = '${r.body.run_id}';`)).split('|');
  assertEquals([createdBy, path, fmt], [ADMIN.id, `bank/${ACC_BNA}/${sha}.pdf`, 'BNA_MONTHLY_PDF_V1']);
  assertEquals(Number(lines), BNA.expect.lines.length);
  assertEquals(await sha256(await storedBytes(path)), sha);
  const again = await upload(ADMIN.jwt, ACC_BNA, BNA_PDF);
  assertEquals([again.status, again.body.run_id, again.body.replayed], [200, r.body.run_id, true]);
  assertEquals([await runsOf(ACC_BNA), await objectsOf(ACC_BNA)], [1, 1]);
});

Deno.test('e2e upload Patagonia, concurrent: one run, one object, every response the same run', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => upload(ADMIN.jwt, ACC_PAT, PAT_PDF)));
  assert(results.every((r) => r.status === 200 && r.body.status === 'PARSED'), JSON.stringify(results.map((r) => r.body.error ?? r.body.status)));
  assertEquals(new Set(results.map((r) => r.body.run_id)).size, 1);
  assertEquals(results.filter((r) => r.body.replayed === false).length, 1);
  assertEquals(results[0].body.format_code, 'PATAGONIA_STATEMENT_PDF_V1');
  assertEquals([await runsOf(ACC_PAT), await objectsOf(ACC_PAT)], [1, 1]);
});

Deno.test('e2e rejection: a file the configured adapter rejects becomes a persisted REJECTED run (HTTP 200), evidence kept', async () => {
  const bytes = variant(BNA_PDF, 'into-patagonia');
  const r = await upload(ADMIN.jwt, ACC_PAT, bytes);
  assertEquals([r.status, r.body.status], [200, 'REJECTED']);
  assertMatch(String(r.body.reject_reason), /^[A-Z_]+: /);
  assertEquals(await psql(`SELECT status || '|' || (SELECT count(*) FROM fin_import_run_line WHERE run_id = '${r.body.run_id}') FROM fin_import_run WHERE id = '${r.body.run_id}';`), 'REJECTED|0');
  assertEquals(await objectsOf(ACC_PAT), 2);
  // the same bytes with the same parser version is the same attempt
  const again = await upload(ADMIN.jwt, ACC_PAT, bytes);
  assertEquals([again.body.run_id, again.body.replayed], [r.body.run_id, true]);
});

// ── reprocess ──────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('e2e reprocess: stored bytes re-parsed with the current version and chained; repeating it replays', async () => {
  const bytes = variant(BNA_PDF, 'reprocess');
  const prev = await olderRejectedAttempt(ACC_BNA, bytes, 'BNA_MONTHLY_PDF_V1');
  const r = await reprocess(ADMIN.jwt, { action: 'reprocess', previous_run_id: prev.id });
  assertEquals([r.status, r.body.status, r.body.replayed, r.body.file_sha256], [200, 'PARSED', false, prev.sha]);
  assertEquals(await psql(`SELECT previous_run_id || '|' || storage_path || '|' || created_by FROM fin_import_run WHERE id = '${r.body.run_id}';`),
    `${prev.id}|${prev.path}|${ADMIN.id}`);
  // the lines were already known from the BNA upload (same economic content): no duplicates
  assertEquals(Number((r.body.counters as Record<string, number>).lines_new), 0);
  // the same reprocess again is the same attempt (account, hash, current parser version): replayed, no new run
  const again = await reprocess(ADMIN.jwt, { action: 'reprocess', previous_run_id: prev.id });
  assertEquals([again.status, again.body.run_id, again.body.replayed], [200, r.body.run_id, true]);
});

Deno.test('e2e reprocess: evidence replaced in Storage fails closed, no run created', async () => {
  const bytes = variant(PAT_PDF, 'tamper');
  const prev = await olderRejectedAttempt(ACC_PAT, bytes, 'PATAGONIA_STATEMENT_PDF_V1');
  const put = await fetch(`${BASE}/storage/v1/object/financial-statements/${prev.path}`, { method: 'PUT',
    headers: { ...svc, 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: variant(bytes, 'evil') as Uint8Array<ArrayBuffer> });
  await put.body?.cancel();
  assert(put.ok, 'service role tampering setup');
  const before = await runsOf(ACC_PAT);
  const r = await reprocess(ADMIN.jwt, { action: 'reprocess', previous_run_id: prev.id });
  assertEquals([r.status, r.body.error], [409, 'EVIDENCE_INTEGRITY']);
  assertEquals(await runsOf(ACC_PAT), before);
});

Deno.test('e2e reprocess: refused for a parsed run and a non-latest attempt', async () => {
  const parsedRun = await psql(`SELECT id FROM fin_import_run WHERE financial_account_id = '${ACC_PAT}' AND status = 'PARSED' LIMIT 1;`);
  assertEquals((await reprocess(ADMIN.jwt, { action: 'reprocess', previous_run_id: parsedRun })).body.error, 'ALREADY_PROCESSED');
  assertEquals((await reprocess(ADMIN.jwt, { action: 'reprocess', previous_run_id: crypto.randomUUID() })).body.error, 'RUN_NOT_FOUND');
});

// ── optional smoke with real statements (local files, never committed; only status and counters asserted) ──
for (const [envName, account] of [['FIN_E2E_REAL_BNA', 'BNA'], ['FIN_E2E_REAL_PATAGONIA', 'Patagonia']] as const) {
  const file = Deno.env.get(envName);
  Deno.test({ name: `e2e real smoke ${account}`, ignore: !file, fn: async () => {
    const acc = await psql(`SELECT id FROM financial_account WHERE nombre = '${account}' AND account_type = 'BANK_ACCOUNT';`);
    const r = await upload(ADMIN.jwt, acc, await Deno.readFile(file as string));
    assertEquals([r.status, r.body.status], [200, 'PARSED']);
    assert(Number((r.body.counters as Record<string, number>).rows_total) > 0);
  } });
}
