/**
 * mp-report-daily — catch-up of missed days (the 29/10/2026 incident). Deno, no network: an in-memory Mercado Pago with ONE task
 * per requested day, a report file per day and days that stay "preparing", the REAL parser, and a stand-in of the NORMAL
 * ingestion that behaves like the database (replay of the same bytes; ALREADY_PROCESSED for another run of a processed day).
 * Proves: the previous day first and as before; missing earlier days recovered oldest first, bounded per execution and
 * continued by the next one; a preparing day kept PENDING with its task and resumed (never a second task); an empty day is
 * complete only with its run; a failed day retried later; two concurrent executions → one run per day; nothing requested for
 * complete days or before the integration's first day; recovering 29/10 leaves the later days untouched.
 *
 *   deno test --node-modules-dir=none --allow-read scripts/adr018/mp-report-daily-backfill.test.ts
 */
// deno-lint-ignore no-import-prefix -- pinned test-only dependency (no deno.json in this repository)
import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { businessDayWindow } from '../../supabase/functions/_shared/mp-release-report.ts';
import { type CaptureParams, CaptureRpcError, type RunRow } from '../../supabase/functions/mp-report-ingest/handler.ts';
import {
  BACKFILL_LOOKBACK_DAYS, type DailyDeps, handleDaily, MAX_BACKFILL_PER_EXECUTION, missingDays, type ScheduleRecord, SECRET_HEADER, shiftDay,
} from '../../supabase/functions/mp-report-daily/handler.ts';

const SECRET = 'test-only-invoke-secret';
const MP_ACC = 'aaaaaaaa-0000-4000-8000-000000000099';
const NOW = Date.parse('2026-11-04T10:00:00Z');   // 07:00 Buenos Aires → previous day 2026-11-03
const enc = (s: string) => new TextEncoder().encode(s);
const HEADER = 'DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;TRANSACTION_APPROVAL_DATE;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID';
const CONFIG = { columns: HEADER.split(';').map((key) => ({ key })), separator: ';' };
/** A day's report: its opening, one yield and one payment (unique per day), its closing; or only the CONTROL rows. */
function report(date: string, empty = false, broken = false): Uint8Array {
  const n = date.replaceAll('-', '');
  const open = `${date}T00:00:00.000-03:00;;;1000.00;0.00;1000.00;0.00;0.00;;;;;1000.00;;`;
  const rows = empty ? [open, ';;;1000.00;0.00;1000.00;0.00;0.00;;;;;0.00;;'] : [
    open,
    `${date}T05:00:00.000-03:00;17${n};asset_management;400.00;0.00;400.00;0.00;0.00;;${date}T05:00:00.000-03:00;;;1400.00;;`,
    `${date}T21:00:00.000-03:00;18${n};payment;7455.00;0.00;7500.00;0.00;-45.00;cvu;${date}T21:00:00.000-03:00;;;8855.00;bank_transfer;`,
    ';;;8855.00;0.00;8900.00;0.00;-45.00;;;;;0.00;;',
  ];
  return enc((broken ? 'NOT;A;HEADER' : HEADER) + '\n' + rows.join('\n') + '\n');
}

interface World { runs: Map<string, RunRow>; records: ScheduleRecord[]; tasks: Map<string, string>; posts: string[]; ingests: CaptureParams[]; preparing: Set<string>; empty: Set<string>; broken: Set<string> }
function world(processed: string[]): World {
  const w: World = { runs: new Map(), records: [], tasks: new Map(), posts: [], ingests: [], preparing: new Set(), empty: new Set(), broken: new Set() };
  for (const d of processed) addRun(w, d, `seed-${d}`);
  return w;
}
function addRun(w: World, date: string, sha: string, status = 'PARSED') {
  const id = crypto.randomUUID();
  w.runs.set(id, { id, source_kind: 'MP_RELEASE_REPORT', mode: 'NORMAL', status, financial_account_id: MP_ACC, format_code: 'X', parser_version: 'X', file_sha256: sha,
    storage_path: `mp/${sha}`, coverage_from: date, coverage_to: date, rows_total: 0, rows_captured: 0, rows_invalid: 0, reject_reason: status === 'REJECTED' ? 'HEADER_MISMATCH: x' : null,
    previous_run_id: null, lines_new: 0, lines_known: 0, rows_ignored: 0, file_name: `${date}.csv`, byte_size: 1, source_meta: {} } as RunRow);
  return id;
}
const dateOfWindow = (begin: string) => {
  for (let d = '2026-09-01'; d < '2026-12-31'; d = shiftDay(d, 1)) if (businessDayWindow(d, NOW)?.begin_date === begin) return d;
  return '?';
};
const parsedFor = (w: World, d: string) => [...w.runs.values()].filter((r) => r.status === 'PARSED' && r.coverage_from === d);

