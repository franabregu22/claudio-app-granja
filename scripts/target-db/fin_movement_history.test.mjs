#!/usr/bin/env node
/**
 * 0113 — HISTORIAL FINANCIERO UNIFICADO. LOCAL TEST DATABASE ONLY. Every value is synthetic.
 *
 * fin_movement_history: permissions (ADMIN only), real pagination with a total and a stable order for ties, one row per operation
 * (a transfer with two postings is one row), filters by period, account and kind, search by concept, reference, operation number and
 * amount (what the user types is never a pattern), parameter checks, no declared collection and no unpaid obligation among the
 * movements, the rows of an account add up to its balance, and nothing is written.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_movement_history.test.mjs
 */
import { spawnSync } from 'node:child_process';
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
const ADMIN = 'aaaaaaaa-0113-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0113-0000-0000-00000000000b';
const CLI = 'cccccccc-0113-0000-0000-0000000000d1';
const ACC1 = 'bbbbbbbb-0113-0000-0000-0000000000a1';
const ACC2 = 'bbbbbbbb-0113-0000-0000-0000000000a2';
const ACC3 = 'bbbbbbbb-0113-0000-0000-0000000000a3';
// a year no other row uses: the period filter isolates this suite from whatever the local database holds
const Y = '2031';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
const hist = ({ from = `${Y}-01-01`, to = `${Y}-12-31`, account = null, kind = null, search = null, amount = null, limit = 50, offset = 0 } = {}) =>
  `SELECT fin_movement_history(${lit(from)}::date, ${lit(to)}::date, ${account ? lit(account) : 'NULL'}::uuid, ${lit(kind)}, ${lit(search)}, ${amount ?? 'NULL'}::numeric, ${limit}, ${offset})::text`;
const got = (key, expr) => `(SELECT ${expr} FROM res WHERE k = ${lit(key)})`;
const total = (key) => got(key, `v ->> 'total'`);
const rows = (key) => got(key, `jsonb_array_length(v -> 'rows')::text`);
const run = (key, opts) => add(`SELECT pg_temp.must(${lit(key)}, ${A(hist(opts), key)});`);
const COUNT = ['financial_operation', 'financial_posting', 'audit_events'].map((t) => `SELECT count(*) FROM ${t}`).join(' UNION ALL ');

add(`\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false;
BEGIN
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
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
CREATE FUNCTION pg_temp.must(p_name TEXT, p_got TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE 'OK:%' THEN RAISE NOTICE 'FAIL setup % :: %', p_name, left(p_got, 300); END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'hist-0113-admin@test.local', 'ADMIN'),
  ('${OPER}',  'hist-0113-oper@test.local',  'OPERATOR');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente Historial');
INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type, reason)
VALUES ('${CLI}', 'ADJUSTMENT', 10000, '${Y}-06-01', 'Cliente Historial', 'test', 'deuda inicial sintética');
INSERT INTO financial_account (id, nombre, account_type) VALUES
  ('${ACC1}', 'ZZ Hist Uno', 'BANK_ACCOUNT'), ('${ACC2}', 'ZZ Hist Dos', 'CASH'), ('${ACC3}', 'ZZ Hist Tres', 'BANK_ACCOUNT');
INSERT INTO management_period (periodo_fecha, status) VALUES ('${Y}-06-01', 'OPEN') ON CONFLICT DO NOTHING;
CREATE FUNCTION pg_temp.op(p_type financial_operation_type, p_date DATE, p_ref TEXT, p_reason TEXT, p_postings JSONB) RETURNS BIGINT LANGUAGE plpgsql AS $f$
DECLARE v BIGINT; x JSONB;
BEGIN
  INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES (p_type, p_date, p_ref, p_reason) RETURNING id INTO v;
  FOR x IN SELECT value FROM jsonb_array_elements(p_postings) LOOP
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
    VALUES (v, (x ->> 'a')::uuid, (x ->> 's')::numeric, p_date);
  END LOOP;
  RETURN v;
END $f$;
-- 120 cash movements on one day: every order decision here is a tie on the date
SELECT pg_temp.op('SESSION_CASH', '${Y}-03-15', 'T113-TIE-' || g, 'empate ' || g, jsonb_build_array(jsonb_build_object('a', '${ACC2}', 's', g))) FROM generate_series(1, 120) g;
SELECT pg_temp.op('TRANSFER', '${Y}-04-01', 'T113-TRF', 'Depósito del lunes', '[{"a": "${ACC2}", "s": -5000}, {"a": "${ACC1}", "s": 5000}]');
SELECT pg_temp.op('COLLECTION', '${Y}-04-02', 'T113-COB', 'Cobro de prueba', '[{"a": "${ACC1}", "s": 777.25}]');
SELECT pg_temp.op('SUPPLIER_PAYMENT', '${Y}-04-03', 'T113-PAG', 'Pago 100% al_proveedor', '[{"a": "${ACC1}", "s": -1234.50}]');
SELECT pg_temp.op('BANK_TAX', '${Y}-04-04', 'T113-TAX', NULL, '[{"a": "${ACC1}", "s": -30}]');
SELECT pg_temp.op('INSTRUMENT_DEBIT', '${Y}-05-05', 'T113-CHQ', NULL, '[{"a": "${ACC3}", "s": -900}]');
SELECT pg_temp.op('ADJUSTMENT', '${Y}-05-06', 'T113-AJU', 'Ajuste', '[{"a": "${ACC3}", "s": 15}]');
-- an operation without a posting is no movement
INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('ADJUSTMENT', '${Y}-05-07', 'T113-EMPTY', 'sin asientos');`);

