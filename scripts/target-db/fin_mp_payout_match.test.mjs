#!/usr/bin/env node
/**
 * ADR-018 §9.3 — MP PAYOUT OWN-ACCOUNT MATCH, READ-ONLY PROPOSAL (migration 0084). LOCAL TEST DATABASE ONLY.
 *
 * Covers financial_account_identifier (seeded from the approved bank configuration, private) and fin_mp_payout_matches:
 * exact CBU match → OWN_ACCOUNT_EXACT (BNA / Patagonia), other destination → NO_OWN_ACCOUNT_MATCH, two different
 * destinations for one payout → DESTINATION_CONFLICT, no destination → no row, an identifier out of validity → no
 * match; ADMIN only (OPERATOR / anon / service_role refused); no identifier or destination value in the output; zero
 * financial effect; SECURITY DEFINER 79.
 *
 * Everything runs inside ONE transaction that is rolled back. Synthetic payouts; the own CBUs are read from the database.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_payout_match.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

// ── SQL helpers ──────────────────────────────────────────────────────────────
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0084-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0084-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0084-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.1.0';
const DAY = '2026-10-13';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

// ── synthetic Liberaciones rows (ADR-003 D1: 15 keys, every value the exported string) ─────────────────────────
const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '',
  NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '',
  SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (t, sid, desc, credit, debit, gross, tax, bal, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: `2026-10-13T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit,
  GROSS_AMOUNT: gross, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `2026-10-13T${t}.000-03:00`,
  BALANCE_AMOUNT: bal, PAYMENT_METHOD_TYPE: type });
const OPENING = { ...EMPTY, DATE: '2026-10-13T00:00:00.000-03:00', NET_CREDIT_AMOUNT: '1000.00', NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: '1000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '1000.00' };
const TOTALS = { ...EMPTY, NET_CREDIT_AMOUNT: '9941.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00',
  TAXES_AMOUNT: '-59.00', BALANCE_AMOUNT: '0.00' };
const GOOD = [
  OPENING,
  mv('08:00:00', '840000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '840000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('10:00:00', '840000000003', 'asset_management', '12.34', '0.00', '12.34', '0.00', '9458.34', '', ''),
  mv('11:00:00', '840000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('11:00:01', '840000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9458.34', 'available_money', ''),
  mv('11:00:01', '840000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('12:00:00', '840000000005', 'reserve_for_payment', '0.00', '10.00', '-10.00', '0.00', '9248.34'),
  TOTALS,
];
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));
const swap = (i, over) => GOOD.map((r, j) => (j === i ? { ...r, ...over } : r));

function captureCall(o) {
  const s = o.sha;
  return `SELECT ${o.fn ?? 'fin_capture_mp_release_report'}(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(o.parser ?? PARSER)},
    ${lit(o.format === undefined ? FORMAT : o.format)}, ${lit(s)},
    ${o.path === undefined ? P(`'mp/' || ${MPACC} || '/${s}.csv'`) : lit(o.path)}, ${lit(o.file ?? 'release-report.csv')}, 2048,
    ${lit(o.day ?? DAY)}::date, ${lit(o.day ?? DAY)}::date, ${lit(JSON.stringify(o.meta ?? { report_type: 'release_report', task_id: '1' }))}::jsonb,
    ${lit(o.reject ?? null)}, ${o.rows === null ? 'NULL' : `${lit(JSON.stringify(o.rows ?? rowsOf(GOOD)))}::jsonb`})::text`;
}
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const service = (o, key = null) => as('service_role', null, captureCall(o), key);
const RUN = (key) => `(SELECT r FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`;
const outcomes = (key) => `(SELECT string_agg(row_number || ':' || outcome || ':' || coalesce(appearance_meta ->> 'row_class', '?') || ':' || coalesce(split_part(note, ':', 1), '-'), ',' ORDER BY row_number)
  FROM fin_import_run_line WHERE run_id = ${RES(key)}::uuid)`;

const FIN_TABLES = ['financial_operation', 'financial_posting', 'mp_source_record', 'mp_transition_identity', 'mp_webhook_delivery',
  'mp_reconciliation', 'mp_financial_movement', 'mp_report_match', 'fin_statement_line'];
const counts = () => FIN_TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');

// ── prelude ──────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
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
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'adr018-0084-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0084-oper@test.local',  'OPERATOR');
CREATE TEMP TABLE before_counts AS ${counts()};
CREATE TEMP TABLE before_jobs AS SELECT jobid, jobname, schedule, command, active FROM cron.job;`);

const NORMAL = (o, key = null) => as('service_role', null, captureCall({ ...o, fn: 'fin_ingest_mp_release_report' }), key);
const runOf = (key, cols) => `(SELECT ${cols} FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`;
const backfills = (pid) => `(SELECT count(*)::text FROM mp_webhook_delivery WHERE origin = 'report_backfill' AND resource_id = '${pid}')`;
const deliveries = (pid) => `(SELECT count(*)::text FROM mp_webhook_delivery WHERE resource_id = '${pid}')`;
const CTL = (day) => ({ ...GOOD[0], DATE: `${day}T00:00:00.000-03:00` });
const TOT = (credit, gross, tax) => ({ ...GOOD[GOOD.length - 1], NET_CREDIT_AMOUNT: credit, GROSS_AMOUNT: gross, TAXES_AMOUNT: tax });
// a payments day without yields: inbound payment, outbound payment, payout with its reserve pair, control rows
const DAILY = [
  CTL(DAY),
  mv('08:00:00', '840000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '840000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('11:00:00', '840000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  mv('11:00:01', '840000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9446.00', 'available_money', ''),
  mv('11:00:01', '840000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  TOT('8246.00', '8300.00', '-54.00'),
];
const D14 = '2026-10-14';
const WEBHOOK_FIRST = [
  CTL(D14),
  { ...mv('08:00:00', '840000000021', 'payment', '79.52', '0.00', '80.00', '-0.48', '1079.52', 'cvu', 'bank_transfer'),
    DATE: `${D14}T08:00:00.000-03:00`, TRANSACTION_APPROVAL_DATE: `${D14}T08:00:00.000-03:00` },
  TOT('79.52', '80.00', '-0.48'),
];

const CBU = (bank) => `(SELECT c.expected_cbu::text FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id WHERE a.nombre = '${bank}' AND c.activo)`;
const EXTERNAL = `'2850590940090418135201'`;   // synthetic third-party CBU
const OTHER = `'2850590940090418135299'`;
// one payout day: P1 → BNA, P2 → Patagonia, P3 → third party, P4 → conflicting destinations, P5 → no destination
const PAYOUTS = ['840000000001', '840000000002', '840000000003', '840000000004', '840000000005'];
const PDAY = [
  CTL(DAY),
  ...PAYOUTS.map((sid, i) => mv(`1${i}:00:00`, sid, 'payout', '0.00', '100.00', '-100.00', '0.00', String(10000 - 100 * (i + 1)) + '.00', 'available_money', '')),
  TOT('0.00', '-500.00', '0.00'),
];
const rowOf = (sid) => PDAY.findIndex((r) => r.SOURCE_ID === sid) + 1;
const record = (key, items) => as('service_role', null,
  `SELECT fin_record_mp_payout_destinations(${P(RES(key))}::uuid, jsonb_build_array(${items.map(([sid, v]) => `jsonb_build_object('row_number', ${rowOf(sid)}, 'value', ${v})`).join(', ')}))::text`);
const MATCHES = (role, uid) => as(role, uid, `SELECT coalesce(string_agg(source_id || ':' || match_status || ':' || coalesce(matched_account_name, '-') || ':' || confidence || ':' || suggested_action, ',' ORDER BY source_id), '')
  FROM fin_mp_payout_matches(${P(MPACC)}::uuid) WHERE source_id LIKE '840000000%'`);   // this suite's payouts only
const RAW = (role, uid) => as(role, uid, `SELECT coalesce(json_agg(m)::text, '[]') FROM fin_mp_payout_matches(${P(MPACC)}::uuid) m WHERE m.source_id LIKE '840000000%'`);

// ── A. identifiers seeded from the approved configuration, private ──────────
expect('A-1 financial_account_identifier holds exactly the active configuration CBUs (BNA, Patagonia), primary, active',
  `(SELECT string_agg(a.nombre || ':' || i.identifier_type || ':' || (i.normalized_value = c.expected_cbu::text) || ':' || i.is_primary || ':' || i.active, ',' ORDER BY a.nombre)
     FROM financial_account_identifier i JOIN financial_account a ON a.id = i.financial_account_id
     JOIN fin_statement_account_config c ON c.financial_account_id = i.financial_account_id AND c.activo)`,
  'BNA:CBU:true:true:true,Patagonia:CBU:true:true:true');
const idc = 'SELECT count(*)::text FROM financial_account_identifier';
expect('A-2 no access for ADMIN / anon to the identifiers; service_role reads them',
  `(${as('authenticated', ADMIN, idc)} || '|' || ${as('anon', null, idc)} || '|' || ${as('service_role', null, idc)})`, 'ERR:permission denied%|ERR:permission denied%|OK:2');
expect('A-3 a CBU identifier must be 22 digits; one active value per type',
  `(pg_temp.err_of('INSERT INTO financial_account_identifier (financial_account_id, identifier_type, identifier_value, normalized_value) SELECT id, ''CBU'', ''123'', ''123'' FROM financial_account WHERE nombre = ''BNA''')
    || '|' || pg_temp.err_of('INSERT INTO financial_account_identifier (financial_account_id, identifier_type, identifier_value, normalized_value) SELECT financial_account_id, ''CBU'', expected_cbu, expected_cbu FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id WHERE a.nombre = ''BNA'''))`,
  'ERR:%chk_fai_cbu%|ERR:%uq_fai_active_value%');

// ── B. the payout day, recorded by the unchanged NORMAL ingestion + a VALIDATION capture of other bytes ──
expect('B-1 NORMAL run of the payout day → PARSED', NORMAL({ sha: sha('payout-match'), actor: null, rows: rowsOf(PDAY) }, 'R'), 'OK:%"status": "PARSED"%');
expect('B-2 VALIDATION capture of the same day (other bytes)', as('service_role', null, captureCall({ sha: sha('payout-match-validation'), rows: rowsOf(PDAY) }), 'V'), 'OK:%"status": "VALIDATED"%');
expect('B-3 destinations recorded on the NORMAL run (P1 BNA, P2 Patagonia, P3 third party, P4 third party)',
  record('R', [[PAYOUTS[0], CBU('BNA')], [PAYOUTS[1], CBU('Patagonia')], [PAYOUTS[2], EXTERNAL], [PAYOUTS[3], EXTERNAL]]), 'OK:4');
expect('B-4 the VALIDATION run reports P1 the same and P4 differently (conflict)', record('V', [[PAYOUTS[0], CBU('BNA')], [PAYOUTS[3], OTHER]]), 'OK:2');

// ── C. matches (ADMIN) ──────────────────────────────────────────────────────
expect('C-1 BNA exact · Patagonia exact · third party → classify · conflict → review · no destination → no row',
  MATCHES('authenticated', ADMIN),
  `OK:${PAYOUTS[0]}:OWN_ACCOUNT_EXACT:BNA:HIGH:PROPOSE_INTERNAL_TRANSFER,${PAYOUTS[1]}:OWN_ACCOUNT_EXACT:Patagonia:HIGH:PROPOSE_INTERNAL_TRANSFER,`
  + `${PAYOUTS[2]}:NO_OWN_ACCOUNT_MATCH:-:NONE:CLASSIFY_OUTFLOW,${PAYOUTS[3]}:DESTINATION_CONFLICT:-:REVIEW:REVIEW_DESTINATION`);
expect('C-2 the output never carries a CBU / destination value (no 22-digit run, only the documented columns)',
  `(SELECT (v !~ '[0-9]{22}' AND v LIKE '%"matched_account_id"%' AND v NOT LIKE '%normalized%' AND v NOT LIKE '%value%')::text FROM (SELECT ${RAW('authenticated', ADMIN)} AS v) x)`, 'true');
expect('C-3 OPERATOR → FORBIDDEN; anon and service_role → no EXECUTE',
  `(${MATCHES('authenticated', OPER)} || '|' || ${MATCHES('anon', null)} || '|' || ${MATCHES('service_role', null)})`,
  'ERR:FORBIDDEN%|ERR:permission denied%|ERR:permission denied%');
add(`UPDATE financial_account_identifier SET active = false WHERE identifier_type = 'CBU' AND financial_account_id = (SELECT id FROM financial_account WHERE nombre = 'Patagonia');
INSERT INTO financial_account_identifier (financial_account_id, identifier_type, identifier_value, normalized_value, active, valid_to)
SELECT id, 'CBU', ${EXTERNAL}, ${EXTERNAL}, true, CURRENT_DATE - 1 FROM financial_account WHERE nombre = 'Patagonia';`);
expect('C-4 an inactive identifier or one out of validity never matches (Patagonia off; third party registered but expired)',
  MATCHES('authenticated', ADMIN),
  `OK:${PAYOUTS[0]}:OWN_ACCOUNT_EXACT:BNA:HIGH:PROPOSE_INTERNAL_TRANSFER,${PAYOUTS[1]}:NO_OWN_ACCOUNT_MATCH:-:NONE:CLASSIFY_OUTFLOW,`
  + `${PAYOUTS[2]}:NO_OWN_ACCOUNT_MATCH:-:NONE:CLASSIFY_OUTFLOW,${PAYOUTS[3]}:DESTINATION_CONFLICT:-:REVIEW:REVIEW_DESTINATION`);
expect('C-5 another Mercado Pago account id → no rows', as('authenticated', ADMIN, `SELECT count(*)::text FROM fin_mp_payout_matches(gen_random_uuid())`), 'OK:0');

// ── D. perimeter and economy ────────────────────────────────────────────────
expect('D-1 fin_mp_payout_matches: DEFINER, STABLE, owner postgres, search_path=public, EXECUTE authenticated only',
  `(SELECT prosecdef || ':' || provolatile::text || ':' || pg_get_userbyid(proowner) || ':' || (proconfig @> ARRAY['search_path=public']) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
      || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'fin_mp_payout_matches')`,
  'true:s:postgres:true:falsetruefalse');
expect('D-2 identifier table: RLS on, one policy (service_role SELECT), no write privilege for any API role',
  `((SELECT relrowsecurity FROM pg_class WHERE relname = 'financial_account_identifier')
     AND (SELECT string_agg(policyname, ',') FROM pg_policies WHERE tablename = 'financial_account_identifier') = 'financial_account_identifier_service_select'
     AND NOT has_table_privilege('service_role', 'financial_account_identifier', 'INSERT,UPDATE,DELETE,TRUNCATE')
     AND NOT has_table_privilege('authenticated', 'financial_account_identifier', 'SELECT,INSERT,UPDATE,DELETE'))::text`, 'true');
expect('D-3 SECURITY DEFINER set = 80 (78 + fin_mp_payout_matches + 0086 mp_reclassify_inbound_own_transfer)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '80');
for (const t of ['financial_operation', 'financial_posting', 'mp_reconciliation', 'fin_statement_line']) {
  expect(`D-4 zero financial / bank effect: Δ ${t} = 0`, `(SELECT ((SELECT count(*) FROM ${t}) - b.n)::text FROM before_counts b WHERE b.t = ${lit(t)})`, '0');
}
expect('D-5 no transfer proposed is written anywhere (no TRANSFER operation created)',
  `(SELECT count(*)::text FROM financial_operation WHERE operation_type = 'TRANSFER' AND created_at >= (SELECT now()))`, '0');
expect('D-6 cron jobs unchanged; mp_v4_verified() false',
  `((SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job) || '|' || mp_v4_verified()::text)`, 'mp_release_report_daily,mp_release_report_daily_fallback,mp_worker_every_minute|false');

add('ROLLBACK;');

// ── run ──────────────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n');
let pass = 0;
let fail = 0;
for (const l of lines) {
  const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
  if (m) {
    if (m[1] === 'PASS') { pass += 1; console.log(`    OK   ${m[2]}`); } else { fail += 1; console.log(`    MAL  ${m[2]}`); }
  }
}
if (r.status !== 0) {
  fail += 1;
  console.log(`    MAL  psql aborted: ${(lines.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300)}`);
}
console.log(`\n  ══ ADR-018 0084 PAYOUT OWN-ACCOUNT MATCH RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
