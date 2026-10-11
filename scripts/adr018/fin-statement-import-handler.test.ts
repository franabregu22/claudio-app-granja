/**
 * ADR-018 — fin-statement-import handler tests (Deno, no network). The runtime-agnostic handler runs with
 * in-memory fakes for auth, PostgREST, Storage and the RPC, and with the REAL production parser over SYNTHETIC
 * statements rendered to PDF. Proves: auth / permissions, request contract, file validation before any upload,
 * canonical evidence path without upsert, BNA and Patagonia imports, parser rejections persisted as runs,
 * reprocess over the stored bytes (fail closed on a hash mismatch), and no PII in responses or logs.
 *
 *   deno test --node-modules-dir=none --allow-read scripts/adr018/fin-statement-import-handler.test.ts
 */
// deno-lint-ignore no-import-prefix -- pinned test-only dependency (no deno.json in this repository)
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13';
import {
  parseStatementPdf, type StatementAccountConfig, type TextItem,
} from '../../supabase/functions/_shared/bank-statement/index.ts';
import {
  type AccountRow, type AuthResult, canonicalPath, handleImport, type ImportDeps, type ImportParams, ImportRpcError, type LogEntry,
  MAX_FILE_BYTES, type RunRow,
} from '../../supabase/functions/fin-statement-import/handler.ts';
import { buildPdf } from './synthetic-pdf.ts';

type Fixture = { name: string; format: StatementAccountConfig['format_code']; config: Omit<StatementAccountConfig, 'format_code'>;
  pages: { n: number; items: TextItem[] }[]; expect: { lines: unknown[] } };
const FIXTURES: Fixture[] = JSON.parse(await Deno.readTextFile(new URL('./fixtures/unpdf-synthetic-statements.json', import.meta.url))).fixtures;
const fx = (name: string) => FIXTURES.find((f) => f.name === name) as Fixture;
const BNA = fx('bna-synthetic');
const PAT = fx('patagonia-synthetic');
const BNA_PDF = buildPdf(BNA.pages);
const PAT_PDF = buildPdf(PAT.pages);

