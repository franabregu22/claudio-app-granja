/**
 * ADR-018 §9.3 — mp-report-ingest handler + release report parser tests (Deno, no network). The runtime-agnostic
 * handler runs against an in-memory fake of the Mercado Pago release report API (exact endpoints, recorded calls),
 * Storage and the capture RPC, with the REAL parser over SYNTHETIC Liberaciones files. Proves: ADMIN only, config first
 * (incompatible → stop before any report request, never a configuration write), the Buenos Aires day window in UTC,
 * bounded task polling (failure / timeout / resume), file_name resolution, download limits, canonical evidence path
 * without upsert, file-level fail closed, replay, and that no token, Authorization header or report content leaks.
 *
 *   deno test --node-modules-dir=none --allow-read scripts/adr018/mp-report-ingest-handler.test.ts
 */
// deno-lint-ignore no-import-prefix -- pinned test-only dependency (no deno.json in this repository)
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13';
import {
  businessDayWindow, checkReleaseConfig, EXPECTED_COLUMNS, FORMAT_CODE, PARSER_VERSION, parseReleaseReport,
} from '../../supabase/functions/_shared/mp-release-report.ts';
import {
  type AuthResult, canonicalPath, type CaptureParams, CaptureRpcError, handleIngest, type IngestDeps, type LogEntry, MAX_FILE_BYTES,
  MAX_POLLS, type RunRow,
} from '../../supabase/functions/mp-report-ingest/handler.ts';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const MP_ACC = 'aaaaaaaa-0000-4000-8000-000000000099';
const NOW = Date.parse('2026-10-13T15:00:00Z');
const TOKENS: Record<string, AuthResult> = {
  admin: { ok: true, uid: ADMIN },
  operator: { ok: false, status: 403, code: 'ADMIN_REQUIRED' },
};
const enc = (s: string) => new TextEncoder().encode(s);

// ── synthetic Liberaciones file (frozen header order of the real exports) ─────────────────────────────────────────
const HEADER = 'DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;TRANSACTION_APPROVAL_DATE;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID';
const LINES = [
  '2026-10-05T00:00:00.000-03:00;;;1000.00;0.00;1000.00;0.00;0.00;;;;;1000.00;;',
  '2026-10-05T08:00:00.000-03:00;900000000001;payment;8946.00;0.00;9000.00;0.00;-54.00;cvu;2026-10-05T08:00:00.000-03:00;;;9946.00;bank_transfer;',
  '2026-10-05T10:00:00.000-03:00;900000000003;asset_management;12.34;0.00;12.34;0.00;0.00;;2026-10-05T10:00:00.000-03:00;;;9958.34;;',
  '2026-10-05T11:00:01.000-03:00;900000000004;payout;0.00;200.00;-200.00;0.00;0.00;available_money;2026-10-05T11:00:01.000-03:00;;;9758.34;;',
  ';;;8758.34;0.00;8812.34;0.00;-54.00;;;;;0.00;;',
];
const csv = (lines = LINES, eol = '\n', header = HEADER) => enc([header, ...lines].join(eol) + eol);
const COLUMNS = HEADER.split(';').map((key) => ({ key }));
const CONFIG = {
  columns: COLUMNS, separator: ';', display_timezone: 'GMT-03', frequency: { hour: 0, type: 'monthly', value: 1 }, scheduled: false,
  include_withdrawal_at_end: true, file_name_prefix: 'release-report-PRIVATE', notification_email_list: ['owner-private@example.invalid'],
};
const WINDOW = { begin_date: '2026-10-05T03:00:00Z', end_date: '2026-10-06T02:59:59Z' };

// ── fake Mercado Pago release report API ───────────────────────────────────────────────────────────────────────────
interface MpState {
  config: unknown; configStatus?: number; createStatus?: number; created?: unknown;
  tasks: Record<string, Record<string, unknown>[]>;   // successive answers per task id (last one repeats)
  list?: unknown; files: Record<string, Uint8Array>; downloadStatus?: number;
}
function fakeMp(s: MpState) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const seen: Record<string, number> = {};
  const mp = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> => {
    calls.push(`${method} ${path}`);
    if (body !== undefined) bodies.push(body);
    const j = (status: number, v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status }));
    const base = '/v1/account/release_report';
    if (method === 'GET' && path === `${base}/config`) return j(s.configStatus ?? 200, s.config);
    if (method === 'POST' && path === base) return j(s.createStatus ?? 202, s.created ?? { id: 777, status: 'pending', ...WINDOW });
    let m = /^\/v1\/account\/release_report\/task\/(\d+)$/.exec(path);
    if (method === 'GET' && m) {
      const answers = s.tasks[m[1]];
      if (!answers) return j(404, { message: 'not found' });
      const i = seen[m[1]] = (seen[m[1]] ?? -1) + 1;
      return j(200, answers[Math.min(i, answers.length - 1)]);
    }
    if (method === 'GET' && path === `${base}/list`) return j(200, s.list ?? []);
    m = /^\/v1\/account\/release_report\/([^/]+)$/.exec(path);
    if (method === 'GET' && m && s.files[decodeURIComponent(m[1])]) {
      return Promise.resolve(new Response(s.files[decodeURIComponent(m[1])] as Uint8Array<ArrayBuffer>, { status: s.downloadStatus ?? 200 }));
    }
    return j(404, { message: 'unexpected endpoint' });
  };
  return { mp, calls, bodies };
}