const ALL = 126;
const TRF = `(SELECT id FROM financial_operation WHERE external_ref = 'T113-TRF')`;

// ── A. permissions ──
const ERR_DENIED = 'ERR:permission denied for function fin_movement_history%';
expect('A-1 anon has no EXECUTE', as('anon', null, hist()), ERR_DENIED);
expect('A-2 service_role has no EXECUTE', as('service_role', null, hist()), ERR_DENIED);
expect('A-3 OPERATOR is refused', as('authenticated', OPER, hist()), 'ERR:FORBIDDEN%');
expect('A-4 an authenticated session without a profile is refused', as('authenticated', 'aaaaaaaa-0113-0000-0000-0000000000ff', hist()), 'ERR:%');
expect('A-5 ADMIN reads', A(hist()), 'OK:%');
expect('A-6 the internal classifier is not callable by any API role',
  `(SELECT has_function_privilege('anon', 'fin_movement_class(text,text)', 'EXECUTE')::text || has_function_privilege('authenticated', 'fin_movement_class(text,text)', 'EXECUTE')::text || has_function_privilege('service_role', 'fin_movement_class(text,text)', 'EXECUTE')::text)`, 'falsefalsefalse');
expect('A-7 the RPC is STABLE and a definer with a fixed search_path',
  `(SELECT provolatile::text || prosecdef::text || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'fin_movement_history(date,date,uuid,text,text,numeric,integer,integer)'::regprocedure)`, 'strue%search_path=public%');

// ── B. pagination, total, order ──
run('p0', { limit: 50, offset: 0 });
run('p1', { limit: 50, offset: 50 });
run('p2', { limit: 50, offset: 100 });
run('p3', { limit: 50, offset: 150 });
expect('B-1 the total is the whole filter, on every page', `(${total('p0')} || '|' || ${total('p1')} || '|' || ${total('p2')} || '|' || ${total('p3')})`, `${ALL}|${ALL}|${ALL}|${ALL}`);
expect('B-2 page sizes: 50, 50, 26, then empty', `(${rows('p0')} || '|' || ${rows('p1')} || '|' || ${rows('p2')} || '|' || ${rows('p3')})`, '50|50|26|0');
add(`CREATE TEMP TABLE paged AS SELECT p, ord, (r ->> 'operation_id')::bigint AS id, (r ->> 'effective_date')::date AS d
  FROM (VALUES ('p0', 0), ('p1', 1), ('p2', 2)) k(key, p) JOIN res ON res.k = k.key CROSS JOIN LATERAL jsonb_array_elements(res.v -> 'rows') WITH ORDINALITY t(r, ord);`);