function deps(w: World): DailyDeps {
  let nextTask = 900;
  const j = (status: number, v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status }));
  const base = '/v1/account/release_report';
  return {
    secretMatches: (g) => g === SECRET,
    loadMpAccount: () => Promise.resolve(MP_ACC),
    loadRun: (id) => Promise.resolve(w.runs.get(id) ?? null),
    mp: (method, path, body) => {
      if (method === 'GET' && path === `${base}/config`) return j(200, CONFIG);
      if (method === 'POST' && path === base) {
        const b = body as { begin_date: string; end_date: string };
        const id = String(nextTask++);
        const d = dateOfWindow(b.begin_date);
        w.tasks.set(id, d);
        w.posts.push(d);
        return j(202, { id: Number(id), status: 'pending', ...b });
      }
      const t = /\/task\/(\d+)$/.exec(path);
      if (method === 'GET' && t) {
        const d = w.tasks.get(t[1]) as string;
        const win = businessDayWindow(d, NOW) as { begin_date: string; end_date: string };
        const ready = !w.preparing.has(d);
        return j(200, { id: Number(t[1]), status: ready ? 'processed' : 'pending', ...win, ...(ready ? { file_name: `release-${d}.csv` } : {}) });
      }
      const f = /\/release-(\d{4}-\d{2}-\d{2})\.csv$/.exec(path);
      if (method === 'GET' && f) return Promise.resolve(new Response(report(f[1], w.empty.has(f[1]), w.broken.has(f[1])) as Uint8Array<ArrayBuffer>, { status: 200 }));
      return j(404, { message: 'unexpected endpoint' });
    },
    download: () => Promise.resolve(null),
    upload: () => Promise.resolve('created' as const),
    capture: () => Promise.reject(new Error('VALIDATION must never be used by the scheduler')),
    // the database's rule: the same bytes replay; another run of an already processed day is refused
    ingest: (p) => {
      w.ingests.push(p);
      const prior = [...w.runs.values()].find((r) => r.mode === 'NORMAL' && r.file_sha256 === p.p_file_sha256);
      if (prior) return Promise.resolve({ run_id: prior.id, status: prior.status, replayed: true });
      if (parsedFor(w, p.p_coverage_from).length > 0) return Promise.reject(new CaptureRpcError('ALREADY_PROCESSED: the day already has an effective run'));
      const id = addRun(w, p.p_coverage_from, p.p_file_sha256, p.p_reject_reason ? 'REJECTED' : 'PARSED');
      return Promise.resolve({ run_id: id, replayed: false, backfills_created: 1, backfills_existing: 0, yields_applied: 1, yields_not_applied: 0 });
    },
    recordDestinations: (p) => Promise.resolve(p.p_items.length),
    sha256: async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))).map((x) => x.toString(16).padStart(2, '0')).join(''),
    sleep: () => Promise.resolve(),
    log: () => {},
    now: () => NOW,
    findProcessedRun: (acc, d) => Promise.resolve(parsedFor(w, d).find((r) => r.financial_account_id === acc)?.id ?? null),
    lastTaskSchedule: (d) => {
      const r = w.records.filter((x) => x.p_target_date === d && x.p_task_id !== null).pop();
      return Promise.resolve(r ? { outcome: r.p_outcome, task_id: r.p_task_id, error_code: r.p_error_code } : null);
    },
    recordSchedule: (r) => { w.records.push(r); return Promise.resolve(w.records.length); },
    processedDays: (_acc, from, to) => Promise.resolve([...new Set([...w.runs.values()].filter((r) => r.status === 'PARSED' && r.coverage_from! >= from && r.coverage_from! <= to).map((r) => r.coverage_from!))]),
    firstProcessedDay: () => Promise.resolve([...w.runs.values()].filter((r) => r.status === 'PARSED').map((r) => r.coverage_from!).sort()[0] ?? null),
  };
}
const run = async (w: World) => {
  const res = await handleDaily(new Request('http://local/mp-report-daily', { method: 'POST', headers: { [SECRET_HEADER]: SECRET }, body: '{}' }), deps(w));
  return { status: res.status, body: await res.json() as { outcome: string; target_date: string; backfill: { target_date: string; outcome: string; task_id: string | null; error_code: string | null }[] } };
};
const range = (from: string, to: string) => { const o: string[] = []; for (let d = from; d <= to; d = shiftDay(d, 1)) o.push(d); return o; };
const history = (except: string[] = []) => range('2026-10-20', '2026-11-02').filter((d) => !except.includes(d));