const processed = (extra: Record<string, unknown> = {}) => ({ id: 777, status: 'processed', ...WINDOW, file_name: 'release-report-777.csv', ...extra });

function harness(state: Partial<MpState> = {}) {
  const s: MpState = { config: CONFIG, tasks: { '777': [{ id: 777, status: 'pending', ...WINDOW }, processed()] }, files: { 'release-report-777.csv': csv() }, ...state };
  const fake = fakeMp(s);
  const storage = new Map<string, Uint8Array>();
  const uploads: string[] = [];
  const captures: CaptureParams[] = [];
  const ingests: CaptureParams[] = [];
  const runs = new Map<string, RunRow>();
  const logs: LogEntry[] = [];
  const dests: { p_run_id: string; p_items: { row_number: number; value: string }[] }[] = [];
  const destStore = new Map<string, string>();
  let destFail = false;
  let sleeps = 0;
  // in-memory stand-in for the two database functions (their real behaviour is proven by the DB suites)
  const record = (mode: 'VALIDATION' | 'NORMAL', p: CaptureParams) => {
    const prior = [...runs.values()].find((r) => r.mode === mode && r.file_sha256 === p.p_file_sha256 && r.parser_version === p.p_parser_version);
    if (prior) return Promise.resolve({ run_id: prior.id, replayed: true });
    const id = crypto.randomUUID();
    const n = p.p_rows?.length ?? 0;
    const ctl = (p.p_rows as { raw_row: { SOURCE_ID: string; DESCRIPTION: string } }[] | null ?? []).filter((r) => r.raw_row.SOURCE_ID === '' && r.raw_row.DESCRIPTION === '').length;
    const latest = [...runs.values()].filter((r) => r.file_sha256 === p.p_file_sha256).pop();
    const ok = !p.p_reject_reason;
    runs.set(id, { id, source_kind: 'MP_RELEASE_REPORT', mode, status: ok ? (mode === 'NORMAL' ? 'PARSED' : 'VALIDATED') : 'REJECTED', financial_account_id: MP_ACC,
      format_code: p.p_format_code, parser_version: p.p_parser_version, file_sha256: p.p_file_sha256, storage_path: p.p_storage_path,
      coverage_from: p.p_coverage_from, coverage_to: p.p_coverage_to, rows_total: n, rows_captured: mode === 'VALIDATION' ? n : 0, rows_invalid: 0,
      reject_reason: p.p_reject_reason, previous_run_id: latest?.id ?? null, lines_new: mode === 'NORMAL' ? n - ctl : 0, lines_known: 0,
      rows_ignored: mode === 'NORMAL' ? ctl : 0, file_name: p.p_file_name, byte_size: p.p_byte_size, source_meta: p.p_source_meta });
    return Promise.resolve(mode === 'NORMAL' ? { run_id: id, replayed: false, backfills_created: 1, backfills_existing: 0, yields_applied: 1, yields_not_applied: 0 }
      : { run_id: id, replayed: false });
  };
  const deps: IngestDeps = {
    authorize: (h) => Promise.resolve(TOKENS[(h ?? '').replace(/^Bearer /, '')] ?? { ok: false, status: 401, code: 'NOT_AUTHENTICATED' }),
    loadMpAccount: () => Promise.resolve(MP_ACC),
    loadRun: (id) => Promise.resolve(runs.get(id) ?? null),
    mp: fake.mp,
    download: (p) => Promise.resolve(storage.get(p) ?? null),
    upload: (p, b) => { uploads.push(p); if (storage.has(p)) return Promise.resolve('exists' as const); storage.set(p, b); return Promise.resolve('created' as const); },
    capture: (p) => { captures.push(p); return record('VALIDATION', p); },
    ingest: (p) => { ingests.push(p); return record('NORMAL', p); },
    recordDestinations: (p) => {
      if (destFail) return Promise.reject(new CaptureRpcError('DESTINATION_CONFLICT: row 2 already holds another value'));
      dests.push(p);
      for (const it of p.p_items) {
        const k = p.p_run_id + ':' + it.row_number;
        if (destStore.has(k) && destStore.get(k) !== it.value) return Promise.reject(new CaptureRpcError('DESTINATION_CONFLICT'));
        destStore.set(k, it.value);
      }
      return Promise.resolve(p.p_items.length);
    },
    sha256: async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))).map((x) => x.toString(16).padStart(2, '0')).join(''),
    sleep: () => { sleeps++; return Promise.resolve(); },
    log: (e) => logs.push(e),
    now: () => NOW,
  };
  return { deps, s, calls: fake.calls, bodies: fake.bodies, storage, uploads, captures, ingests, runs, logs, dests, destStore, failDest: () => { destFail = true; }, sleeps: () => sleeps };
}
const post = (body: unknown, token = 'admin', type = 'application/json') =>
  new Request('http://local/mp-report-ingest', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const capture = (date = '2026-10-05', extra: Record<string, unknown> = {}) => post({ action: 'capture', date, ...extra });
const read = async (res: Response) => ({ status: res.status, body: await res.json() });
const noLeak = (h: ReturnType<typeof harness>, texts: string[]) => {
  const all = JSON.stringify(h.logs) + texts.join('');
  for (const secret of ['owner-private@example.invalid', 'release-report-PRIVATE', '900000000001', 'Bearer admin']) assert(!all.includes(secret), `leak: ${secret}`);
};

// ── parser / helpers ──────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('config: the frozen 15 columns are compatible; only whitelisted fields are kept as evidence', () => {
  const c = checkReleaseConfig(CONFIG);
  assertEquals([c.compatible, c.problems, c.separator], [true, [], ';']);
  assertEquals(c.evidence.columns, HEADER.split(';'));
  assertEquals(c.evidence.other_keys, ['file_name_prefix', 'notification_email_list']);
  assert(!JSON.stringify(c.evidence).includes('owner-private') && !JSON.stringify(c.evidence).includes('PRIVATE'));
});

