/**
 * ADR-018 §9.1 — mp-report-daily (scheduler) handler tests (Deno, no network). The runtime-agnostic handler runs against
 * an in-memory fake of the Mercado Pago release report API, Storage, the NORMAL ingestion and the scheduler log, with the
 * REAL parser over SYNTHETIC Liberaciones files. Proves: the previous Buenos Aires day (normal day, near midnight UTC,
 * month change, year change, leap day), invocation secret, NORMAL with actor NULL, SUCCESS / SUCCESS_EMPTY /
 * ALREADY_PROCESSED / FAILED, resume of a timed-out task, parser rejection, incompatible configuration, duplicate
 * execution, a failed log write, and that no secret or report content leaks.
 *
 *   deno test --node-modules-dir=none --allow-read scripts/adr018/mp-report-daily-handler.test.ts
 */
// deno-lint-ignore no-import-prefix -- pinned test-only dependency (no deno.json in this repository)
import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { previousBusinessDay } from '../../supabase/functions/_shared/mp-release-report.ts';
import { type CaptureParams, type LogEntry, type RunRow } from '../../supabase/functions/mp-report-ingest/handler.ts';
import { type DailyDeps, handleDaily, type ScheduleRecord, SECRET_HEADER } from '../../supabase/functions/mp-report-daily/handler.ts';

const SECRET = 'test-only-invoke-secret';
const MP_ACC = 'aaaaaaaa-0000-4000-8000-000000000099';
const NOW = Date.parse('2026-10-14T10:00:00Z');            // 07:00 in Buenos Aires → target 2026-10-13
const TARGET = '2026-10-13';
const WINDOW = { begin_date: '2026-10-13T03:00:00Z', end_date: '2026-10-14T02:59:59Z' };
const enc = (s: string) => new TextEncoder().encode(s);

const HEADER = 'DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;TRANSACTION_APPROVAL_DATE;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID';
const OPEN = '2026-10-13T00:00:00.000-03:00;;;1000.00;0.00;1000.00;0.00;0.00;;;;;1000.00;;';
const LINES = [
  OPEN,
  '2026-10-13T08:00:00.000-03:00;900000000001;payment;8946.00;0.00;9000.00;0.00;-54.00;cvu;2026-10-13T08:00:00.000-03:00;;;9946.00;bank_transfer;',
  '2026-10-13T10:00:00.000-03:00;900000000003;asset_management;12.34;0.00;12.34;0.00;0.00;;2026-10-13T10:00:00.000-03:00;;;9958.34;;',
  '2026-10-13T11:00:01.000-03:00;900000000004;payout;0.00;200.00;-200.00;0.00;0.00;available_money;2026-10-13T11:00:01.000-03:00;;;9758.34;;',
  ';;;8758.34;0.00;8812.34;0.00;-54.00;;;;;0.00;;',
];
const EMPTY = [OPEN, ';;;0.00;0.00;0.00;0.00;0.00;;;;;0.00;;'];
const csv = (lines: string[]) => enc([HEADER, ...lines].join('\n') + '\n');
const CONFIG = { columns: HEADER.split(';').map((key) => ({ key })), separator: ';', notification_email_list: ['owner-private@example.invalid'] };

interface Opts { config?: unknown; file?: Uint8Array; taskAnswers?: string[]; processedRun?: string | null; recordFails?: boolean }