expect('B-3 no operation repeats or is lost across pages', `(SELECT count(*)::text || '|' || count(DISTINCT id)::text FROM paged)`, `${ALL}|${ALL}`);
expect('B-4 newest date first, and on a tied date the highest id first', `(SELECT count(*)::text FROM (SELECT d, id, lag(d) OVER w AS d0, lag(id) OVER w AS id0 FROM paged WINDOW w AS (ORDER BY p, ord)) o WHERE d > d0 OR (d = d0 AND id >= id0))`, '0');
add(`SELECT pg_temp.must('again', ${A(hist({ limit: 50, offset: 50 }), 'p1b')});`);
expect('B-5 the same page twice is the same page', `(${got('p1', `md5(v::text)`)} = ${got('p1b', `md5(v::text)`)})::text`, 'true');

// ── C. one row per operation ──
run('t', { kind: 'TRANSFERENCIA' });
expect('C-1 a transfer with two postings is one row', `(${total('t')} || '|' || ${got('t', `(v -> 'rows' -> 0 -> 'postings') ->> 0 IS NOT NULL`)}::text || '|' || ${got('t', `jsonb_array_length(v -> 'rows' -> 0 -> 'postings')::text`)})`, '1|true|2');
expect('C-2 seen from all the accounts it nets 0 and moved its amount', `(${got('t', `(v -> 'rows' -> 0 ->> 'net_amount')::numeric`)}::text || '|' || ${got('t', `(v -> 'rows' -> 0 ->> 'moved_amount')::numeric`)}::text)`, '0%|5000.00');
expect('C-3 the detail names both accounts, the outflow first', got('t', `(v -> 'rows' -> 0 -> 'postings' -> 0 ->> 'account_name') || '>' || (v -> 'rows' -> 0 -> 'postings' -> 1 ->> 'account_name')`), 'ZZ Hist Dos>ZZ Hist Uno');
run('t1', { kind: 'TRANSFERENCIA', account: ACC1 });
run('t2', { kind: 'TRANSFERENCIA', account: ACC2 });
expect('C-4 in the receiving account it is +5000', got('t1', `(v -> 'rows' -> 0 ->> 'net_amount')::numeric::text`), '5000.00');
expect('C-5 in the paying account it is −5000', got('t2', `(v -> 'rows' -> 0 ->> 'net_amount')::numeric::text`), '-5000.00');
expect('C-6 filtered by an account it still shows both postings', got('t2', `jsonb_array_length(v -> 'rows' -> 0 -> 'postings')::text`), '2');
run('t3', { kind: 'TRANSFERENCIA', account: ACC3 });
expect('C-7 another account does not see it', total('t3'), '0');
run('all', { limit: 100 });
expect('C-8 an operation without a posting is no movement', got('all', `(v::text LIKE '%T113-EMPTY%')::text`), 'false');

// ── D. filters ──
run('d1', { from: `${Y}-05-01`, to: `${Y}-05-31` });
expect('D-1 period', total('d1'), '2');
run('d2', { from: `${Y}-04-02`, to: `${Y}-04-02` });
expect('D-2 a one-day period includes that day', total('d2'), '1');
run('d3', { account: ACC3 });
expect('D-3 account', total('d3'), '2');
for (const [k, kind, n] of [['k1', 'COBRO', 1], ['k2', 'PAGO', 2], ['k3', 'CARGO', 1], ['k4', 'OTRO', 121], ['k5', 'PENDIENTE_MP', 0]]) {
  run(k, { kind });
  expect(`D-4 kind ${kind}`, total(k), String(n));
}
run('d5', { account: ACC1, kind: 'PAGO', from: `${Y}-04-03`, to: `${Y}-04-03` });
expect('D-5 the filters add up', total('d5'), '1');
run('d6', { from: null, to: null, account: ACC1 });
expect('D-6 without a period: from the first operation', total('d6'), '4');