Deno.test('config: missing / unexpected / duplicated column, bad separator, non-CSV format → incompatible, each reported', () => {
  const cols = COLUMNS.filter((c) => c.key !== 'PURCHASE_ID');
  assertEquals(checkReleaseConfig({ ...CONFIG, columns: cols }).problems, ['COLUMN_MISSING:PURCHASE_ID']);
  assertEquals(checkReleaseConfig({ ...CONFIG, columns: [...COLUMNS, { key: 'EXTERNAL_REFERENCE' }] }).problems, ['COLUMN_UNEXPECTED:EXTERNAL_REFERENCE']);
  assertEquals(checkReleaseConfig({ ...CONFIG, columns: [...COLUMNS, { key: 'DATE' }] }).problems, ['COLUMN_DUPLICATED:DATE']);
  assertEquals(checkReleaseConfig({ ...CONFIG, separator: '|' }).problems, ['SEPARATOR_UNSUPPORTED']);
  assertEquals(checkReleaseConfig({ ...CONFIG, format: 'xlsx' }).problems, ['FORMAT_UNSUPPORTED']);
  assertEquals(checkReleaseConfig({ ...CONFIG, columns: undefined }).problems, ['COLUMNS_MISSING']);
  assertEquals(checkReleaseConfig([]).compatible, false);
});

Deno.test('window: one Buenos Aires business day in UTC; invalid, today and future days refused', () => {
  assertEquals(businessDayWindow('2026-10-05', NOW), WINDOW);
  assertEquals(businessDayWindow('2026-12-31', Date.parse('2027-01-02T00:00:00Z')), { begin_date: '2026-12-31T03:00:00Z', end_date: '2027-01-01T02:59:59Z' });
  assertEquals(businessDayWindow('2026-10-12', NOW), { begin_date: '2026-10-12T03:00:00Z', end_date: '2026-10-13T02:59:59Z' });
  for (const d of ['2026-10-13', '2026-10-14', '2026-02-30', '05/10/2026', '2026-1-5', '']) assertEquals(businessDayWindow(d, NOW), null, d);
});

Deno.test('parser: real layout → header, raw rows with exact strings (control rows kept), CRLF and BOM accepted', () => {
  const p = parseReleaseReport(csv(), ';');
  assert(p.ok);
  assertEquals([p.separator, p.line_ending, p.has_bom, p.rows.length], [';', 'LF', false, 5]);
  assertEquals(p.rows[1], { row_number: 2, raw_row: Object.fromEntries(HEADER.split(';').map((k, i) => [k, LINES[1].split(';')[i]])) });
  assertEquals(Object.keys(p.rows[0].raw_row).sort(), [...EXPECTED_COLUMNS]);
  assertEquals(p.summary.descriptions, { '': 2, payment: 1, asset_management: 1, payout: 1 });
  const q = parseReleaseReport(new Uint8Array([0xef, 0xbb, 0xbf, ...csv(LINES, '\r\n')]), null);
  assert(q.ok);
  assertEquals([q.separator, q.line_ending, q.has_bom, q.rows.length], [';', 'CRLF', true, 5]);
});

Deno.test('parser: fail closed on every file-level defect', () => {
  const rej = (b: Uint8Array, sep: ';' | ',' | null = ';') => { const p = parseReleaseReport(b, sep); return p.ok ? 'OK' : p.reject_reason.split(':')[0]; };
  assertEquals(rej(new Uint8Array([0x44, 0xff, 0xfe])), 'ENCODING_INVALID');
  assertEquals(rej(enc('')), 'EMPTY_FILE');
  assertEquals(rej(enc(HEADER + '\n')), 'EMPTY_FILE');
  assertEquals(rej(csv(LINES, '\n', HEADER.replace(';PURCHASE_ID', ''))), 'HEADER_MISMATCH');
  assertEquals(rej(csv(LINES, '\n', HEADER + ';EXTERNAL_REFERENCE')), 'HEADER_MISMATCH');
  assertEquals(rej(csv(LINES, '\n', HEADER.replace('SUB_UNIT', 'DATE'))), 'HEADER_MISMATCH');
  assertEquals(rej(csv([LINES[0], LINES[1] + ';extra'])), 'FIELD_COUNT_MISMATCH');
  assertEquals(rej(csv([LINES[0], '', LINES[1]])), 'EMPTY_LINE');
  assertEquals(rej(csv([LINES[1].replace('payment', '"payment"')])), 'QUOTED_FIELDS_UNSUPPORTED');
  assertEquals(rej(enc(`${HEADER}\r\n${LINES[0]}\n${LINES[1]}\n`)), 'LINE_ENDING_AMBIGUOUS');
  assertEquals(rej(enc(`${HEADER}\r${LINES[0]}\r`)), 'LINE_ENDING_INVALID');
  assertEquals(rej(csv([LINES[1].replace('cvu', 'c\u0001vu')])), 'CONTROL_CHARACTER');
  assertEquals(rej(csv(), ','), 'HEADER_MISMATCH');                       // configured separator differs from the file
  assertEquals(rej(enc(HEADER.replaceAll(';', '\t') + '\n'), null), 'SEPARATOR_AMBIGUOUS');
});