function harness(o: Opts = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let polls = 0;
  const answers = o.taskAnswers ?? ['pending', 'processed'];
  const file = o.file ?? csv(LINES);
  const mp = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> => {
    calls.push(`${method} ${path}`);
    if (body !== undefined) bodies.push(body);
    const j = (status: number, v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status }));
    const base = '/v1/account/release_report';
    if (method === 'GET' && path === `${base}/config`) return j(200, o.config ?? CONFIG);
    if (method === 'POST' && path === base) return j(202, { id: 777, status: 'pending', ...(body as object) });
    if (method === 'GET' && path === `${base}/task/777`) {
      const st = answers[Math.min(polls++, answers.length - 1)];
      return j(200, { id: 777, status: st, ...WINDOW, ...(st === 'processed' ? { file_name: 'release-report-777.csv' } : {}) });
    }
    if (method === 'GET' && path === `${base}/release-report-777.csv`) return Promise.resolve(new Response(file as Uint8Array<ArrayBuffer>, { status: 200 }));
    return j(404, { message: 'unexpected endpoint' });
  };
  const storage = new Map<string, Uint8Array>();
  const runs = new Map<string, RunRow>();
  const ingests: CaptureParams[] = [];
  const records: ScheduleRecord[] = [];
  const logs: LogEntry[] = [];
  // in-memory stand-in for fin_ingest_mp_release_report (real behaviour proven by the DB suites): replay by bytes
  const ingest = (p: CaptureParams) => {
    ingests.push(p);
    const prior = [...runs.values()].find((r) => r.mode === 'NORMAL' && r.file_sha256 === p.p_file_sha256);
    if (prior) return Promise.resolve({ run_id: prior.id, status: prior.status, replayed: true });
    const id = crypto.randomUUID();
    const n = p.p_rows?.length ?? 0;
    runs.set(id, { id, source_kind: 'MP_RELEASE_REPORT', mode: 'NORMAL', status: p.p_reject_reason ? 'REJECTED' : 'PARSED', financial_account_id: MP_ACC,
      format_code: p.p_format_code, parser_version: p.p_parser_version, file_sha256: p.p_file_sha256, storage_path: p.p_storage_path,
      coverage_from: p.p_coverage_from, coverage_to: p.p_coverage_to, rows_total: n, rows_captured: 0, rows_invalid: 0, reject_reason: p.p_reject_reason,
      previous_run_id: null, lines_new: n, lines_known: 0, rows_ignored: 0, file_name: p.p_file_name, byte_size: p.p_byte_size, source_meta: p.p_source_meta });
    return Promise.resolve({ run_id: id, replayed: false, backfills_created: 1, backfills_existing: 0, yields_applied: 1, yields_not_applied: 0 });
  };
  const deps: DailyDeps = {
    secretMatches: (g) => g === SECRET,
    loadMpAccount: () => Promise.resolve(MP_ACC),
    loadRun: (id) => Promise.resolve(runs.get(id) ?? null),
    mp,
    download: (p) => Promise.resolve(storage.get(p) ?? null),
    upload: (p, b) => { if (storage.has(p)) return Promise.resolve('exists' as const); storage.set(p, b); return Promise.resolve('created' as const); },
    capture: () => Promise.reject(new Error('VALIDATION must never be used by the scheduler')),
    ingest,
    recordDestinations: (p) => Promise.resolve(p.p_items.length),
    sha256: async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))).map((x) => x.toString(16).padStart(2, '0')).join(''),
    sleep: () => Promise.resolve(),
    log: (e) => logs.push(e),
    now: () => NOW,
    findProcessedRun: (acc, date) => Promise.resolve(o.processedRun !== undefined ? o.processedRun
      : [...runs.values()].find((r) => r.financial_account_id === acc && r.status === 'PARSED' && r.coverage_from === date)?.id ?? null),
    lastSchedule: (date) => {
      const r = records.filter((x) => x.p_target_date === date).pop();
      return Promise.resolve(r ? { outcome: r.p_outcome, task_id: r.p_task_id, error_code: r.p_error_code } : null);
    },
    recordSchedule: (r) => { if (o.recordFails) return Promise.reject(new Error('db down')); records.push(r); return Promise.resolve(records.length); },
  };
  return { deps, calls, bodies, storage, runs, ingests, records, logs, setAnswers: (a: string[]) => { answers.splice(0, answers.length, ...a); polls = 0; } };
}
const invoke = (secret: string | null = SECRET, body = '{}', method = 'POST') =>
  new Request('http://local/mp-report-daily', { method, headers: secret === null ? {} : { [SECRET_HEADER]: secret, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : body });
const read = async (res: Response) => ({ status: res.status, body: await res.json() });
const noLeak = (h: ReturnType<typeof harness>, texts: string[]) => {
  const all = JSON.stringify(h.logs) + JSON.stringify(h.records) + texts.join('');
  for (const s of [SECRET, 'owner-private@example.invalid', '900000000001', '8946.00']) assert(!all.includes(s), `leak: ${s}`);
};

// ── target day ────────────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('target: the previous Buenos Aires calendar day, never the UTC day or a fixed date', () => {
  assertEquals(previousBusinessDay(Date.parse('2026-10-14T10:00:00Z')), '2026-10-13');   // normal day (07:00 BA)
  assertEquals(previousBusinessDay(Date.parse('2026-10-15T02:30:00Z')), '2026-10-13');   // 23:30 BA on the 14th: UTC is already the 15th
  assertEquals(previousBusinessDay(Date.parse('2026-10-15T03:00:00Z')), '2026-10-14');   // 00:00 BA on the 15th
  assertEquals(previousBusinessDay(Date.parse('2026-11-01T10:00:00Z')), '2026-10-31');   // month change
  assertEquals(previousBusinessDay(Date.parse('2027-01-01T10:00:00Z')), '2026-12-31');   // year change
  assertEquals(previousBusinessDay(Date.parse('2028-03-01T10:00:00Z')), '2028-02-29');   // leap day
  assertEquals(previousBusinessDay(Date.parse('2026-03-01T14:00:00Z')), '2026-02-28');
});

