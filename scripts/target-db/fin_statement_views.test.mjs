#!/usr/bin/env node
/**
 * ADR-018 — FINANCIAL STATEMENT STATUS VIEW TEST SUITE (migration 0076). LOCAL TEST DATABASE ONLY.
 *
 * fin_statement_line_status: columns, cutover classification (CUTOVER_UNRESOLVED / PRE_CUTOVER / POST_CUTOVER /
 * CUTOVER_AMBIGUOUS_DAY), active match status, security perimeter, and a PARITY sweep: for every synthetic
 * statement line, the view's classification must predict exactly what the write model
 * (fin_match_statement_line, 0075) accepts or refuses — before any cut and after the cuts.
 *
 * Everything runs inside ONE transaction that is rolled back (the ADR-018 tables are immutable / append-only).
 * Synthetic data only (tag ADR018-0076).
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_statement_views.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const ADMIN = 'aaaaaaaa-0076-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0076-0000-0000-00000000000b';
const ACC = (name) => `(SELECT id FROM financial_account WHERE nombre = '${name}')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0076-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const asAdmin = (call, key = null) => as('authenticated', ADMIN, call, key);

function importCall(o) {
  return `SELECT fin_import_bank_statement(${lit(ADMIN)}::uuid, ${P(ACC(o.account))}::uuid, ${lit(o.parser)}, ${lit(o.format)}, ${lit(o.sha)},
    ${lit(`bank/acc/${o.sha}.pdf`)}, 'statement.pdf', 1024, ${lit(o.from ?? null)}::date, ${lit(o.to)}::date,
    ${lit(JSON.stringify(o.meta))}::jsonb, NULL::uuid, NULL, ${lit(JSON.stringify(o.rows))}::jsonb)::text`;
}
const ctl = (n, type, balance) => ({ row_number: n, kind: 'CONTROL', control_type: type, balance, raw_row: { text: type } });
const eco = (n, pos, date, desc, ref, amt, bal, extra = {}) => ({
  row_number: n, kind: 'ECONOMIC', statement_position: pos, value_date: date, description_raw: desc, bank_reference: ref,
  signed_amount: amt, running_balance: bal, raw_row: { text: `${date} ${desc} ${amt}` }, ...extra });
const meta = (o, c) => ({ opening_balance: o, closing_balance: c });
const BNA = { account: 'BNA', format: 'BNA_MONTHLY_PDF_V1', parser: 'bna-v1.0.0' };
const PAT = { account: 'Patagonia', format: 'PATAGONIA_STATEMENT_PDF_V1', parser: 'pat-v1.0.0' };
const imp = (key, o) => expect(`import ${key}`, as('service_role', null, importCall(o), key), 'OK:%"status": "PARSED"%');
const line = (run, pos) => `(SELECT a.statement_line_id FROM fin_import_run_line a WHERE a.run_id = ${RES(run)}::uuid AND a.statement_position = ${pos})`;
const LN = (run, pos) => `${P(line(run, pos))}::bigint`;
const cls = (run, pos) => `(SELECT cutover_classification FROM fin_statement_line_status WHERE statement_line_id = ${LN(run, pos)})`;
const viewAsAdmin = (expr) => asAdmin(`SELECT (${expr})::text`);

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
-- parity sweep: one compatible posting per test line, then the view's class must predict the write model
CREATE TEMP TABLE pmap (statement_line_id BIGINT PRIMARY KEY, posting_id BIGINT NOT NULL);
CREATE FUNCTION pg_temp.parity(p_label TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
DECLARE r RECORD; c TEXT; o TEXT; want TEXT; bad INT := 0; n INT := 0; classes TEXT := '';
BEGIN
  FOR r IN SELECT * FROM pmap ORDER BY statement_line_id LOOP
    n := n + 1;
    c := pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT cutover_classification FROM fin_statement_line_status WHERE statement_line_id = ' || r.statement_line_id, NULL);
    o := pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT fin_match_statement_line(' || r.statement_line_id || ', ' || r.posting_id || ', ''parity'')::text', NULL);
    want := CASE c WHEN 'OK:POST_CUTOVER' THEN 'OK:%' WHEN 'OK:PRE_CUTOVER' THEN 'ERR:PRE_CUTOVER_LINE%'
                   WHEN 'OK:CUTOVER_UNRESOLVED' THEN 'ERR:CUTOVER_UNRESOLVED%' WHEN 'OK:CUTOVER_AMBIGUOUS_DAY' THEN 'ERR:CUTOVER_AMBIGUOUS_DAY%'
                   ELSE '<unexpected class>' END;
    IF o NOT LIKE want THEN
      bad := bad + 1;
      RAISE NOTICE 'FAIL parity % line % :: view [%] write model [%]', p_label, r.statement_line_id, c, o;
    END IF;
    IF o LIKE 'OK:%' THEN   -- keep the sweep independent: undo the successful match
      PERFORM pg_temp.run_as('authenticated', '${ADMIN}',
        'SELECT fin_reverse_statement_match(' || (substring(o FROM 4)::jsonb ->> 'match_id') || ', ''parity sweep'')::text', NULL);
    END IF;
    classes := classes || replace(c, 'OK:', '') || ';';
  END LOOP;
  IF bad = 0 THEN RAISE NOTICE 'PASS parity % (% lines: %)', p_label, n, classes; END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'adr018-0076-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0076-oper@test.local',  'OPERATOR');`);

// ── data: BNA A (positions 1–3), overlapping B (3 known + position 4), next month L; Patagonia P1, P4 ─
imp('A', { ...BNA, sha: sha('A'), from: '2026-07-31', to: '2026-08-31', meta: meta('1000.00', '858.56'), rows: [
  ctl(1, 'SALDO_ANTERIOR', '1000.00'),
  eco(2, 1, '2026-08-04', 'GRAVAMEN LEY 25413 S/DEB', '21', '-240.00', '760.00'),
  eco(3, 2, '2026-08-04', 'GRAVAMEN LEY 25413 S/CRED', '21', '-1.44', '758.56'),
  eco(4, 3, '2026-08-05', 'DEBIN 30000000000', '412', '100.00', '858.56'),
  ctl(5, 'SALDO_FINAL', '858.56')] });
imp('B', { ...BNA, sha: sha('B'), from: '2026-07-31', to: '2026-08-31', meta: meta('1000.00', '958.56'), rows: [
  eco(1, 1, '2026-08-04', 'GRAVAMEN LEY 25413 S/DEB', '21', '-240.00', '760.00'),
  eco(2, 2, '2026-08-04', 'GRAVAMEN LEY 25413 S/CRED', '21', '-1.44', '758.56'),
  eco(3, 3, '2026-08-05', 'DEBIN 30000000000', '412', '100.00', '858.56'),
  eco(4, 4, '2026-08-10', 'DEBIN 30000000000', '413', '100.00', '958.56')] });
imp('L', { ...BNA, sha: sha('L'), from: '2026-08-31', to: '2026-09-30', meta: meta('958.56', '889.56'), rows: [
  eco(1, 1, '2026-09-02', 'COMIS.COMPENSACION ATEN C', '427', '-69.00', '889.56')] });
imp('P1', { ...PAT, sha: sha('P1'), from: '2026-02-27', to: '2026-06-30', meta: meta('994.00', '1491.00'), rows: [
  eco(1, 1, '2026-06-05', 'IMP.DB/CR BANCARIOS P/CREDITOS', '', '-3.00', null),
  eco(2, 2, '2026-06-05', 'TRANSFERENCIA ENTRE CUENTAS', '', '500.00', '1491.00')] });
imp('P4', { ...PAT, sha: sha('P4'), from: '2026-06-30', to: '2026-09-30', meta: meta('1491.00', '1991.00'), rows: [
  eco(1, 1, '2026-09-01', 'TRANSFERENCIA ENTRE CUENTAS', '', '500.00', '1991.00')] });

// one compatible posting per line (same account, same signed amount), for the parity sweep
add(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('ADJUSTMENT', '2026-08-04', 'ADR018-0076-PARITY', 'test');
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT (SELECT id FROM financial_operation WHERE external_ref = 'ADR018-0076-PARITY'), financial_account_id, signed_amount, '2026-08-04'
  FROM fin_statement_line WHERE first_run_id IN (SELECT (v ->> 'run_id')::uuid FROM res WHERE k IN ('A','B','L','P1','P4')) ORDER BY id;`);
// pair lines and postings 1:1 (equal account and amount; ties paired by order)
add(`WITH l AS (SELECT id, financial_account_id, signed_amount, row_number() OVER (PARTITION BY financial_account_id, signed_amount ORDER BY id) rn
             FROM fin_statement_line WHERE first_run_id IN (SELECT (v ->> 'run_id')::uuid FROM res WHERE k IN ('A','B','L','P1','P4'))),
     p AS (SELECT p.id, p.financial_account_id, p.signed_amount, row_number() OVER (PARTITION BY p.financial_account_id, p.signed_amount ORDER BY p.id) rn
             FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = 'ADR018-0076-PARITY')
INSERT INTO pmap SELECT l.id, p.id FROM l JOIN p USING (financial_account_id, signed_amount, rn);`);
expect('every test line has a compatible posting', `(SELECT (count(*) = 8)::text FROM pmap)`, 'true');

// ── 1. columns and perimeter ─────────────────────────────────────────────────
expect('view columns (exact order)',
  `(SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fin_statement_line_status')`,
  'statement_line_id,financial_account_id,value_date,description_raw,description_norm,bank_reference,fecha_valor,signed_amount,running_balance,fingerprint,first_run_id,created_at,active_cutover_id,cutoff_statement_line_id,opening_balance,cutover_classification,active_match_id,financial_operation_id,financial_posting_id,matched_by,matched_at,match_reason,reconciliation_status');
expect('security_invoker view owned by postgres',
  `(SELECT pg_get_userbyid(relowner) || '|' || (reloptions @> ARRAY['security_invoker=true'])::text FROM pg_class WHERE relname = 'fin_statement_line_status' AND relkind = 'v')`, 'postgres|true');
expect('grants: SELECT for authenticated only',
  `(SELECT string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type) FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'fin_statement_line_status' AND grantee IN ('PUBLIC','anon','authenticated','service_role'))`, 'authenticated:SELECT');
expect('no function added by 0076: SECURITY DEFINER set 76 after 0078 / 0079', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '76');
expect('the view never reads the global cutover instant or the MP boundary',
  `(SELECT (pg_get_viewdef('fin_statement_line_status'::regclass) !~* '(cutover_at|mp_cutover_boundary)')::text)`, 'true');
expect('ADMIN reads every test line (8)', viewAsAdmin(`SELECT count(*) FROM fin_statement_line_status
  WHERE statement_line_id = ANY (string_to_array(${P(`(SELECT string_agg(statement_line_id::text, ',') FROM pmap)`)}, ',')::bigint[])`), 'OK:8');
expect('OPERATOR reads 0 rows', as('authenticated', OPER, 'SELECT count(*)::text FROM fin_statement_line_status'), 'OK:0');
expect('anon has no access', as('anon', null, 'SELECT count(*)::text FROM fin_statement_line_status'), 'ERR:permission denied for view%');
expect('service_role has no access', as('service_role', null, 'SELECT count(*)::text FROM fin_statement_line_status'), 'ERR:permission denied for view%');
expect('no INSERT through the view', asAdmin(`INSERT INTO fin_statement_line_status (statement_line_id) VALUES (1) RETURNING 1`), 'ERR:cannot % view "fin_statement_line_status"%');
expect('no UPDATE through the view', asAdmin(`WITH u AS (UPDATE fin_statement_line_status SET description_raw = 'x' RETURNING 1) SELECT count(*)::text FROM u`), 'ERR:cannot % view "fin_statement_line_status"%');
expect('no DELETE through the view', asAdmin(`WITH d AS (DELETE FROM fin_statement_line_status RETURNING 1) SELECT count(*)::text FROM d`), 'ERR:cannot % view "fin_statement_line_status"%');

// ── 2. no cut: everything CUTOVER_UNRESOLVED, and the write model refuses ────
expect('no cut → CUTOVER_UNRESOLVED (BNA)', viewAsAdmin(cls('A', 3)), 'OK:CUTOVER_UNRESOLVED');
expect('no cut → CUTOVER_UNRESOLVED (Patagonia)', viewAsAdmin(cls('P4', 1)), 'OK:CUTOVER_UNRESOLVED');
expect('no cut → no cutover columns', viewAsAdmin(`SELECT (active_cutover_id IS NULL AND cutoff_statement_line_id IS NULL AND opening_balance IS NULL)::text FROM fin_statement_line_status WHERE statement_line_id = ${LN('A', 3)}`), 'OK:true');
add(`SELECT pg_temp.parity('before any cut');`);

// ── 3. cuts: BNA anchor = statement A position 2; Patagonia anchor = P4 position 1 ─
expect('BNA cut', asAdmin(`SELECT fin_resolve_statement_cutover(${P(ACC('BNA'))}::uuid, ${P(line('A', 2))}::bigint, 758.56, 'statement A line 2', NULL)::text`, 'CUT_BNA'), 'OK:%');
expect('Patagonia cut', asAdmin(`SELECT fin_resolve_statement_cutover(${P(ACC('Patagonia'))}::uuid, ${P(line('P4', 1))}::bigint, 1991.00, 'statement AL 30/09', NULL)::text`, 'CUT_PAT'), 'OK:%');
// a later Patagonia statement adds another line on the anchor date (allowed at import; ambiguous for reconciliation)
imp('P5', { ...PAT, sha: sha('P5'), from: '2026-06-30', to: '2026-09-30', meta: meta('1491.00', '1981.00'), rows: [
  eco(1, 1, '2026-09-01', 'TRANSFERENCIA ENTRE CUENTAS', '', '500.00', '1991.00'),
  eco(2, 2, '2026-09-01', 'COMISION MANTENIMIENTO', '', '-10.00', '1981.00')] });
imp('P6', { ...PAT, sha: sha('P6'), from: '2026-09-30', to: '2026-12-30', meta: meta('1981.00', '2081.00'), rows: [
  eco(1, 1, '2026-10-02', 'TRANSFERENCIA ENTRE CUENTAS', '', '100.00', '2081.00')] });
add(`WITH l AS (SELECT id, financial_account_id, signed_amount FROM fin_statement_line WHERE first_run_id IN (SELECT (v ->> 'run_id')::uuid FROM res WHERE k IN ('P5','P6'))),
ins AS (INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
        SELECT (SELECT id FROM financial_operation WHERE external_ref = 'ADR018-0076-PARITY'), financial_account_id, signed_amount, '2026-09-01' FROM l ORDER BY id
        RETURNING id, financial_account_id, signed_amount)
INSERT INTO pmap SELECT l.id, (SELECT min(i.id) FROM ins i WHERE i.financial_account_id = l.financial_account_id AND i.signed_amount = l.signed_amount) FROM l;`);

expect('BNA line before the anchor → PRE', viewAsAdmin(cls('A', 1)), 'OK:PRE_CUTOVER');
expect('BNA anchor → PRE', viewAsAdmin(cls('A', 2)), 'OK:PRE_CUTOVER');
expect('BNA line after the anchor → POST', viewAsAdmin(cls('A', 3)), 'OK:POST_CUTOVER');
expect('BNA overlapping statement line (position 4) → POST', viewAsAdmin(cls('B', 4)), 'OK:POST_CUTOVER');
expect('BNA ALREADY_KNOWN appearance does not change the class (B position 1 = A position 1)', viewAsAdmin(cls('B', 1)), 'OK:PRE_CUTOVER');
expect('BNA next statement → POST', viewAsAdmin(cls('L', 1)), 'OK:POST_CUTOVER');
expect('Patagonia earlier date → PRE', viewAsAdmin(cls('P1', 2)), 'OK:PRE_CUTOVER');
expect('Patagonia anchor → PRE', viewAsAdmin(cls('P4', 1)), 'OK:PRE_CUTOVER');
expect('Patagonia other line on the anchor date → CUTOVER_AMBIGUOUS_DAY', viewAsAdmin(cls('P5', 2)), 'OK:CUTOVER_AMBIGUOUS_DAY');
expect('Patagonia later date → POST', viewAsAdmin(cls('P6', 1)), 'OK:POST_CUTOVER');
expect('cut columns exposed', viewAsAdmin(`SELECT format('%s|%s', opening_balance, (cutoff_statement_line_id = ${LN('A', 2)})) FROM fin_statement_line_status WHERE statement_line_id = ${LN('A', 3)}`), 'OK:758.56|t');
expect('no NULL class among test lines', viewAsAdmin(`SELECT count(*)::text FROM fin_statement_line_status WHERE cutover_classification IS NULL`), 'OK:0');
add(`SELECT pg_temp.parity('after the cuts');`);

// supersession moves the anchor; the view follows the active cut only
expect('BNA cut superseded (anchor = A position 1)', asAdmin(`SELECT fin_resolve_statement_cutover(${P(ACC('BNA'))}::uuid, ${P(line('A', 1))}::bigint, 760.00, 'statement A line 1', 'anchor corrected')::text`), 'OK:%');
expect('after supersession A position 2 → POST', viewAsAdmin(cls('A', 2)), 'OK:POST_CUTOVER');
add(`SELECT pg_temp.parity('after supersession');`);

// ── 4. match status ──────────────────────────────────────────────────────────
add(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('ADJUSTMENT', '2026-08-05', 'ADR018-0076-M', 'test');
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT o.id, a.id, 100.00, '2026-08-05' FROM financial_operation o, financial_account a WHERE o.external_ref = 'ADR018-0076-M' AND a.nombre = 'BNA';
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT o.id, a.id, 100.00, '2026-08-05' FROM financial_operation o, financial_account a WHERE o.external_ref = 'ADR018-0076-M' AND a.nombre = 'BNA';`);
const PM = (n) => `(SELECT p.id FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = 'ADR018-0076-M' ORDER BY p.id OFFSET ${n} LIMIT 1)`;
expect('no match → UNMATCHED', viewAsAdmin(`SELECT format('%s|%s', reconciliation_status, coalesce(active_match_id::text, 'NULL')) FROM fin_statement_line_status WHERE statement_line_id = ${LN('A', 3)}`), 'OK:UNMATCHED|NULL');
expect('match', asAdmin(`SELECT fin_match_statement_line(${P(line('A', 3))}::bigint, ${P(PM(0))}::bigint, 'bank debit')::text`, 'M1'), 'OK:%');
expect('active match → MATCHED with the right ids',
  viewAsAdmin(`SELECT format('%s|%s|%s|%s|%s|%s', s.reconciliation_status, (s.active_match_id = ${P(RES('M1', 'match_id'))}::bigint), (s.financial_posting_id = ${P(PM(0))}::bigint),
     (s.financial_operation_id = (SELECT id FROM financial_operation WHERE external_ref = 'ADR018-0076-M')), (s.matched_by = '${ADMIN}'), s.match_reason)
     FROM fin_statement_line_status s WHERE s.statement_line_id = ${LN('A', 3)}`),
  'OK:MATCHED|t|t|t|t|bank debit');
expect('reverse', asAdmin(`SELECT fin_reverse_statement_match(${P(RES('M1', 'match_id'))}::bigint, 'wrong posting')::text`), 'OK:%');
expect('after reversal → UNMATCHED', viewAsAdmin(`SELECT format('%s|%s', reconciliation_status, coalesce(active_match_id::text, 'NULL')) FROM fin_statement_line_status WHERE statement_line_id = ${LN('A', 3)}`), 'OK:UNMATCHED|NULL');
expect('rematch', asAdmin(`SELECT fin_match_statement_line(${P(line('A', 3))}::bigint, ${P(PM(1))}::bigint, 'second pick')::text`, 'M2'), 'OK:%');
expect('rematch → new active_match_id and posting',
  viewAsAdmin(`SELECT format('%s|%s|%s|%s', s.reconciliation_status, (s.active_match_id = ${P(RES('M2', 'match_id'))}::bigint),
     (s.active_match_id <> ${P(RES('M1', 'match_id'))}::bigint), (s.financial_posting_id = ${P(PM(1))}::bigint)) FROM fin_statement_line_status s WHERE s.statement_line_id = ${LN('A', 3)}`),
  'OK:MATCHED|t|t|t');
expect('one row per line (history not multiplied)', viewAsAdmin(`SELECT count(*)::text FROM fin_statement_line_status WHERE statement_line_id = ${LN('A', 3)}`), 'OK:1');

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
console.log(`\n  ══ ADR-018 0076 RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