// ── handler ───────────────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('auth: no JWT / OPERATOR refused before any Mercado Pago call; non-JSON and unknown fields refused', async () => {
  for (const [tok, code] of [['none', 401], ['operator', 403]] as const) {
    const h = harness();
    assertEquals((await handleIngest(post({ action: 'config' }, tok), h.deps)).status, code);
    assertEquals(h.calls, []);
  }
  const h = harness();
  assertEquals((await read(await handleIngest(post('x', 'admin', 'text/plain'), h.deps))).body.error, 'UNSUPPORTED_CONTENT_TYPE');
  assertEquals((await read(await handleIngest(post({ action: 'config', x: 1 }), h.deps))).body.error, 'UNEXPECTED_FIELD');
  assertEquals((await read(await handleIngest(capture('2026-10-05', { backfill: true }), h.deps))).body.error, 'UNEXPECTED_FIELD');
  assertEquals((await read(await handleIngest(post({ action: 'normal' }), h.deps))).body.error, 'UNKNOWN_ACTION');
  assertEquals((await handleIngest(new Request('http://local', { method: 'GET' }), h.deps)).status, 405);
  assertEquals((await handleIngest(new Request('http://local', { method: 'OPTIONS' }), h.deps)).status, 204);
  assertEquals(h.calls, []);
});

Deno.test('config action: read-only GET config, sanitized answer', async () => {
  const h = harness();
  const r = await read(await handleIngest(post({ action: 'config' }), h.deps));
  assertEquals(r.status, 200);
  assertEquals([r.body.compatible, r.body.problems, r.body.config.columns.length], [true, [], 15]);
  assertEquals(h.calls, ['GET /v1/account/release_report/config']);
  noLeak(h, [JSON.stringify(r.body)]);
  const bad = harness({ config: { ...CONFIG, columns: COLUMNS.slice(1) } });
  const rb = await read(await handleIngest(post({ action: 'config' }), bad.deps));
  assertEquals([rb.status, rb.body.compatible, rb.body.problems], [200, false, [`COLUMN_MISSING:${COLUMNS[0].key}`]]);
});

Deno.test('capture: config → POST window → poll → download → canonical evidence → VALIDATION capture', async () => {
  const h = harness();
  const r = await read(await handleIngest(capture(), h.deps));
  assertEquals(r.status, 200);
  assertEquals(h.calls, [
    'GET /v1/account/release_report/config', 'POST /v1/account/release_report',
    'GET /v1/account/release_report/task/777', 'GET /v1/account/release_report/task/777', 'GET /v1/account/release_report/release-report-777.csv',
  ]);
  assertEquals(h.bodies, [WINDOW]);
  assertEquals(h.sleeps(), 1);
  const bytes = csv();
  const sha = await h.deps.sha256(bytes);
  assertEquals(h.uploads, [canonicalPath(MP_ACC, sha)]);
  assertEquals(h.storage.get(`mp/${MP_ACC}/${sha}.csv`), bytes);
  const p = h.captures[0];
  assertEquals([p.p_actor, p.p_parser_version, p.p_format_code, p.p_file_sha256, p.p_storage_path, p.p_byte_size, p.p_coverage_from, p.p_coverage_to, p.p_reject_reason],
    [ADMIN, PARSER_VERSION, FORMAT_CODE, sha, `mp/${MP_ACC}/${sha}.csv`, bytes.length, '2026-10-05', '2026-10-05', null]);
  assertEquals((p.p_rows as { row_number: number }[]).map((x) => x.row_number), [1, 2, 3, 4, 5]);
  assertEquals(Object.keys((p.p_rows as { raw_row: object }[])[0]).sort(), ['raw_row', 'row_number']);
  const meta = p.p_source_meta as Record<string, unknown>;
  assertEquals([meta.report_type, meta.task_id, meta.mp_file_name, meta.business_day, meta.begin_date, meta.end_date],
    ['release_report', '777', 'release-report-777.csv', '2026-10-05', WINDOW.begin_date, WINDOW.end_date]);
  assertEquals((meta.config as { other_keys: string[] }).other_keys, ['file_name_prefix', 'notification_email_list']);
  assertEquals([r.body.mode, r.body.status, r.body.replayed, r.body.counters.rows_total, r.body.task_id, r.body.evidence], ['VALIDATION', 'VALIDATED', false, 5, '777', 'created']);
  noLeak(h, [JSON.stringify(r.body), JSON.stringify(meta)]);
});

Deno.test('capture: never writes the configuration, never calls an endpoint outside the five documented ones', async () => {
  const h = harness();
  await handleIngest(capture(), h.deps);
  await handleIngest(post({ action: 'config' }), h.deps);
  for (const c of h.calls) assertMatch(c, /^(GET \/v1\/account\/release_report\/(config|task\/\d+|list|[A-Za-z0-9._%-]+)|POST \/v1\/account\/release_report)$/);
  assert(!h.calls.some((c) => c.startsWith('PUT') || c === 'POST /v1/account/release_report/config'));
});