// ── authentication ──────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('auth: missing / wrong secret → 401 and wrong method → 405, before any Mercado Pago call or record', async () => {
  for (const req of [invoke(null), invoke('wrong'), invoke(`${SECRET}x`), invoke(SECRET.slice(1)), invoke(SECRET, '{}', 'GET')]) {
    const h = harness();
    const r = await read(await handleDaily(req, h.deps));
    assert(r.status === 401 || r.status === 405);
    assertEquals([h.calls.length, h.ingests.length, h.records.length], [0, 0, 0]);
    noLeak(h, [JSON.stringify(r.body)]);
  }
});

// ── outcomes ────────────────────────────────────────────────────────────────────────────────────────────────────
Deno.test('payments day → SUCCESS: NORMAL ingestion with actor NULL for yesterday, counters recorded', async () => {
  const h = harness();
  const r = await read(await handleDaily(invoke(), h.deps));
  assertEquals([r.status, r.body.outcome, r.body.target_date], [200, 'SUCCESS', TARGET]);
  assertEquals(h.bodies, [WINDOW]);                                      // exactly the Buenos Aires day of yesterday
  assertEquals(h.ingests.length, 1);
  const p = h.ingests[0];
  assertEquals([p.p_actor, p.p_coverage_from, p.p_coverage_to], [null, TARGET, TARGET]);
  assertEquals(h.records.length, 1);
  const rec = h.records[0];
  assertEquals([rec.p_outcome, rec.p_run_id, rec.p_task_id, rec.p_error_code], ['SUCCESS', r.body.run_id, '777', null]);
  assertEquals(rec.p_summary, { rows: 5, control: 2, payments_in: 1, payments_out: 0, yields: 1, payouts: 1, reserves: 0,
    backfills_created: 1, backfills_existing: 0, yields_applied: 1, yields_not_applied: 0 });
  assert(h.logs.some((l) => l.event === 'daily' && l.outcome === 'SUCCESS' && l.date === TARGET));
  noLeak(h, [JSON.stringify(r.body)]);
});

Deno.test('empty day (only CONTROL rows) → SUCCESS_EMPTY, not an error', async () => {
  const h = harness({ file: csv(EMPTY) });
  const r = await read(await handleDaily(invoke(), h.deps));
  assertEquals([r.status, r.body.outcome, r.body.error_code], [200, 'SUCCESS_EMPTY', null]);
  assertEquals([h.records[0].p_summary.rows, h.records[0].p_summary.control], [2, 2]);
});

Deno.test('already processed day → ALREADY_PROCESSED with that run, no Mercado Pago call, no ingestion', async () => {
  const run = 'bbbbbbbb-0000-4000-8000-000000000001';
  const h = harness({ processedRun: run });
  const r = await read(await handleDaily(invoke(), h.deps));
  assertEquals([r.status, r.body.outcome, r.body.run_id], [200, 'ALREADY_PROCESSED', run]);
  assertEquals([h.calls.length, h.ingests.length], [0, 0]);
});