Deno.test('missingDays: inside the window, never before the first processed day, oldest first; nothing without history', () => {
  const done = new Set(range('2026-10-20', '2026-11-02').filter((d) => d !== '2026-10-29'));
  assertEquals(missingDays('2026-11-03', '2026-10-20', done), ['2026-10-29']);
  assertEquals(missingDays('2026-11-03', '2026-10-30', new Set()), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);   // floor = first day
  assertEquals(missingDays('2026-11-03', '2026-01-01', new Set()).length, BACKFILL_LOOKBACK_DAYS);                               // bounded window
  assertEquals(missingDays('2026-11-03', '2026-01-01', new Set())[0], '2026-10-20');
  assertEquals(missingDays('2026-11-03', null, new Set()), []);
  assertEquals(shiftDay('2026-03-01', -1), '2026-02-28');
  assertEquals(shiftDay('2026-12-31', 1), '2027-01-01');
});

Deno.test('previous day available, history complete → only that day is requested; no catch-up', async () => {
  const w = world(history());
  const r = await run(w);
  assertEquals([r.status, r.body.target_date, r.body.outcome, r.body.backfill], [200, '2026-11-03', 'SUCCESS', []]);
  assertEquals(w.posts, ['2026-11-03']);
});

Deno.test('the 29/10 case: recovered after the previous day; the later days are not requested again nor touched', async () => {
  const w = world(history(['2026-10-29']));
  const before = [...w.runs.values()].filter((x) => x.coverage_from! > '2026-10-29').map((x) => x.id).sort();
  const r = await run(w);
  assertEquals(r.body.outcome, 'SUCCESS');
  assertEquals(r.body.backfill.map((b) => [b.target_date, b.outcome]), [['2026-10-29', 'SUCCESS']]);
  assertEquals(w.posts, ['2026-11-03', '2026-10-29']);
  assertEquals(parsedFor(w, '2026-10-29').length, 1);
  const later = [...w.runs.values()].filter((x) => x.coverage_from! > '2026-10-29' && x.coverage_from! < '2026-11-03').map((x) => x.id).sort();
  assertEquals(later, before.filter((id) => w.runs.get(id)!.coverage_from !== '2026-11-03'));   // 30/10–02/11: the same runs, no new one
  assertEquals(w.records.map((x) => [x.p_target_date, x.p_outcome]), [['2026-11-03', 'SUCCESS'], ['2026-10-29', 'SUCCESS']]);
  const again = await run(w);   // a later slot: everything complete, Mercado Pago is not called
  assertEquals([again.body.outcome, again.body.backfill.length, w.posts.length], ['ALREADY_PROCESSED', 0, 2]);
});

Deno.test('a missed day still preparing stays PENDING with its task; the next execution resumes THAT task (never a second one)', async () => {
  const w = world(history(['2026-10-29']));
  w.preparing.add('2026-10-29');
  const r1 = await run(w);
  assertEquals(r1.body.backfill.map((b) => [b.target_date, b.outcome, b.error_code]), [['2026-10-29', 'PENDING', 'MP_TASK_PREPARING']]);
  const task = r1.body.backfill[0].task_id;
  assert(task !== null);
  assertEquals(parsedFor(w, '2026-10-29').length, 0);
  const r2 = await run(w);   // still preparing on the next slot
  assertEquals([r2.body.backfill[0].outcome, r2.body.backfill[0].task_id], ['PENDING', task]);
  w.preparing.delete('2026-10-29');   // Mercado Pago finally delivers (days later)
  const r3 = await run(w);
  assertEquals([r3.body.backfill[0].outcome, r3.body.backfill[0].task_id], ['SUCCESS', task]);
  assertEquals(w.posts.filter((d) => d === '2026-10-29').length, 1);   // one task for the day in total
  assertEquals(parsedFor(w, '2026-10-29').length, 1);
});