Deno.test('capture replay: same report → same bytes reused (no second upload), the database replays the run', async () => {
  const h = harness({ tasks: { '777': [processed()] } });
  const a = await read(await handleIngest(capture(), h.deps));
  const b = await read(await handleIngest(capture(), h.deps));
  assertEquals([a.body.run_id === b.body.run_id, b.body.replayed, b.body.evidence, h.uploads.length, h.storage.size], [true, true, 'reused', 1, 1]);
});

Deno.test('capture: incompatible configuration stops before any report request; nothing stored', async () => {
  const h = harness({ config: { ...CONFIG, columns: [...COLUMNS, { key: 'EXTERNAL_REFERENCE' }] } });
  const r = await read(await handleIngest(capture(), h.deps));
  assertEquals([r.status, r.body.error, r.body.problems], [422, 'CONFIG_INCOMPATIBLE', ['COLUMN_UNEXPECTED:EXTERNAL_REFERENCE']]);
  assertEquals([h.calls, h.storage.size, h.captures.length], [['GET /v1/account/release_report/config'], 0, 0]);
  const u = harness({ configStatus: 401 });
  assertEquals((await read(await handleIngest(capture(), u.deps))).body.error, 'MP_CONFIG_UNAVAILABLE');
});

Deno.test('capture: invalid / today / future date refused before any call', async () => {
  for (const d of ['2026-10-13', '2026-11-01', '2026-02-30', 'x']) {
    const h = harness();
    const r = await read(await handleIngest(capture(d), h.deps));
    assertEquals([r.status, r.body.error, h.calls.length], [400, 'INVALID_DATE', 0], d);
  }
  const h = harness();
  assertEquals((await read(await handleIngest(capture('2026-10-05', { task_id: 'abc' }), h.deps))).body.error, 'INVALID_TASK_ID');
});

Deno.test('capture: task failure / window mismatch / timeout → error with task id, nothing stored; resume polls only', async () => {
  const failed = harness({ tasks: { '777': [{ id: 777, status: 'failed', ...WINDOW }] } });
  const f = await read(await handleIngest(capture(), failed.deps));
  assertEquals([f.status, f.body.error, f.body.task_id, failed.storage.size], [502, 'MP_TASK_FAILED', '777', 0]);

  const shifted = harness({ tasks: { '777': [processed({ begin_date: '2026-10-05T00:00:00Z' })] } });
  assertEquals((await read(await handleIngest(capture(), shifted.deps))).body.error, 'MP_TASK_WINDOW_MISMATCH');

  const slow = harness({ tasks: { '777': [{ id: 777, status: 'pending', ...WINDOW }] } });
  const t = await read(await handleIngest(capture(), slow.deps));
  assertEquals([t.status, t.body.error, t.body.task_id, slow.sleeps(), slow.storage.size], [504, 'MP_TASK_TIMEOUT', '777', MAX_POLLS - 1, 0]);
  assertEquals(slow.calls.filter((c) => c.includes('/task/')).length, MAX_POLLS);

  slow.s.tasks['777'] = [processed()];
  const resumed = await read(await handleIngest(capture('2026-10-05', { task_id: '777' }), slow.deps));
  assertEquals(resumed.status, 200);
  assertEquals(slow.calls.filter((c) => c.startsWith('POST')).length, 1);   // the resume requested no new report

  const other = harness({ tasks: { '778': [processed({ id: 778, begin_date: '2026-10-04T03:00:00Z', end_date: '2026-10-05T02:59:59Z' })] } });
  assertEquals((await read(await handleIngest(capture('2026-10-05', { task_id: 778 }), other.deps))).body.error, 'MP_TASK_WINDOW_MISMATCH');

  const noId = harness({ created: { status: 'pending' } });
  assertEquals((await read(await handleIngest(capture(), noId.deps))).body.error, 'MP_RESPONSE_INCONSISTENT');
  const down = harness({ createStatus: 500 });
  assertEquals((await read(await handleIngest(capture(), down.deps))).body.error, 'MP_REPORT_REQUEST_FAILED');
});

Deno.test('capture: file_name from the report list when the task has none; ambiguous or missing → fail closed', async () => {
  const task = { id: 777, report_id: 5150, status: 'processed', ...WINDOW };
  const h = harness({ tasks: { '777': [task] }, list: [{ id: 5150, file_name: 'release-report-777.csv' }, { id: 1, file_name: 'other.csv' }] });
  assertEquals((await handleIngest(capture(), h.deps)).status, 200);
  assert(h.calls.includes('GET /v1/account/release_report/list'));
  const two = harness({ tasks: { '777': [task] }, list: [{ id: 5150, file_name: 'a.csv' }, { report_id: 5150, file_name: 'b.csv' }] });
  assertEquals((await read(await handleIngest(capture(), two.deps))).body.error, 'MP_FILE_UNRESOLVED');
  const none = harness({ tasks: { '777': [task] }, list: [] });
  assertEquals((await read(await handleIngest(capture(), none.deps))).body.error, 'MP_FILE_UNRESOLVED');
  const xlsx = harness({ tasks: { '777': [processed({ file_name: 'release-report-777.xlsx' })] } });
  const x = await read(await handleIngest(capture(), xlsx.deps));
  assertEquals([x.status, x.body.error, xlsx.storage.size], [422, 'FORMAT_UNSUPPORTED', 0]);
  const traversal = harness({ tasks: { '777': [processed({ file_name: '../config' })] } });
  assertEquals((await read(await handleIngest(capture(), traversal.deps))).body.error, 'MP_RESPONSE_INCONSISTENT');
});