// ── E. search ──
for (const [k, search, n, what] of [['s1', 'lunes', 1, 'the reason'], ['s2', 'DEPÓSITO', 1, 'the reason, any case'], ['s3', 'T113-COB', 1, 'the reference'], ['s4', 'impuesto bancario', 1, 'the name'], ['s5', 'cheque', 1, 'the name']]) {
  run(k, { search });
  expect(`E-1 searches ${what}: ${search}`, total(k), String(n));
}
run('s6', { search: '%' });
expect('E-2 % is text, not a pattern', `(${total('s6')} || '|' || ${got('s6', `(v -> 'rows' -> 0 ->> 'external_ref')`)})`, '1|T113-PAG');
run('s7', { search: '_' });
expect('E-3 _ is text, not a pattern', total('s7'), '1');
run('s8', { search: "'; DROP TABLE x; --" });
expect('E-4 a hostile text is only text', total('s8'), '0');
run('a1', { search: 'qqqq', amount: 1234.5 });
expect('E-5 by amount, whatever its sign', `(${total('a1')} || '|' || ${got('a1', `(v -> 'rows' -> 0 ->> 'external_ref')`)})`, '1|T113-PAG');
run('a2', { search: 'qqqq', amount: 5000 });
expect('E-6 a transfer is found once by its amount', total('a2'), '1');
run('a3', { search: 'qqqq', amount: 5000, account: ACC3 });
expect('E-7 the amount respects the account', total('a3'), '0');
add(`SELECT pg_temp.must('byid', pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT fin_movement_history(NULL, NULL, NULL, NULL, ' || quote_literal(${TRF}::text) || ', NULL, 50, 0)::text', 'byid'));`);
expect('E-8 by operation number', `(${total('byid')} || '|' || ${got('byid', `(v -> 'rows' -> 0 ->> 'external_ref')`)})`, '1|T113-TRF');

// ── F. parameters ──
expect('F-1 limit 0', A(hist({ limit: 0 })), 'ERR:INVALID_LIMIT%');
expect('F-2 limit 101', A(hist({ limit: 101 })), 'ERR:INVALID_LIMIT%');
expect('F-3 negative offset', A(hist({ offset: -1 })), 'ERR:INVALID_OFFSET%');
expect('F-4 from after to', A(hist({ from: `${Y}-02-01`, to: `${Y}-01-01` })), 'ERR:INVALID_RANGE%');
expect('F-5 unknown kind', A(hist({ kind: 'X' })), 'ERR:INVALID_KIND%');
expect('F-6 a search above 100 characters', A(hist({ search: 'x'.repeat(101) })), 'ERR:INVALID_SEARCH%');

// ── G. what is not a movement ──
add(`CREATE TEMP TABLE snap AS SELECT row_number() OVER () AS i, count FROM (${COUNT}) c;`);
add(`SELECT pg_temp.must('before', ${A(hist({ from: null, to: null, limit: 1 }), 'g0')});`);
const CAT = `(SELECT id FROM expense_category WHERE activo AND group_id IS NOT NULL ORDER BY nombre LIMIT 1)`;
expect('G-1 a declared Mercado Pago collection registers', A(`SELECT register_declared_collection('${CLI}'::uuid, 250, '${Y}-06-02'::date, 'declarado', 'h-decl-1')::text`), 'OK:%');
add(`SELECT pg_temp.must('pending', pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT register_pending_expense(''${Y}-06-02''::date, 300, 300, ''' || ${CAT} || '''::uuid, ''Gasto impago'', ''OPERATING'', ''h-pend-1'')::text', NULL));`);
expect('G-2 an unpaid fiscal obligation registers', A(`SELECT register_fiscal_obligation('IIBB', '${Y}-06-01'::date, 400, '${Y}-07-10'::date)::text`), 'OK:%');
add(`SELECT pg_temp.must('after', ${A(hist({ from: null, to: null, limit: 1 }), 'g1')});`);
expect('G-3 none of them is a movement: same total', `(${total('g0')} = ${total('g1')})::text`, 'true');
run('g2', { from: `${Y}-06-01`, to: `${Y}-06-30` });
expect('G-4 nothing dated there', total('g2'), '0');