const ADMIN = '11111111-1111-4111-8111-111111111111';
const ACC_BNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACC_PAT = 'aaaaaaaa-0000-4000-8000-000000000002';
const ACC_CASH = 'aaaaaaaa-0000-4000-8000-000000000003';
const ACC_NOCFG = 'aaaaaaaa-0000-4000-8000-000000000004';
const TOKENS: Record<string, AuthResult> = {
  admin: { ok: true, uid: ADMIN },
  operator: { ok: false, status: 403, code: 'ADMIN_REQUIRED' },
  inactive: { ok: false, status: 403, code: 'USER_NOT_FOUND_OR_INACTIVE' },
};
const SECRET_STRINGS = [BNA.config.expected_account_number, BNA.config.expected_cbu, PAT.config.expected_account_number, 'admin-jwt'];

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** In-memory backend mirroring the parts of fin_import_bank_statement the Edge relies on. */
function backend() {
  const accounts: Record<string, AccountRow> = {
    [ACC_BNA]: { id: ACC_BNA, activo: true, account_type: 'BANK_ACCOUNT' },
    [ACC_PAT]: { id: ACC_PAT, activo: true, account_type: 'BANK_ACCOUNT' },
    [ACC_CASH]: { id: ACC_CASH, activo: true, account_type: 'CASH' },
    [ACC_NOCFG]: { id: ACC_NOCFG, activo: true, account_type: 'BANK_ACCOUNT' },
  };
  const configs: Record<string, StatementAccountConfig> = {
    [ACC_BNA]: { format_code: BNA.format, ...BNA.config },
    [ACC_PAT]: { format_code: PAT.format, ...PAT.config },
  };
  const objects = new Map<string, Uint8Array>();
  const runs = new Map<string, RunRow>();
  const calls = { upload: 0, rpc: [] as ImportParams[], parse: 0 };
  const logs: LogEntry[] = [];
  let seq = 0;
  const deps: ImportDeps = {
    authorize: (h) => {
      const t = /^Bearer (\S+)$/.exec(h ?? '')?.[1];
      const r = t ? TOKENS[t.replace('-jwt', '')] : undefined;
      return Promise.resolve(r ?? { ok: false, status: 401, code: 'NOT_AUTHENTICATED' });
    },
    loadAccount: (id) => Promise.resolve(accounts[id] ?? null),
    loadConfig: (id) => Promise.resolve(configs[id] ?? null),
    loadRun: (id) => Promise.resolve(runs.get(id) ?? null),
    download: (p) => Promise.resolve(objects.get(p) ?? null),
    upload: (p, b) => {
      calls.upload++;
      if (objects.has(p)) return Promise.resolve('exists' as const);
      objects.set(p, b.slice());
      return Promise.resolve('created' as const);
    },
    importStatement: (p) => {
      calls.rpc.push(p);
      const same = [...runs.values()].find((r) => r.financial_account_id === p.p_account_id && r.file_sha256 === p.p_file_sha256 &&
        (r.parser_version === p.p_parser_version || r.status !== 'REJECTED'));
      if (same) return Promise.resolve({ run_id: same.id, status: same.status, replayed: true });
      const latest = [...runs.values()].filter((r) => r.financial_account_id === p.p_account_id && r.file_sha256 === p.p_file_sha256).at(-1);
      if ((latest?.id ?? null) !== p.p_previous_run_id) throw new ImportRpcError('PREVIOUS_RUN_INVALID: chain');
      const id = `bbbbbbbb-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      const rows = (p.p_rows ?? []) as { kind: string }[];
      const status = p.p_reject_reason ? 'REJECTED' : 'PARSED';
      runs.set(id, {
        id, source_kind: 'BANK_STATEMENT', mode: 'NORMAL', status, financial_account_id: p.p_account_id, format_code: p.p_format_code,
        parser_version: p.p_parser_version, file_sha256: p.p_file_sha256, storage_path: p.p_storage_path, file_name: p.p_file_name,
        byte_size: p.p_byte_size, rows_total: rows.length, lines_new: rows.filter((r) => r.kind === 'ECONOMIC').length, lines_known: 0,
        rows_ignored: 0, rows_invalid: 0, rows_captured: 0, reject_reason: p.p_reject_reason,
      });
      return Promise.resolve({ run_id: id, status, replayed: false });
    },
    parse: (b, c) => { calls.parse++; return parseStatementPdf(b, c); },
    sha256,
    log: (e) => logs.push(e),
    now: () => 0,
  };
  return { deps, objects, runs, calls, logs };
}

const URL_ = 'http://local/functions/v1/fin-statement-import';
function uploadReq(token: string | null, fields: [string, string | Blob, string?][], init: { type?: string } = {}): Request {
  const form = new FormData();
  for (const [k, v, name] of fields) typeof v === 'string' ? form.append(k, v) : form.append(k, v, name ?? 'extracto.pdf');
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const req = new Request(URL_, { method: 'POST', body: form, headers });
  if (!init.type) return req;
  return new Request(URL_, { method: 'POST', body: req.body, headers: { ...headers, 'content-type': init.type } });
}
const pdf = (bytes: Uint8Array, type = 'application/pdf') => new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
const reprocessReq = (token: string, body: unknown) =>
  new Request(URL_, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
async function call(b: ReturnType<typeof backend>, req: Request) {
  const res = await handleImport(req, b.deps);
  const text = await res.text();
  for (const s of SECRET_STRINGS) assert(!text.includes(s), `response leaks ${s}`);
  for (const s of SECRET_STRINGS) assert(!JSON.stringify(b.logs).includes(s), `log leaks ${s}`);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

// ── auth and permissions ────────────────────────────────────────────────────────────────────────────────────
Deno.test('auth: anon / missing / invalid token → 401; operator and inactive → 403; nothing stored or parsed', async () => {
  for (const [token, status] of [[null, 401], ['garbage', 401], ['operator-jwt', 403], ['inactive-jwt', 403]] as const) {
    const b = backend();
    const r = await call(b, uploadReq(token, [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]));
    assertEquals(r.status, status);
    assertEquals([b.calls.upload, b.calls.parse, b.calls.rpc.length, b.objects.size], [0, 0, 0, 0]);
  }
  const b = backend();
  assertEquals((await call(b, reprocessReq('operator-jwt', { action: 'reprocess', previous_run_id: ADMIN }))).status, 403);
});

Deno.test('request: method, content type, CORS preflight', async () => {
  const b = backend();
  assertEquals((await handleImport(new Request(URL_, { method: 'OPTIONS' }), b.deps)).status, 204);
  assertEquals((await call(b, new Request(URL_, { method: 'GET', headers: { authorization: 'Bearer admin-jwt' } }))).status, 405);
  const plain = new Request(URL_, { method: 'POST', body: 'x', headers: { authorization: 'Bearer admin-jwt', 'content-type': 'text/plain' } });
  assertEquals((await call(b, plain)).body.error, 'UNSUPPORTED_CONTENT_TYPE');
});

Deno.test('request: client-controlled fields are refused (actor, format, identifiers, version, path, hash)', async () => {
  for (const k of ['actor', 'p_actor', 'format_code', 'cbu', 'account_number', 'parser_version', 'description_norm', 'fingerprint', 'rows_total', 'storage_path', 'file_sha256']) {
    const b = backend();
    const r = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)], [k, 'x']]));
    assertEquals([r.status, r.body.error], [400, 'UNEXPECTED_FIELD']);
    assertEquals(b.calls.upload, 0);
  }
  const b = backend();
  const r = await call(b, reprocessReq('admin-jwt', { action: 'reprocess', previous_run_id: ADMIN, actor: ADMIN }));
  assertEquals([r.status, r.body.error], [400, 'UNEXPECTED_FIELD']);
});

Deno.test('request: account and file validation happen before any upload', async () => {
  const cases: [[string, string | Blob, string?][], number, string][] = [
    [[['file', pdf(BNA_PDF)]], 400, 'INVALID_ACCOUNT_ID'],
    [[['financial_account_id', 'not-a-uuid'], ['file', pdf(BNA_PDF)]], 400, 'INVALID_ACCOUNT_ID'],
    [[['financial_account_id', ACC_BNA]], 400, 'FILE_REQUIRED'],
    [[['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)], ['file', pdf(BNA_PDF)]], 400, 'MULTIPLE_FILES'],
    [[['financial_account_id', ACC_BNA], ['financial_account_id', ACC_PAT], ['file', pdf(BNA_PDF)]], 400, 'INVALID_ACCOUNT_ID'],
    [[['financial_account_id', ACC_BNA], ['file', pdf(new Uint8Array())]], 400, 'EMPTY_FILE'],
    [[['financial_account_id', ACC_BNA], ['file', pdf(new Uint8Array(MAX_FILE_BYTES + 1))]], 413, 'FILE_TOO_LARGE'],
    [[['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF, 'image/png')]], 415, 'UNSUPPORTED_MEDIA_TYPE'],
    // a PDF MIME type is not trusted: the bytes must start with %PDF-
    [[['financial_account_id', ACC_BNA], ['file', pdf(new TextEncoder().encode('<html>not a pdf</html>'))]], 415, 'NOT_A_PDF'],
    [[['financial_account_id', ACC_CASH], ['file', pdf(BNA_PDF)]], 422, 'ACCOUNT_NOT_FOUND_OR_NOT_BANK'],
    [[['financial_account_id', 'aaaaaaaa-0000-4000-8000-0000000000ff'], ['file', pdf(BNA_PDF)]], 422, 'ACCOUNT_NOT_FOUND_OR_NOT_BANK'],
    [[['financial_account_id', ACC_NOCFG], ['file', pdf(BNA_PDF)]], 422, 'STATEMENT_CONFIG_MISSING'],
  ];
  for (const [fields, status, code] of cases) {
    const b = backend();
    const r = await call(b, uploadReq('admin-jwt', fields));
    assertEquals([r.status, r.body.error], [status, code], code);
    assertEquals([b.calls.upload, b.calls.parse, b.calls.rpc.length, b.objects.size], [0, 0, 0, 0], code);
  }
});

// ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('upload BNA: canonical path, actor = authenticated user, parser output passed verbatim, 200 PARSED', async () => {
  const b = backend();
  const sha = await sha256(BNA_PDF);
  const r = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA.toUpperCase()], ['file', pdf(BNA_PDF), 'mi\x07extracto.pdf']]));
  assertEquals(r.status, 200);
  assertEquals(b.calls.upload, 1);
  assert(b.objects.has(canonicalPath(ACC_BNA, sha)));
  const p = b.calls.rpc[0];
  assertEquals([p.p_actor, p.p_account_id, p.p_file_sha256, p.p_storage_path, p.p_byte_size, p.p_format_code, p.p_file_name, p.p_previous_run_id, p.p_reject_reason],
    [ADMIN, ACC_BNA, sha, `bank/${ACC_BNA}/${sha}.pdf`, BNA_PDF.length, 'BNA_MONTHLY_PDF_V1', 'miextracto.pdf', null, null]);
  assertEquals(p.p_parser_version, 'BNA_MONTHLY_PDF_V1/1.0.0 unpdf-1.8.1');
  assert((p.p_rows ?? []).every((row) => !('description_norm' in (row as object)) && !('fingerprint' in (row as object))));
  assertEquals(Object.keys(r.body).sort(), ['counters', 'file_sha256', 'financial_account_id', 'format_code', 'parser_version', 'reject_reason', 'replayed', 'run_id', 'status']);
  assertEquals([r.body.status, r.body.replayed, r.body.file_sha256, r.body.reject_reason], ['PARSED', false, sha, null]);
  assertEquals((r.body.counters as Record<string, number>).lines_new, BNA.expect.lines.length);
  assertEquals(b.logs.at(-1)?.event, 'import');
  assertEquals(b.logs.at(-1)?.sha, sha.slice(0, 12));
});

Deno.test('upload Patagonia: 200 PARSED with the Patagonia adapter', async () => {
  const b = backend();
  const r = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_PAT], ['file', pdf(PAT_PDF)]]));
  assertEquals([r.status, r.body.status, r.body.format_code], [200, 'PARSED', 'PATAGONIA_STATEMENT_PDF_V1']);
  assertEquals(b.calls.rpc[0].p_parser_version, 'PATAGONIA_STATEMENT_PDF_V1/1.0.0 unpdf-1.8.1');
});

Deno.test('upload: same bytes again → object reused (no upsert), RPC replays the run', async () => {
  const b = backend();
  const first = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]));
  const again = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]));
  assertEquals(b.calls.upload, 1);
  assertEquals([again.status, again.body.run_id, again.body.replayed], [200, first.body.run_id, true]);
});

Deno.test('upload: a stored object with different bytes at the canonical path fails closed (409), no run', async () => {
  const b = backend();
  b.objects.set(canonicalPath(ACC_BNA, await sha256(BNA_PDF)), PAT_PDF);
  const r = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]));
  assertEquals([r.status, r.body.error], [409, 'EVIDENCE_INTEGRITY']);
  assertEquals([b.calls.upload, b.calls.rpc.length], [0, 0]);
});

Deno.test('upload: lost upload race ("exists") is verified by hash, then imported', async () => {
  const b = backend();
  const sha = await sha256(BNA_PDF);
  const real = b.deps.download;
  let first = true;
  b.deps.download = (p) => { if (first) { first = false; b.objects.set(p, BNA_PDF.slice()); return Promise.resolve(null); } return real(p); };
  const r = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]));
  assertEquals([r.status, r.body.status, r.body.file_sha256], [200, 'PARSED', sha]);
});

Deno.test('upload: parser rejection after acceptance → REJECTED run persisted via p_reject_reason, HTTP 200', async () => {
  const b = backend();
  // a BNA statement uploaded to the Patagonia account: wrong layout for the configured adapter
  const r = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_PAT], ['file', pdf(BNA_PDF)]]));
  assertEquals([r.status, r.body.status], [200, 'REJECTED']);
  assertMatch(String(r.body.reject_reason), /^[A-Z_]+: /);
  const p = b.calls.rpc[0];
  assertEquals([p.p_rows, p.p_source_meta, p.p_coverage_to], [null, null, null]);
  assert(p.p_reject_reason);
  assertEquals(b.objects.size, 1);   // the evidence is kept
  // a well-formed PDF without the statement's text
  const b2 = backend();
  const blank = buildPdf([{ items: [{ str: 'FACTURA SINTETICA', x: 50, top: 100, w: 17 * 4.86 }] }]);
  const r2 = await call(b2, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(blank)]]));
  assertEquals([r2.status, r2.body.status], [200, 'REJECTED']);
  // %PDF- bytes that are not a parseable PDF are accepted as evidence and rejected by the parser
  const b3 = backend();
  const broken = new TextEncoder().encode('%PDF-1.4\ngarbage');
  const r3 = await call(b3, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(broken)]]));
  assertEquals([r3.status, r3.body.status, b3.calls.rpc[0].p_format_code], [200, 'REJECTED', null]);
});

Deno.test('upload: database errors map to HTTP errors without leaking the message', async () => {
  const b = backend();
  b.deps.importStatement = () => { throw new ImportRpcError('INVALID_ROWS_CONTRACT: row 3 1234567890'); };
  const r = await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]));
  assertEquals([r.status, r.body.error], [500, 'IMPORT_FAILED']);
  b.deps.importStatement = () => { throw new ImportRpcError('FORBIDDEN: the initiating actor is not an active ADMIN'); };
  assertEquals((await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]))).status, 403);
  b.deps.importStatement = () => { throw new Error('network down'); };
  assertEquals((await call(b, uploadReq('admin-jwt', [['financial_account_id', ACC_BNA], ['file', pdf(BNA_PDF)]]))).body.error, 'INTERNAL');
});

// ── reprocess ───────────────────────────────────────────────────────────────────────────────────────────────
async function rejectedRun(b: ReturnType<typeof backend>) {
  // a BNA file stored for the BNA account, first attempted by an older parser version that rejected it
  const sha = await sha256(BNA_PDF);
  const path = canonicalPath(ACC_BNA, sha);
  b.objects.set(path, BNA_PDF.slice());
  const id = 'cccccccc-0000-4000-8000-000000000001';
  b.runs.set(id, {
    id, source_kind: 'BANK_STATEMENT', mode: 'NORMAL', status: 'REJECTED', financial_account_id: ACC_BNA, format_code: 'BNA_MONTHLY_PDF_V1',
    parser_version: 'BNA_MONTHLY_PDF_V1/0.9.0 old', file_sha256: sha, storage_path: path, file_name: 'extracto.pdf', byte_size: BNA_PDF.length,
    rows_total: 0, lines_new: 0, lines_known: 0, rows_ignored: 0, rows_invalid: 0, rows_captured: 0, reject_reason: 'UNCLASSIFIABLE_ROW: old',
  });
  return { id, sha, path };
}

Deno.test('reprocess: stored bytes re-parsed with the current version, chained to the previous run', async () => {
  const b = backend();
  const { id, sha, path } = await rejectedRun(b);
  const r = await call(b, reprocessReq('admin-jwt', { action: 'reprocess', previous_run_id: id }));
  assertEquals([r.status, r.body.status, r.body.replayed], [200, 'PARSED', false]);
  const p = b.calls.rpc[0];
  assertEquals([p.p_actor, p.p_account_id, p.p_file_sha256, p.p_storage_path, p.p_previous_run_id, p.p_file_name],
    [ADMIN, ACC_BNA, sha, path, id, 'extracto.pdf']);
  assertEquals(b.calls.upload, 0);
  assertEquals(b.logs.at(-1)?.event, 'reprocess');
});

Deno.test('reprocess: tampered, missing or relocated evidence fails closed; nothing parsed', async () => {
  for (const tamper of ['bytes', 'missing', 'path', 'size'] as const) {
    const b = backend();
    const { id, path } = await rejectedRun(b);
    const run = b.runs.get(id) as RunRow;
    if (tamper === 'bytes') { const t = BNA_PDF.slice(); t[t.length - 2] ^= 1; b.objects.set(path, t); }
    if (tamper === 'missing') b.objects.delete(path);
    if (tamper === 'path') run.storage_path = `bank/${ACC_PAT}/${run.file_sha256}.pdf`;
    if (tamper === 'size') run.byte_size += 1;
    const r = await call(b, reprocessReq('admin-jwt', { action: 'reprocess', previous_run_id: id }));
    assertEquals(r.status, 409, tamper);
    assertMatch(String(r.body.error), /^EVIDENCE_/);
    assertEquals([b.calls.parse, b.calls.rpc.length], [0, 0], tamper);
  }
});

Deno.test('reprocess: request contract and run eligibility', async () => {
  const b = backend();
  const { id } = await rejectedRun(b);
  const bad = async (body: unknown, status: number, code: string) => {
    const r = await call(b, reprocessReq('admin-jwt', body));
    assertEquals([r.status, r.body.error], [status, code], code);
  };
  await bad({ action: 'other', previous_run_id: id }, 400, 'UNKNOWN_ACTION');
  await bad({ action: 'reprocess', previous_run_id: 'x' }, 400, 'INVALID_RUN_ID');
  await bad({ action: 'reprocess', previous_run_id: id, storage_path: 'bank/x' }, 400, 'UNEXPECTED_FIELD');
  await bad([1], 400, 'UNEXPECTED_FIELD');
  await bad({ action: 'reprocess', previous_run_id: 'dddddddd-0000-4000-8000-000000000001' }, 404, 'RUN_NOT_FOUND');
  (b.runs.get(id) as RunRow).status = 'PARSED';
  await bad({ action: 'reprocess', previous_run_id: id }, 409, 'ALREADY_PROCESSED');
  (b.runs.get(id) as RunRow).status = 'REJECTED';
  (b.runs.get(id) as RunRow).source_kind = 'MP_RELEASE_REPORT';
  await bad({ action: 'reprocess', previous_run_id: id }, 422, 'NOT_A_BANK_STATEMENT_RUN');
  const bj = new Request(URL_, { method: 'POST', body: '{', headers: { authorization: 'Bearer admin-jwt', 'content-type': 'application/json' } });
  assertEquals((await call(b, bj)).body.error, 'INVALID_JSON');
  assertEquals(b.calls.rpc.length, 0);
});

Deno.test('reprocess: a non-latest previous run is refused by the database chain (409)', async () => {
  const b = backend();
  const { id } = await rejectedRun(b);
  b.runs.set('cccccccc-0000-4000-8000-000000000002', { ...(b.runs.get(id) as RunRow), id: 'cccccccc-0000-4000-8000-000000000002', parser_version: 'BNA_MONTHLY_PDF_V1/0.9.5 old' });
  const r = await call(b, reprocessReq('admin-jwt', { action: 'reprocess', previous_run_id: id }));
  assertEquals([r.status, r.body.error], [409, 'PREVIOUS_RUN_INVALID']);
});