Deno.test('capture: download failure / empty / too large → nothing stored', async () => {
  const fail = harness({ downloadStatus: 500 });
  assertEquals((await read(await handleIngest(capture(), fail.deps))).body.error, 'MP_DOWNLOAD_FAILED');
  const empty = harness({ files: { 'release-report-777.csv': new Uint8Array() } });
  assertEquals((await read(await handleIngest(capture(), empty.deps))).body.error, 'MP_EMPTY_DOWNLOAD');
  const big = harness({ files: { 'release-report-777.csv': new Uint8Array(MAX_FILE_BYTES + 1) } });
  assertEquals((await read(await handleIngest(capture(), big.deps))).status, 413);
  for (const h of [fail, empty, big]) assertEquals([h.storage.size, h.captures.length], [0, 0]);
});

Deno.test('capture: corrupt file → original stored, REJECTED VALIDATION run with format NULL and no rows', async () => {
  const bad = new Uint8Array([0x44, 0x41, 0xff, 0xfe, 0x0a]);
  const h = harness({ files: { 'release-report-777.csv': bad } });
  const r = await read(await handleIngest(capture(), h.deps));
  assertEquals([r.status, r.body.status, h.storage.size], [200, 'REJECTED', 1]);
  const p = h.captures[0];
  assertEquals([p.p_format_code, p.p_rows, (p.p_reject_reason ?? '').split(':')[0]], [null, null, 'ENCODING_INVALID']);
  assertEquals((p.p_source_meta as { file: unknown }).file, null);
  const hdr = harness({ files: { 'release-report-777.csv': csv(LINES, '\n', HEADER.replace(';PURCHASE_ID', '')) } });
  await handleIngest(capture(), hdr.deps);
  assertMatch(hdr.captures[0].p_reject_reason ?? '', /^HEADER_MISMATCH: missing \[PURCHASE_ID\]/);
});

Deno.test('capture: database refusals map to codes; stored evidence with other bytes → EVIDENCE_INTEGRITY', async () => {
  const h = harness();
  h.deps.capture = () => Promise.reject(new CaptureRpcError('FORBIDDEN: the initiating actor is not an active ADMIN'));
  assertEquals((await read(await handleIngest(capture(), h.deps))).body.error, 'FORBIDDEN');
  const g = harness();
  g.deps.capture = () => Promise.reject(new CaptureRpcError('INVALID_ROWS_CONTRACT: x'));
  assertEquals((await read(await handleIngest(capture(), g.deps))).body, { error: 'CAPTURE_FAILED' });
  const t = harness();
  const sha = await t.deps.sha256(csv());
  t.storage.set(`mp/${MP_ACC}/${sha}.csv`, enc('tampered'));
  assertEquals((await read(await handleIngest(capture(), t.deps))).body.error, 'EVIDENCE_INTEGRITY');
  assertEquals(t.captures.length, 0);
  const n = harness();
  n.deps.loadMpAccount = () => Promise.resolve(null);
  assertEquals((await read(await handleIngest(capture(), n.deps))).body.error, 'MP_ACCOUNT_MISSING');
});

Deno.test('MP transport failure → MP_UNREACHABLE; internal errors never echo details', async () => {
  const h = harness();
  h.deps.mp = () => Promise.reject(new Error('timeout token=SECRET'));
  const r = await read(await handleIngest(capture(), h.deps));
  assertEquals(r.body, { error: 'MP_UNREACHABLE' });
  const i = harness();
  i.deps.download = () => Promise.reject(new Error('storage exploded SECRET'));
  const ri = await read(await handleIngest(capture(), i.deps));
  assertEquals([ri.status, ri.body], [500, { error: 'INTERNAL' }]);
  assert(!JSON.stringify([...h.logs, ...i.logs]).includes('SECRET'));
});

// ── NORMAL (0079) ─────────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('capture mode NORMAL: same MP flow and evidence, recorded by the NORMAL ingestion (back-fills / yields reported)', async () => {
  const h = harness();
  const r = await read(await handleIngest(capture('2026-10-05', { mode: 'NORMAL' }), h.deps));
  assertEquals([r.status, r.body.mode, r.body.status, h.captures.length, h.ingests.length], [200, 'NORMAL', 'PARSED', 0, 1]);
  assertEquals(r.body.counters, { rows_total: 5, lines_new: 3, lines_known: 0, rows_ignored: 2, rows_invalid: 0 });
  assertEquals(r.body.effects, { backfills_created: 1, backfills_existing: 0, yields_applied: 1, yields_not_applied: 0 });
  assertEquals(h.ingests[0].p_format_code, FORMAT_CODE);
  assertEquals(h.calls.filter((c) => c.startsWith('POST')).length, 1);
  noLeak(h, [JSON.stringify(r.body)]);
  const bad = harness();
  assertEquals((await read(await handleIngest(capture('2026-10-05', { mode: 'normal' }), bad.deps))).body.error, 'INVALID_MODE');
  assertEquals(bad.calls, []);
});