Deno.test('second execution of the same day is a no-op; a database replay of the same bytes is ALREADY_PROCESSED too', async () => {
  const h = harness();
  assertEquals((await read(await handleDaily(invoke(), h.deps))).body.outcome, 'SUCCESS');
  const calls = h.calls.length;
  const again = await read(await handleDaily(invoke(), h.deps));
  assertEquals([again.body.outcome, h.calls.length, h.ingests.length], ['ALREADY_PROCESSED', calls, 1]);

  const replay = harness({ processedRun: null });                         // lookup misses, the ingestion replays
  await handleDaily(invoke(), replay.deps);
  const r = await read(await handleDaily(invoke(), replay.deps));
  assertEquals([r.body.outcome, replay.runs.size], ['ALREADY_PROCESSED', 1]);
});

Deno.test('duplicate concurrent execution: one effective run, the other ALREADY_PROCESSED', async () => {
  const h = harness();
  const [a, b] = await Promise.all([handleDaily(invoke(), h.deps), handleDaily(invoke(), h.deps)].map(async (p) => (await read(await p)).body.outcome));
  assertEquals([a, b].sort(), ['ALREADY_PROCESSED', 'SUCCESS']);
  assertEquals(h.runs.size, 1);
});

Deno.test('MP task timeout → FAILED with task id; the next execution resumes that task (no new request) and succeeds', async () => {
  const h = harness({ taskAnswers: ['pending'] });
  const r = await read(await handleDaily(invoke(), h.deps));
  assertEquals([r.status, r.body.outcome, r.body.error_code, r.body.task_id, r.body.run_id], [502, 'FAILED', 'MP_TASK_TIMEOUT', '777', null]);
  assertEquals([h.storage.size, h.ingests.length], [0, 0]);
  const posts = h.calls.filter((c) => c.startsWith('POST')).length;
  h.setAnswers(['processed']);
  const next = await read(await handleDaily(invoke(), h.deps));
  assertEquals([next.body.outcome, next.body.task_id], ['SUCCESS', '777']);
  assertEquals(h.calls.filter((c) => c.startsWith('POST')).length, posts);     // resumed, not re-requested
});

Deno.test('parser rejection → FAILED REPORT_REJECTED:<code> with the REJECTED run; no report content in the record', async () => {
  const h = harness({ file: csv([LINES[0], '', LINES[1]]) });
  const r = await read(await handleDaily(invoke(), h.deps));
  assertEquals([r.status, r.body.outcome, r.body.error_code], [502, 'FAILED', 'REPORT_REJECTED:EMPTY_LINE']);
  assert(typeof r.body.run_id === 'string' && h.runs.get(r.body.run_id)?.status === 'REJECTED');
  noLeak(h, [JSON.stringify(r.body)]);
});

Deno.test('incompatible configuration → FAILED CONFIG_INCOMPATIBLE before any report request', async () => {
  const h = harness({ config: { ...CONFIG, columns: CONFIG.columns.slice(1) } });
  const r = await read(await handleDaily(invoke(), h.deps));
  assertEquals([r.status, r.body.outcome, r.body.error_code], [502, 'FAILED', 'CONFIG_INCOMPATIBLE']);
  assertEquals(h.calls, ['GET /v1/account/release_report/config']);
});

Deno.test('the request body never chooses the day', async () => {
  const h = harness();
  const r = await read(await handleDaily(invoke(SECRET, JSON.stringify({ date: '2026-10-05', mode: 'VALIDATION' })), h.deps));
  assertEquals([r.body.target_date, h.ingests[0].p_coverage_from], [TARGET, TARGET]);
});

Deno.test('log write failure → 500 SCHEDULE_RECORD_FAILED; an unexpected error is recorded as FAILED INTERNAL', async () => {
  const h = harness({ recordFails: true });
  const r = await read(await handleDaily(invoke(), h.deps));
  assertEquals([r.status, r.body.error, r.body.outcome], [500, 'SCHEDULE_RECORD_FAILED', 'SUCCESS']);

  const x = harness();
  x.deps.loadMpAccount = () => Promise.reject(new Error('network: secret-ish detail'));
  const e = await read(await handleDaily(invoke(), x.deps));
  assertEquals([e.status, e.body.outcome, e.body.error_code], [502, 'FAILED', 'INTERNAL']);
  assert(!JSON.stringify(e.body).includes('secret-ish'));
});
