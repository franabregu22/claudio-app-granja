#!/usr/bin/env node
/**
 * ADR-018 — CUT vs ACTIVE MATCH GUARD TEST SUITE (migration 0077). LOCAL TEST DATABASE ONLY.
 *
 * Invariant (ADR-018 §6.6, §16 #24): every active fin_statement_match refers to a line that is POST_CUTOVER under the
 * account's active cut; fin_resolve_statement_cutover refuses (CUTOVER_ACTIVE_MATCH_CONFLICT) any first or superseding
 * cut under which an actively matched line would not be POST_CUTOVER, atomically and without reversing anything.
 *
 * Part 1 (always): everything inside ONE transaction that is rolled back (synthetic data, tag ADR018-0077).
 * Part 2 (only with FIN_E2E_PROJECT=<disposable project id>): real concurrency with two psql sessions. It commits
 *   synthetic evidence (immutable rows), so it refuses to run on any other project.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_statement_cutover_guard.test.mjs
 *   FIN_E2E_PROJECT=granja_fresh_0073 TEST_DATABASE_URL=... node scripts/target-db/fin_statement_cutover_guard.test.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  return existsSync(c) ? c : 'docker';
}
const DOCKER = resolveDockerBin();
const dockerRun = (args, input) => {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
};

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0077-0000-0000-00000000000a';
const ACC = (name) => `(SELECT id FROM financial_account WHERE nombre = '${name}')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0077-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;

// ── fixtures (row contract of fin_import_bank_statement, 0075) ───────────────
const ctl = (n, type, balance) => ({ row_number: n, kind: 'CONTROL', control_type: type, balance, raw_row: { text: type } });
const eco = (n, pos, date, desc, ref, amt, bal) => ({
  row_number: n, kind: 'ECONOMIC', statement_position: pos, value_date: date, description_raw: desc, bank_reference: ref,
  signed_amount: amt, running_balance: bal, raw_row: { text: `${date} ${desc} ${ref} ${amt} ${bal}` }, appearance_meta: { page: 1, physical_row: n } });
const bnaMeta = (o, c) => ({ opening_balance: o, closing_balance: c, period: 'SYNTHETIC' });
const patMeta = (o, c) => ({ opening_balance: o, closing_balance: c, statement_id: 'SYNTHETIC' });
// BNA statement A (August): A1..A4; statement B (September): B1 — ordering is (coverage_to, statement_position)
const BNA_A = [ctl(1, 'SALDO_ANTERIOR', '1000.00'), eco(2, 1, '2026-08-04', 'GRAVAMEN A1', '1', '-100.00', '900.00'),
  eco(3, 2, '2026-08-05', 'DEBIN A2', '2', '50.00', '950.00'), eco(4, 3, '2026-08-06', 'DEBIN A3', '3', '30.00', '980.00'),
  eco(5, 4, '2026-08-07', 'PAGO A4', '4', '-20.00', '960.00'), ctl(6, 'SALDO_FINAL', '960.00')];
const BNA_B = [ctl(1, 'SALDO_ANTERIOR', '960.00'), eco(2, 1, '2026-09-02', 'DEBIN B1', '5', '10.00', '970.00'), ctl(3, 'SALDO_FINAL', '970.00')];
// Patagonia: ordering is value_date; 09-10 carries two lines (same-day)
const PAT_1 = [ctl(1, 'SALDO_ANTERIOR', '0.00'), eco(2, 1, '2026-09-01', 'TRANSFERENCIA Q1', '', '500.00', '500.00'),
  eco(3, 2, '2026-09-05', 'TRANSFERENCIA Q2', '', '100.00', '600.00'), eco(4, 3, '2026-09-08', 'TRANSFERENCIA Q3', '', '7.00', '607.00'),
  eco(5, 4, '2026-09-10', 'TRANSFERENCIA Q4', '', '3.00', '610.00'), eco(6, 5, '2026-09-10', 'IMP Q5', '', '-2.00', '608.00'),
  ctl(7, 'SALDO_ACTUAL', '608.00')];

function importCall(o) {
  return `SELECT fin_import_bank_statement(${lit(ADMIN)}::uuid, ${P(ACC(o.account))}::uuid, ${lit(o.parser)}, ${lit(o.format)}, ${lit(o.sha)},
    ${lit(`bank/acc/${o.sha}.pdf`)}, 'statement.pdf', 1024, ${lit(o.from)}::date, ${lit(o.to)}::date, ${lit(JSON.stringify(o.meta))}::jsonb,
    NULL::uuid, NULL, ${lit(JSON.stringify(o.rows))}::jsonb)::text`;
}

function prelude(sql) {
  sql.push(`\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false; e TEXT; val TEXT;
BEGIN
  LOOP
    e := substring(p_sql FROM '\\{\\{(.+?)\\}\\}');
    EXIT WHEN e IS NULL;
    EXECUTE 'SELECT (' || e || ')::text' INTO val;
    p_sql := replace(p_sql, '{{' || e || '}}', quote_nullable(val));
  END LOOP;
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    RESET ROLE;
  END;
  IF ok AND p_key IS NOT NULL THEN
    INSERT INTO res VALUES (p_key, v::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  END IF;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE RAISE NOTICE 'PASS %', p_name; END IF;
END $f$;`);
}

// ── Part 1: functional (rolled back) ─────────────────────────────────────────
const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const admin = (call, key = null) => as('authenticated', ADMIN, `SELECT ${call}::text`, key);
const service = (o, key) => as('service_role', null, importCall(o), key);
const line = (run, pos) => `(SELECT a.statement_line_id FROM fin_import_run_line a WHERE a.run_id = ${RES(run)}::uuid AND a.statement_position = ${pos})`;
const post = (acc, amt) => `(SELECT p.id FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = 'ADR018-0077-OP' AND p.financial_account_id = ${ACC(acc)} AND p.signed_amount = ${amt})`;
const match = (l, p) => `fin_match_statement_line(${P(l)}::bigint, ${P(p)}::bigint, 'test')`;
const cut = (acc, l, open, reason = null) => `fin_resolve_statement_cutover(${P(ACC(acc))}::uuid, ${P(l)}::bigint, ${open}, 'evidence', ${lit(reason)})`;
const activeCut = (acc) => `(SELECT format('%s|%s|%s', id, cutoff_statement_line_id, opening_balance) FROM fin_statement_cutover WHERE financial_account_id = ${ACC(acc)} AND superseded_at IS NULL)`;
const cutRows = (acc) => `(SELECT format('%s/%s', count(*), count(*) FILTER (WHERE superseded_at IS NULL)) FROM fin_statement_cutover WHERE financial_account_id = ${ACC(acc)})`;
const auditCuts = `(SELECT count(*)::text FROM audit_events WHERE entity_type = 'fin_statement_cutover' AND performed_by = '${ADMIN}')`;
// read model parity (0076 view, as ADMIN): no actively matched line is anything but POST_CUTOVER
const viewInvariant = `pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT count(*)::text FROM fin_statement_line_status WHERE reconciliation_status = ''MATCHED'' AND cutover_classification IS DISTINCT FROM ''POST_CUTOVER''', NULL)`;
const viewClass = (l) => `pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT cutover_classification || ''|'' || reconciliation_status FROM fin_statement_line_status WHERE statement_line_id = ' || ${l}, NULL)`;

prelude(sql);
add(`INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'adr018-0077-admin@test.local', 'ADMIN');
-- a third bank account with a synthetic BNA configuration (first-cut case with a pre-existing match)
INSERT INTO financial_account (nombre, account_type) VALUES ('ADR018-0077 BNA2', 'BANK_ACCOUNT');
INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu)
SELECT id, 'BNA_MONTHLY_PDF_V1', '0000000077', '0000000000000000000077' FROM financial_account WHERE nombre = 'ADR018-0077 BNA2';`);
const BNA = { account: 'BNA', format: 'BNA_MONTHLY_PDF_V1', parser: 'bna-0077' };
const PAT = { account: 'Patagonia', format: 'PATAGONIA_STATEMENT_PDF_V1', parser: 'pat-0077' };
expect('fixture A imported', service({ ...BNA, sha: sha('A'), from: '2026-07-31', to: '2026-08-31', meta: bnaMeta('1000.00', '960.00'), rows: BNA_A }, 'A'), 'OK:%"status": "PARSED"%');
expect('fixture B imported', service({ ...BNA, sha: sha('B'), from: '2026-08-31', to: '2026-09-30', meta: bnaMeta('960.00', '970.00'), rows: BNA_B }, 'B'), 'OK:%"status": "PARSED"%');
expect('fixture Patagonia imported', service({ ...PAT, sha: sha('Q'), from: '2026-08-31', to: '2026-09-30', meta: patMeta('0.00', '608.00'), rows: PAT_1 }, 'Q'), 'OK:%"status": "PARSED"%');
expect('fixture X (BNA2) imported', service({ ...BNA, account: 'ADR018-0077 BNA2', sha: sha('X'), from: '2026-07-31', to: '2026-08-31', meta: bnaMeta('1000.00', '960.00'), rows: BNA_A }, 'X'), 'OK:%"status": "PARSED"%');
add(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('ADJUSTMENT', '2026-09-30', 'ADR018-0077-OP', 'test');
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT o.id, a.id, x.amt, '2026-09-30' FROM (VALUES ('BNA', 30.00), ('BNA', -20.00), ('BNA', 10.00), ('BNA', 50.00),
  ('Patagonia', 100.00), ('Patagonia', 7.00), ('ADR018-0077 BNA2', 30.00)) x(acc, amt)
  JOIN financial_operation o ON o.external_ref = 'ADR018-0077-OP' JOIN financial_account a ON a.nombre = x.acc;`);
const A1 = line('A', 1), A2 = line('A', 2), A3 = line('A', 3), A4 = line('A', 4), B1 = line('B', 1);
const Q1 = line('Q', 1), Q2 = line('Q', 2), Q3 = line('Q', 3), Q5 = line('Q', 5);

// BNA: first cut at A1, matches on A3 and B1 (both POST)
expect('BNA first cut at A1', admin(cut('BNA', A1, 900.00), 'CUT1'), 'OK:%"superseded_id": null%');
expect('match A3 (POST)', admin(match(A3, post('BNA', 30.00)), 'MA3'), 'OK:%"replayed": false%');
expect('match B1 (POST)', admin(match(B1, post('BNA', 10.00)), 'MB1'), 'OK:%"replayed": false%');

// 1. matches stay POST under the new anchor → success
expect('1 supersede A1→A2: matched A3 and B1 stay POST → success', admin(cut('BNA', A2, 950.00, 'later evidence'), 'CUT2'), 'OK:%"superseded_id": %');
expect('1 view: A3 POST|MATCHED', viewClass(A3), 'OK:POST_CUTOVER|MATCHED');
const CUT2 = `(${RES('CUT2', 'cutover_id')})`;

// 2 + 4. one active match would become PRE (the other stays POST) → the whole call is refused
expect('2/4 supersede A2→A4: A3 would be PRE (B1 would stay POST) → refused', admin(cut('BNA', A4, 960.00, 'move forward')), 'ERR:CUTOVER_ACTIVE_MATCH_CONFLICT: 1 active match(es)%');
expect('2 supersede onto the matched line itself (A3 = anchor) → refused', admin(cut('BNA', A3, 980.00, 'anchor on matched line')), 'ERR:CUTOVER_ACTIVE_MATCH_CONFLICT: 1 active match(es)%');
expect('4 supersede A2→B1: both A3 and B1 conflict → refused', admin(cut('BNA', B1, 970.00, 'far forward')), 'ERR:CUTOVER_ACTIVE_MATCH_CONFLICT: 2 active match(es)%');
// 6 + 7. nothing written by the refused calls
expect('6 active cut unchanged (still CUT2, anchor A2, 950)', activeCut('BNA'), `%|%|950.00`);
expect('6 active cut id is CUT2', `((SELECT id FROM fin_statement_cutover WHERE financial_account_id = ${ACC('BNA')} AND superseded_at IS NULL) = ${CUT2}::bigint)::text`, 'true');
expect('7 no partial supersession: 2 rows, 1 active', cutRows('BNA'), '2/1');
expect('7 superseded history intact (CUT1 superseded by CUT2 only)', `(SELECT format('%s|%s', superseded_by = ${CUT2}::bigint, supersede_reason) FROM fin_statement_cutover WHERE id = (${RES('CUT1', 'cutover_id')})::bigint)`, 't|later evidence');
expect('7 only the two successful cuts audited', auditCuts, '2');
expect('6 matches untouched by the refusals', `(SELECT count(*)::text FROM fin_statement_match WHERE reversed_at IS NULL AND statement_line_id IN (${A3}, ${B1}))`, '2');

// 5. reverse the conflicting match first → the same change succeeds
expect('5 reverse the A3 match', admin(`fin_reverse_statement_match(${P(RES('MA3', 'match_id'))}::bigint, 'line moves into the opening balance')`), 'OK:%"reversed": true%');
expect('5 supersede A2→A4 after the reversal → success', admin(cut('BNA', A4, 960.00, 'move forward'), 'CUT3'), 'OK:%"superseded_id": %');
expect('5 view: A3 now PRE|UNMATCHED', viewClass(A3), 'OK:PRE_CUTOVER|UNMATCHED');
expect('5 view: B1 still POST|MATCHED', viewClass(B1), 'OK:POST_CUTOVER|MATCHED');
expect('5 history: 3 rows, 1 active', cutRows('BNA'), '3/1');
expect('9 view parity: no actively matched line outside POST_CUTOVER', viewInvariant, 'OK:0');

// 3. Patagonia
expect('PAT first cut at Q1', admin(cut('Patagonia', Q1, 500.00)), 'OK:%"superseded_id": null%');
expect('PAT match Q2 (POST)', admin(match(Q2, post('Patagonia', 100.00))), 'OK:%"replayed": false%');
expect('PAT match Q3 (POST)', admin(match(Q3, post('Patagonia', 7.00))), 'OK:%"replayed": false%');
expect('3 PAT supersede Q1→Q3: Q2 would be PRE and Q3 the anchor → refused', admin(cut('Patagonia', Q3, 607.00, 'later')), 'ERR:CUTOVER_ACTIVE_MATCH_CONFLICT: 2 active match(es)%');
// a same-day anchor is already refused before the match guard (ANCHOR_AMBIGUOUS_DAY, 0075 rule kept): no matched
// line can end up CUTOVER_AMBIGUOUS_DAY through a cut change; the guard's same-day clause is defence in depth
expect('3 PAT supersede onto a shared 09-10 date → refused (ANCHOR_AMBIGUOUS_DAY)', admin(cut('Patagonia', Q5, 608.00, 'same day')), 'ERR:ANCHOR_AMBIGUOUS_DAY%');
expect('3 PAT active cut unchanged (Q1, 500)', activeCut('Patagonia'), '%|%|500.00');
expect('3 PAT matches still active', `(SELECT count(*)::text FROM fin_statement_match WHERE reversed_at IS NULL AND statement_line_id IN (${Q2}, ${Q3}))`, '2');
expect('9 view parity after Patagonia refusals', viewInvariant, 'OK:0');

// E. first cut with a pre-existing active match (historical / manual data): the same check applies
add(`INSERT INTO fin_statement_match (statement_line_id, financial_operation_id, financial_posting_id, matched_by, reason)
SELECT a.statement_line_id, p.financial_operation_id, p.id, '${ADMIN}', 'pre-existing (manual data)'
  FROM fin_import_run_line a, financial_posting p
 WHERE a.run_id = ${RES('X')}::uuid AND a.statement_position = 3
   AND p.id = ${post('ADR018-0077 BNA2', 30.00)};`);
const X2 = line('X', 2), X3 = line('X', 3);
expect('E first cut that would make the matched X3 PRE → refused', admin(cut('ADR018-0077 BNA2', line('X', 4), 960.00)), 'ERR:CUTOVER_ACTIVE_MATCH_CONFLICT: 1 active match(es)%');
expect('E first cut on the matched line itself → refused', admin(cut('ADR018-0077 BNA2', X3, 980.00)), 'ERR:CUTOVER_ACTIVE_MATCH_CONFLICT%');
expect('E nothing written: no cut for BNA2', cutRows('ADR018-0077 BNA2'), '0/0');
expect('E first cut before the matched line → success', admin(cut('ADR018-0077 BNA2', X2, 950.00)), 'OK:%"superseded_id": null%');
expect('9 final view parity', viewInvariant, 'OK:0');

// perimeter: same signatures, still definer, owner postgres; the definer set stays 73
expect('functions still SECURITY DEFINER owned by postgres',
  `(SELECT string_agg(proname || ':' || prosecdef || ':' || pg_get_userbyid(proowner), ',' ORDER BY proname) FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_match_statement_line','fin_resolve_statement_cutover'))`,
  'fin_match_statement_line:true:postgres,fin_resolve_statement_cutover:true:postgres');
expect('one overload each', `(SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_match_statement_line','fin_resolve_statement_cutover'))`, '2');
expect('SECURITY DEFINER set = 77 (0078 capture + 0079 NORMAL ingest and report back-fill + 0081 scheduler log)', `(SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef)`, '77');
expect('EXECUTE: authenticated only',
  `(SELECT string_agg(proname || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_match_statement_line','fin_resolve_statement_cutover'))`,
  'fin_match_statement_line:false:true:false,fin_resolve_statement_cutover:false:true:false');
add('ROLLBACK;');

// ── run helpers ──────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label} :: ${detail}`); } };
const psqlArgs = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A'];

const r = dockerRun([...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const out = `${r.stdout}\n${r.stderr}`.split('\n');
for (const l of out) {
  const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
  if (m) ok(m[2].replace(/ :: .*$/, ''), m[1] === 'PASS', m[2].includes(' :: ') ? m[2].slice(m[2].indexOf(' :: ') + 4) : '');
}
if (r.status !== 0) ok('psql part 1', false, (out.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300));

// ── Part 2: concurrency (disposable project only; commits synthetic evidence) ─
const PROJECT = process.env.FIN_E2E_PROJECT ?? '';
if (!PROJECT || PROJECT === 'Claudio_app_Granja' || container !== `supabase_db_${PROJECT}`) {
  console.log(`    --   concurrency part skipped (set FIN_E2E_PROJECT to the disposable project id; container ${container})`);
} else {
  const tag = randomUUID().slice(0, 8);
  const accName = `ADR018-0077 CONC ${tag}`;
  const one = (q) => {
    const x = dockerRun([...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-c', q]);
    if (x.status !== 0) throw new Error(x.stderr);
    return x.stdout.trim();
  };
  // committed fixture: account + config + statement + postings + an ADMIN profile
  const uid = randomUUID();
  one(`INSERT INTO perfiles (id, email, rol_type) VALUES ('${uid}', 'adr018-0077-conc-${tag}@test.local', 'ADMIN')`);
  const acc = one(`WITH a AS (INSERT INTO financial_account (nombre, account_type) VALUES ('${accName}', 'BANK_ACCOUNT') RETURNING id)
    INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu)
    SELECT id, 'BNA_MONTHLY_PDF_V1', '0000000078', '0000000000000000000078' FROM a RETURNING financial_account_id`);
  const imp = `BEGIN; SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SELECT fin_import_bank_statement('${uid}'::uuid, '${acc}'::uuid, 'bna-0077', 'BNA_MONTHLY_PDF_V1', '${sha(`CONC-${tag}`)}', 'bank/x.pdf', 's.pdf', 1024,
      '2026-07-31', '2026-08-31', ${lit(JSON.stringify(bnaMeta('1000.00', '960.00')))}::jsonb, NULL, NULL, ${lit(JSON.stringify(BNA_A))}::jsonb)->>'run_id'; COMMIT;`;
  const run = dockerRun([...psqlArgs, '-v', 'ON_ERROR_STOP=1'], imp).stdout.split('\n').map((s) => s.trim()).find((s) => /^[0-9a-f-]{36}$/.test(s));
  const L = Object.fromEntries(one(`SELECT string_agg(statement_position || '=' || statement_line_id, ',') FROM fin_import_run_line WHERE run_id = '${run}' AND statement_position IS NOT NULL`)
    .split(',').map((kv) => kv.split('=')).map(([k, v]) => [`X${k}`, v]));
  one(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('ADJUSTMENT', '2026-09-30', 'ADR018-0077-CONC-${tag}', 'test')`);
  const posting = (amt) => one(`INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
    SELECT id, '${acc}', ${amt}, '2026-09-30' FROM financial_operation WHERE external_ref = 'ADR018-0077-CONC-${tag}' RETURNING id`);
  const P2 = posting('50.00'), P3 = posting('30.00'), P4 = posting('-20.00');
  const asAdmin = (call) => `SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); SELECT ${call}::text;`;
  const resolveSql = (anchor, open, reason) => `fin_resolve_statement_cutover('${acc}'::uuid, ${anchor}, ${open}, 'ev', ${lit(reason)})`;
  const matchSql = (l, p) => `fin_match_statement_line(${l}, ${p}, 'conc')`;
  one(`BEGIN; ${asAdmin(resolveSql(L.X1, 900.00, null))} COMMIT;`);

  /** Session A holds its transaction for `holdMs` after its call; session B starts `delayMs` later. */
  const session = (body) => new Promise((done) => {
    const p = spawn(DOCKER, [...psqlArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { o += d; });
    p.on('close', () => done(o));
    p.stdin.end(body);
  });
  const race = async (a, b, holdMs = 2500, delayMs = 600) => {
    const t0 = Date.now();
    const pa = session(`BEGIN; ${asAdmin(a)} SELECT pg_sleep(${holdMs / 1000}); COMMIT;`);
    await new Promise((x) => setTimeout(x, delayMs));
    const tb = Date.now();
    const ob = await session(`BEGIN; ${asAdmin(b)} COMMIT;`);
    const waited = Date.now() - tb;
    const oa = await pa;
    return { a: oa, b: ob, waited, total: Date.now() - t0 };
  };

  // R1: a cut change commits first; a concurrent match on a line it turns PRE waits, then sees the new cut and fails
  const r1 = await race(resolveSql(L.X3, 980.00, 'move to X3'), matchSql(L.X2, P2));
  ok('R1 cut change committed', /"superseded_id"/.test(r1.a), r1.a.slice(0, 200));
  ok('R1 concurrent match waited for the cut change (serialised)', r1.waited >= 1200, `waited ${r1.waited} ms`);
  ok('R1 the waiting match sees the new cut → PRE_CUTOVER_LINE (no match on a PRE line)', /PRE_CUTOVER_LINE/.test(r1.b), r1.b.slice(0, 200));

  // R2: a match commits first; a concurrent cut change that would make it PRE waits, then sees it and is refused
  const r2 = await race(matchSql(L.X4, P4), resolveSql(L.X4, 960.00, 'onto the matched line'));
  ok('R2 match committed', /"replayed": false/.test(r2.a), r2.a.slice(0, 200));
  ok('R2 concurrent cut change waited for the match (serialised)', r2.waited >= 1200, `waited ${r2.waited} ms`);
  ok('R2 the waiting cut change sees the match → CUTOVER_ACTIVE_MATCH_CONFLICT', /CUTOVER_ACTIVE_MATCH_CONFLICT/.test(r2.b), r2.b.slice(0, 200));

  // R3: two cut changes: the second waits and then supersedes the first one's result (never two active cuts)
  const r3 = await race(resolveSql(L.X2, 950.00, 'back to X2'), resolveSql(L.X1, 900.00, 'back to X1'));
  ok('R3 first cut change committed', /"superseded_id"/.test(r3.a), r3.a.slice(0, 200));
  ok('R3 second cut change waited', r3.waited >= 1200, `waited ${r3.waited} ms`);
  ok('R3 second cut change superseded the first one', /"superseded_id"/.test(r3.b), r3.b.slice(0, 200));
  ok('R3 exactly one active cut, chain consistent',
    one(`SELECT format('%s/%s/%s', count(*), count(*) FILTER (WHERE superseded_at IS NULL), count(*) FILTER (WHERE superseded_at IS NOT NULL AND superseded_by IS NULL)) FROM fin_statement_cutover WHERE financial_account_id = '${acc}'`) === '4/1/0');
  ok('R* invariant: no active match on a non-POST line of the account',
    one(`BEGIN; ${asAdmin(`(SELECT count(*) FROM fin_statement_line_status WHERE financial_account_id = '${acc}' AND reconciliation_status = 'MATCHED' AND cutover_classification IS DISTINCT FROM 'POST_CUTOVER')`)} COMMIT;`).split('\n').filter(Boolean).pop() === '0');
  void P3;
}

console.log(`\n  ══ ADR-018 0077 RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