Deno.test('process: NORMAL over the stored bytes of a VALIDATED capture, no Mercado Pago call, previous_run_id linked', async () => {
  const h = harness({ tasks: { '777': [processed()] } });
  const v = await read(await handleIngest(capture(), h.deps));
  const before = h.calls.length;
  const r = await read(await handleIngest(post({ action: 'process', run_id: v.body.run_id }), h.deps));
  assertEquals([r.status, r.body.mode, r.body.status, r.body.previous_run_id, r.body.evidence], [200, 'NORMAL', 'PARSED', v.body.run_id, 'reused']);
  assertEquals(h.calls.length, before);                         // no MP call at all
  assertEquals(h.uploads.length, 1);                            // the original is not stored again
  assertEquals((h.ingests[0].p_source_meta as { processed_from_run: string }).processed_from_run, v.body.run_id);
  assertEquals([h.ingests[0].p_coverage_from, h.ingests[0].p_file_sha256], ['2026-10-05', v.body.file_sha256]);
  const again = await read(await handleIngest(post({ action: 'process', run_id: v.body.run_id }), h.deps));
  assertEquals([again.body.replayed, again.body.run_id, again.body.effects], [true, r.body.run_id, undefined]);
});

Deno.test('process: refuses a non-validated run, a foreign run, a tampered or missing original, and bad input', async () => {
  const h = harness({ tasks: { '777': [processed()] } });
  const v = await read(await handleIngest(capture(), h.deps));
  const n = await read(await handleIngest(post({ action: 'process', run_id: v.body.run_id }), h.deps));
  assertEquals((await read(await handleIngest(post({ action: 'process', run_id: n.body.run_id }), h.deps))).body.error, 'ALREADY_PROCESSED');
  assertEquals((await read(await handleIngest(post({ action: 'process', run_id: crypto.randomUUID() }), h.deps))).body.error, 'RUN_NOT_FOUND');
  assertEquals((await read(await handleIngest(post({ action: 'process', run_id: 'x' }), h.deps))).body.error, 'INVALID_RUN_ID');
  assertEquals((await read(await handleIngest(post({ action: 'process', run_id: v.body.run_id, mode: 'NORMAL' }), h.deps))).body.error, 'UNEXPECTED_FIELD');
  const run = h.runs.get(v.body.run_id) as RunRow;
  h.runs.set(run.id, { ...run, financial_account_id: 'aaaaaaaa-0000-4000-8000-000000000001' });
  assertEquals((await read(await handleIngest(post({ action: 'process', run_id: run.id }), h.deps))).body.error, 'NOT_AN_MP_REPORT_RUN');
  h.runs.set(run.id, run);
  h.storage.set(run.storage_path, enc('tampered'));
  assertEquals((await read(await handleIngest(post({ action: 'process', run_id: run.id }), h.deps))).body.error, 'EVIDENCE_INTEGRITY');
  h.storage.delete(run.storage_path);
  assertEquals((await read(await handleIngest(post({ action: 'process', run_id: run.id }), h.deps))).body.error, 'EVIDENCE_MISSING');
  assertEquals(h.ingests.length, 1);
});

Deno.test('process: a REJECTED run (e.g. an empty day under parser 1.0.0) is reprocessed from its stored bytes with the current parser', async () => {
  const h = harness({ tasks: { '777': [processed()] } });
  const v = await read(await handleIngest(capture(), h.deps));
  const stored = h.runs.get(v.body.run_id) as RunRow;
  // a REJECTED NORMAL attempt over the same bytes made by the previous parser version
  const rejected = { ...stored, id: crypto.randomUUID(), mode: 'NORMAL', status: 'REJECTED', parser_version: 'mp-release-report-csv/1.0.0',
    reject_reason: 'NO_MOVEMENT_ROWS: the report has no movement row' };
  h.runs.set(rejected.id, rejected);
  const before = h.calls.length;
  const r = await read(await handleIngest(post({ action: 'process', run_id: rejected.id }), h.deps));
  assertEquals([r.status, r.body.mode, r.body.status, r.body.parser_version, r.body.evidence], [200, 'NORMAL', 'PARSED', PARSER_VERSION, 'reused']);
  assertEquals(PARSER_VERSION, 'mp-release-report-csv/1.2.0');
  assertEquals([h.calls.length, h.uploads.length], [before, 1]);   // no Mercado Pago call, no second upload
  assertEquals(h.ingests[0].p_file_sha256, stored.file_sha256);
});

// ── parser 1.2.0: optional PAYOUT_BANK_ACCOUNT_NUMBER ────────────────────────────────────────────────────────────────
const DEST = '0110999900000099999999';            // synthetic, never a real account
const HEADER16 = HEADER + ';PAYOUT_BANK_ACCOUNT_NUMBER';
const LINES16 = LINES.map((l) => l + (l.includes(';payout;') ? `; ${DEST} ` : ';'));
const csv16 = (lines = LINES16) => enc([HEADER16, ...lines].join('\n') + '\n');
const CONFIG16 = { ...CONFIG, columns: [...COLUMNS, { key: 'PAYOUT_BANK_ACCOUNT_NUMBER' }] };
const leaksDest = (h: ReturnType<typeof harness>, texts: string[]) =>
  (JSON.stringify(h.logs) + JSON.stringify(h.ingests) + JSON.stringify(h.captures) + texts.join('')).includes(DEST);