// ── H. the rows of an account are its balance; nothing written ──
add(`SELECT pg_temp.must('sum', ${A(hist({ from: null, to: null, account: ACC1, limit: 100 }), 'h1')});`);
expect('H-1 Σ of an account\'s rows = Σ of its postings', `(${got('h1', `(SELECT sum((r ->> 'net_amount')::numeric) FROM jsonb_array_elements(v -> 'rows') r)`)} = (SELECT sum(signed_amount) FROM financial_posting WHERE financial_account_id = '${ACC1}'))::text`, 'true');
add(`CREATE TEMP TABLE snap2 AS SELECT row_number() OVER () AS i, count FROM (${COUNT}) c;`);
add(`SELECT pg_temp.must('read', ${A(hist({ limit: 100 }))});`);
expect('H-2 reading writes nothing: operations, postings, audit', `(SELECT count(*)::text FROM snap2 s JOIN (SELECT row_number() OVER () AS i, count FROM (${COUNT}) c) n USING (i) WHERE s.count <> n.count)`, '0');

// ── I. every operation type has a kind and a name ──
expect('I-1 every financial_operation_type is named in Spanish', `(SELECT coalesce(string_agg(e.enumlabel, ','), 'ok') FROM pg_enum e CROSS JOIN LATERAL fin_movement_class(e.enumlabel, NULL) c WHERE e.enumtypid = 'financial_operation_type'::regtype AND (c.label = e.enumlabel OR c.kind IS NULL))`, 'ok');
for (const [ref, type, kind, label] of [
  ['MP-PENDING:1', 'ADJUSTMENT', 'PENDIENTE_MP', 'Pendiente de clasificar'], ['MP-PENDING-RELEASE:1', 'ADJUSTMENT', 'PENDIENTE_MP', 'Clasificación de salida'],
  ['EXPENSE-PENDING:1', 'PURCHASE_PAYMENT', 'PAGO', 'Gasto (sin clasificar al registrarse)'], ['MP:MPA:1:TAX', 'ADJUSTMENT', 'CARGO', 'Impuesto de Mercado Pago'],
  ['MP:MPA:1:NET', 'MP_SETTLEMENT', 'COBRO', 'Cobro Mercado Pago'], ['MP-OUTFLOW-TAX:1', 'ADJUSTMENT', 'CARGO', 'Impuesto Débitos/Créditos (Mercado Pago)'],
  ['MP-INBOUND-RECLASS:1', 'MP_SETTLEMENT', 'OTRO', 'Reclasificación de entrada Mercado Pago'], ['MP-INBOUND-TRANSFER:1', 'TRANSFER', 'TRANSFERENCIA', 'Transferencia'],
  ['COLLECTION-CORRECTION:1', 'ADJUSTMENT', 'OTRO', 'Corrección de cobro'], ['COLLECTION-CORRECTION-CASH:1', 'COLLECTION', 'COBRO', 'Corrección de cobro'], ['PHASE31-OPENING:1', 'ADJUSTMENT', 'OTRO', 'Saldo inicial'],
]) expect(`I-2 ${ref}`, `(SELECT c.kind || '|' || c.label FROM fin_movement_class(${lit(type)}, ${lit(ref)}) c)`, `${kind}|${label}`);

add('ROLLBACK;');

// ── run ────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const lines = out.split('\n').map((l) => l.replace(/^.*NOTICE:\s+/, '').trim());
const pass = lines.filter((l) => l.startsWith('PASS ')).length;
const fail = lines.filter((l) => l.startsWith('FAIL '));
for (const f of fail) console.log(`  ${f}`);
console.log(`\n  ${pass} passed, ${fail.length} failed`);
if (r.status !== 0 || fail.length > 0 || pass === 0) {
  if (r.status !== 0) console.log(out.slice(-2000));
  process.exit(1);
}