Deno.test('several missing days: oldest first, at most MAX_BACKFILL_PER_EXECUTION per execution, the next executions continue', async () => {
  const missing = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'];
  const w = world(history(missing));
  const r1 = await run(w);
  assertEquals(r1.body.backfill.map((b) => b.target_date), missing.slice(0, MAX_BACKFILL_PER_EXECUTION));
  const r2 = await run(w);
  assertEquals(r2.body.backfill.map((b) => b.target_date), missing.slice(MAX_BACKFILL_PER_EXECUTION, 2 * MAX_BACKFILL_PER_EXECUTION));
  const r3 = await run(w);
  assertEquals(r3.body.backfill, []);
  for (const d of missing) assertEquals(parsedFor(w, d).length, 1, d);
  assertEquals(w.posts.filter((d) => missing.includes(d)).length, missing.length);   // one request per missing day
});

Deno.test('a legitimately empty day: SUCCESS_EMPTY with its run, then complete (never requested again)', async () => {
  const w = world(history(['2026-11-01']));
  w.empty.add('2026-11-01');
  const r1 = await run(w);
  assertEquals(r1.body.backfill.map((b) => [b.target_date, b.outcome]), [['2026-11-01', 'SUCCESS_EMPTY']]);
  const r2 = await run(w);
  assertEquals(r2.body.backfill, []);
  assertEquals(w.posts.filter((d) => d === '2026-11-01').length, 1);
});

Deno.test('a failed day (rejected file) stops the catch-up of that execution; a later execution retries it and completes it', async () => {
  const w = world(history(['2026-10-27', '2026-10-28']));
  w.broken.add('2026-10-27');
  const r1 = await run(w);
  assertEquals(r1.body.backfill.map((b) => [b.target_date, b.outcome]), [['2026-10-27', 'FAILED']]);   // 28/10 waits
  assert(r1.body.backfill[0].error_code?.startsWith('REPORT_REJECTED:'));
  assertEquals(parsedFor(w, '2026-10-27').length, 0);
  w.broken.delete('2026-10-27');   // the next report of that day is valid
  const r2 = await run(w);
  assertEquals(r2.body.backfill.map((b) => [b.target_date, b.outcome]), [['2026-10-27', 'SUCCESS'], ['2026-10-28', 'SUCCESS']]);
});

Deno.test('the previous day FAILED → no catch-up in that execution (a systemic failure is not multiplied)', async () => {
  const w = world(history(['2026-10-29']));
  w.broken.add('2026-11-03');
  const r = await run(w);
  assertEquals([r.status, r.body.outcome, r.body.backfill], [502, 'FAILED', []]);
  assertEquals(w.posts, ['2026-11-03']);
});

Deno.test('two concurrent executions: one effective run per day; the other is ALREADY_PROCESSED; nothing twice', async () => {
  const w = world(history(['2026-10-29']));
  const [a, b] = await Promise.all([run(w), run(w)]);
  for (const d of ['2026-11-03', '2026-10-29']) assertEquals(parsedFor(w, d).length, 1, d);
  const outcomes = [a.body.outcome, b.body.outcome].sort();
  assertEquals(outcomes, ['ALREADY_PROCESSED', 'SUCCESS']);
  const back = [...a.body.backfill, ...b.body.backfill].map((x) => x.outcome).sort();
  assert(back.filter((o) => o === 'SUCCESS').length === 1, JSON.stringify(back));
});

Deno.test('already imported: every day complete → no Mercado Pago call at all, no ingestion', async () => {
  const w = world([...history(), '2026-11-03']);
  const r = await run(w);
  assertEquals([r.body.outcome, r.body.backfill, w.posts, w.ingests.length], ['ALREADY_PROCESSED', [], [], 0]);
});

Deno.test('no history yet (integration never processed a day): only the previous day, nothing older is requested', async () => {
  const w = world([]);
  const r = await run(w);
  assertEquals([r.body.outcome, r.body.backfill, w.posts], ['SUCCESS', [], ['2026-11-03']]);
});