Deno.test('1.2.0 config: the 15 columns alone, or + PAYOUT_BANK_ACCOUNT_NUMBER, are compatible; any other extra column is not', () => {
  assertEquals([checkReleaseConfig(CONFIG).compatible, checkReleaseConfig(CONFIG16).compatible], [true, true]);
  assertEquals(checkReleaseConfig({ ...CONFIG16, columns: [...CONFIG16.columns, { key: 'EXTERNAL_REFERENCE' }] }).problems, ['COLUMN_UNEXPECTED:EXTERNAL_REFERENCE']);
  assertEquals(checkReleaseConfig({ ...CONFIG16, columns: CONFIG16.columns.slice(1) }).problems, ['COLUMN_MISSING:DATE']);
});

Deno.test('1.2.0 parser: 15-column file unchanged; 16-column file → same 15-key raw_row, destination apart; 17th column rejects', () => {
  const p15 = parseReleaseReport(csv(), ';'); const p16 = parseReleaseReport(csv16(), ';');
  assert(p15.ok && p16.ok);
  if (!p15.ok || !p16.ok) return;
  assertEquals(p16.rows, p15.rows);                                       // identical rows → identical D1 identity
  assert(p16.rows.every((r) => Object.keys(r.raw_row).length === 15 && !('PAYOUT_BANK_ACCOUNT_NUMBER' in r.raw_row)));
  assertEquals([p15.destinations, p15.summary.destination_column, p15.summary.destinations], [[], false, 0]);
  assertEquals(p16.destinations, [{ row_number: 4, value: ` ${DEST} ` }]); // original string kept (trim is the DB's job)
  assertEquals([p16.summary.destination_column, p16.summary.destinations], [true, 1]);
  const p16auto = parseReleaseReport(csv16(), null);                       // separator detection with 16 columns
  assert(p16auto.ok && p16auto.separator === ';');
  const p17 = parseReleaseReport(enc([HEADER16 + ';ITEM_ID', ...LINES16.map((l) => l + ';')].join('\n') + '\n'), ';');
  assert(!p17.ok && /^HEADER_MISMATCH: missing \[\] unexpected \[ITEM_ID\]/.test(p17.reject_reason), JSON.stringify(p17));
  const dup = parseReleaseReport(enc([HEADER16 + ';PAYOUT_BANK_ACCOUNT_NUMBER', ...LINES16.map((l) => l + ';')].join('\n') + '\n'), ';');
  assert(!dup.ok && /duplicated/.test(dup.reject_reason));
  const empty16 = parseReleaseReport(enc([HEADER16, LINES16[0], LINES16[LINES16.length - 1]].join('\n') + '\n'), ';');
  assert(empty16.ok && empty16.rows.length === 2 && empty16.destinations.length === 0);   // empty day, 16 columns
});

Deno.test('1.2.0 capture NORMAL with 16 columns: same ingestion rows; destination stored privately; count only in the response', async () => {
  const h = harness({ config: CONFIG16, files: { 'release-report-777.csv': csv16() } });
  const r = await read(await handleIngest(capture('2026-10-05', { mode: 'NORMAL' }), h.deps));
  assertEquals([r.status, r.body.status, r.body.payout_destinations], [200, 'PARSED', 1]);
  assertEquals(h.ingests[0].p_rows, (parseReleaseReport(csv(), ';') as { rows: unknown[] }).rows);   // the DB gets the 15-key rows
  assertEquals(h.dests.length, 1);
  assertEquals([h.dests[0].p_run_id, h.dests[0].p_items], [r.body.run_id, [{ row_number: 4, value: ` ${DEST} ` }]]);
  assert(!leaksDest(h, [JSON.stringify(r.body)]), 'the destination value leaked into logs / RPC params / response');
  assertEquals((h.ingests[0].p_source_meta.file as Record<string, unknown>).destinations, 1);
});

Deno.test('1.2.0 replay and 15-column reports: destination recording is idempotent; no destination call without the column', async () => {
  const h = harness({ config: CONFIG16, files: { 'release-report-777.csv': csv16() } });
  const a = await read(await handleIngest(capture('2026-10-05', { mode: 'NORMAL' }), h.deps));
  const b = await read(await handleIngest(capture('2026-10-05', { mode: 'NORMAL' }), h.deps));
  assertEquals([b.body.replayed, b.body.run_id, b.body.payout_destinations, h.destStore.size], [true, a.body.run_id, 1, 1]);
  const old = harness();
  const o = await read(await handleIngest(capture('2026-10-05', { mode: 'NORMAL' }), old.deps));
  assertEquals([o.status, o.body.payout_destinations, old.dests.length], [200, 0, 0]);
});

Deno.test('1.2.0 VALIDATION and process: destinations follow the run; a refused recording → 500 without the value', async () => {
  const h = harness({ config: CONFIG16, files: { 'release-report-777.csv': csv16() } });
  const v = await read(await handleIngest(capture(), h.deps));
  assertEquals([v.body.status, v.body.payout_destinations], ['VALIDATED', 1]);
  const p = await read(await handleIngest(post({ action: 'process', run_id: v.body.run_id }), h.deps));
  assertEquals([p.body.status, p.body.payout_destinations, h.dests.length], ['PARSED', 1, 2]);
  const f = harness({ config: CONFIG16, files: { 'release-report-777.csv': csv16() } });
  f.failDest();
  const e = await read(await handleIngest(capture('2026-10-05', { mode: 'NORMAL' }), f.deps));
  assertEquals([e.status, e.body.error], [500, 'DESTINATION_RECORD_FAILED']);
  assert(!leaksDest(f, [JSON.stringify(e.body)]));
});
