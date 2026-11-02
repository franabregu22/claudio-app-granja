#!/usr/bin/env node
/**
 * Lote 5 (ADR-027, 0112) — COBROS DECLARADOS DE MERCADO PAGO. LOCAL TEST DATABASE ONLY. Every value is synthetic.
 *
 * A declaration lowers the client's balance and moves no money; advances work; annul and rectify compensate in client_ledger; idempotency,
 * audit, closed periods; only ADMIN; a new manual Mercado Pago allocation is refused (with or without classification), while reversals of
 * existing allocations, the historical correction, AUTO and the classification without a client stay; a new payer mapping is refused
 * (create, reactivate, repoint) while history and unmapping stay; cash and bank unchanged.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_declared_collections.test.mjs
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
const ADMIN = 'aaaaaaaa-0112-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0112-0000-0000-00000000000b';
const CLI = 'cccccccc-0112-0000-0000-0000000000d1';
const CLI2 = 'cccccccc-0112-0000-0000-0000000000d2';
const DAY = '2026-11-05';
const CLOSED = '2026-03-10';
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const svc = (q, key = null) => as('service_role', null, q, key);
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
const O = (q) => as('authenticated', OPER, q);

const MONEY = ['financial_operation', 'financial_posting', 'mp_reconciliation', 'mp_financial_movement', 'mp_transition_identity', 'mp_source_record', 'mp_client_allocation', 'collections', 'collection_reversal'];
const counts = () => MONEY.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `coalesce((SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n), 'none')`;
const BALANCES = `(SELECT md5(coalesce(string_agg(a.nombre || ':' || x.s, '#' ORDER BY a.nombre), '')) FROM financial_account a
  LEFT JOIN LATERAL (SELECT coalesce(sum(p.signed_amount), 0) AS s FROM financial_posting p WHERE p.financial_account_id = a.id) x ON true)`;
const BAL = (id) => `(SELECT coalesce(sum(signed_amount), 0)::text FROM client_ledger WHERE cliente_id = '${id}')`;

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
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
CREATE FUNCTION pg_temp.must(p_name TEXT, p_got TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE 'OK:%' THEN RAISE NOTICE 'FAIL setup % :: %', p_name, left(p_got, 300); END IF;
END $f$;
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'lote5-0112-admin@test.local', 'ADMIN'),
  ('${OPER}',  'lote5-0112-oper@test.local',  'OPERATOR');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente Declarado'), ('${CLI2}', 'Otro Cliente');
INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type, reason)
VALUES ('${CLI}', 'ADJUSTMENT', 10000, '${DAY}', 'Cliente Declarado', 'test', 'deuda inicial sintética');
INSERT INTO management_period (periodo_fecha, status) VALUES ('2026-03-01', 'CLOSED') ON CONFLICT (periodo_fecha) DO UPDATE SET status = 'CLOSED';
INSERT INTO management_period (periodo_fecha, status) VALUES ('2026-11-01', 'OPEN') ON CONFLICT DO NOTHING;`);

function payment(k, pid, amount, payerId) {
  const at = `${DAY}T10:00:00.000-03:00`;
  const pl = { id: Number(pid), operation_type: 'money_transfer', payment_method_id: 'account_money', payment_type_id: 'account_money', status: 'approved', status_detail: 'accredited',
    currency_id: 'ARS', live_mode: true, collector_id: 100000001, payer: { id: payerId, first_name: null, last_name: null }, description: 'Transferencia', external_reference: null,
    date_created: at, date_approved: at, date_last_updated: at, transaction_amount: amount, transaction_details: { net_received_amount: amount }, fee_details: [], refunds: [],
    transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
  add(`SELECT pg_temp.must(${lit(`${k} delivery`)}, ${svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${pid}', NULL, 'T112', ${lit(JSON.stringify({ notification_id: `t112-${pid}` }))}::jsonb, true)::text`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} claim`)}, ${svc(`SELECT row_to_json(c)::text FROM mp_claim_deliveries(50, 120) c WHERE c.resource_id = '${pid}'`, `${k}_c`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} snapshot`)}, ${svc(`SELECT mp_ingest_api_snapshot(${P(RES(`${k}_c`, 'delivery_id'))}::uuid, ${P(RES(`${k}_c`, 'claim_token'))}::uuid, '${pid}', ${lit(JSON.stringify(pl))}::jsonb)::text`, `${k}_i`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} normalize`)}, ${svc(`SELECT mp_normalize_source(${P(RES(`${k}_i`, 'source_record_id'))}::uuid)::text`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} apply`)}, ${svc(`SELECT mp_apply_transition(${P(MV(pid))})::text`)});`);
}
const MV = (pid) => `(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${pid}' AND t.transition = 'APPROVAL')`;
const P1 = '971200000101'; const P2 = '971200000102'; const P3 = '971200000103'; const P4 = '971200000104';
payment('P1', P1, 4000, '800000101');
payment('P2', P2, 3000, '800000102');
payment('P3', P3, 2000, '800000103');
payment('P4', P4, 1500, '800000104');

add(`CREATE TEMP TABLE snap AS ${counts()};`);
add(`CREATE TEMP TABLE bal AS SELECT ${BALANCES} AS b;`);
const reg = (amount, key, date = DAY, cli = CLI, note = 'nota sintética') => `SELECT register_declared_collection('${cli}'::uuid, ${amount}, ${lit(date)}::date, ${lit(note)}, ${lit(key)})::text`;

// ── A. a declaration lowers the debt and moves no money ──
expect('A-1 ADMIN registers', A(reg(2500, 'k-a1'), 'a1'), 'OK:%"replayed": false%');
expect('A-2 the debt goes down', BAL(CLI), '7500.00');
expect('A-3 one ledger COLLECTION, tied to the declaration', `(SELECT l.movement_type || '|' || l.signed_amount || '|' || l.source_entity_type FROM client_ledger l JOIN declared_collection d ON d.client_ledger_id = l.id WHERE d.idempotency_key = 'k-a1')`, 'COLLECTION|-2500.00|declared_collection');
expect('A-4 no table of money, MP or collections changed', delta('snap'), 'none');
expect('A-5 every account balance identical, Mercado Pago included', `(SELECT (b = ${BALANCES})::text FROM bal)`, 'true');
expect('A-6 audited', `(SELECT count(*)::text FROM audit_events WHERE action = 'DECLARE_COLLECTION' AND entity_id = (SELECT id::text FROM declared_collection WHERE idempotency_key = 'k-a1') AND performed_by = '${ADMIN}')`, '1');
expect('A-7 a blank note is stored as no note', A(reg(10, 'k-a7', DAY, CLI, '   ')), 'OK:%');
expect('A-7b … no note', `(SELECT coalesce(note, '-') FROM declared_collection WHERE idempotency_key = 'k-a7')`, '-');

// ── B. idempotency ──
expect('B-1 the same request replays', A(reg(2500, 'k-a1')), 'OK:%"replayed": true%');
expect('B-2 … and writes nothing', BAL(CLI), '7490.00');
expect('B-3 the same key with other data is refused', A(reg(999, 'k-a1')), 'ERR:DUPLICATE_IDEMPOTENCY_KEY%');
expect('B-4 the rectification prefix is reserved', A(reg(10, 'DECLARED-RECTIFY:x')), 'ERR:INVALID_IDEMPOTENCY_KEY%');
expect('B-5 no key is refused', A(reg(10, '')), 'ERR:INVALID_IDEMPOTENCY_KEY%');
expect('B-6 invalid amount', A(reg(0, 'k-b6')), 'ERR:INVALID_AMOUNT%');
expect('B-7 three decimals', A(reg('1.001', 'k-b7')), 'ERR:INVALID_AMOUNT%');
expect('B-8 unknown client', A(reg(10, 'k-b8', DAY, 'cccccccc-0112-0000-0000-0000000000ff')), 'ERR:CLIENT_NOT_FOUND_OR_INACTIVE%');

// ── C. advances and credits ──
expect('C-1 more than the debt: allowed', A(reg(8000, 'k-c1')), 'OK:%');
expect('C-2 the client is left with a credit', BAL(CLI), '-510.00');
expect('C-3 a client without debt: an advance', A(reg(300, 'k-c3', DAY, CLI2)), 'OK:%');
expect('C-4 … credit', BAL(CLI2), '-300.00');

// ── D. annul ──
const rev = (key, res = 'a1', reason = 'error de carga') => `SELECT reverse_declared_collection(${P(`(SELECT id::text FROM declared_collection WHERE idempotency_key = '${key}')`)}::uuid, ${lit(reason)}, 'rev-${key}-${res}')::text`;
expect('D-1 a reason is required', A(rev('k-c1', 'x', '  ')), 'ERR:REASON_REQUIRED%');
expect('D-2 an OPERATOR cannot annul', O(`SELECT reverse_declared_collection('${'00000000-0000-0000-0000-000000000000'}'::uuid, 'x', 'k')::text`), 'ERR:%');
expect('D-3 annul', A(rev('k-c1')), 'OK:%"replayed": false%');
expect('D-4 the debt goes back up, at the original date', `(${BAL(CLI)} || '|' || (SELECT l.movement_type || '|' || l.signed_amount || '|' || l.effective_date || '|' || l.source_entity_type FROM client_ledger l JOIN declared_collection_reversal r ON r.client_reversal_ledger_id = l.id JOIN declared_collection d ON d.id = r.declared_collection_id WHERE d.idempotency_key = 'k-c1'))`, `7490.00|REVERSAL|8000.00|${DAY}|declared_collection_reversal`);
expect('D-5 the same request replays', A(rev('k-c1')), 'OK:%"replayed": true%');
expect('D-6 … nothing written', BAL(CLI), '7490.00');
expect('D-7 another request is refused', A(rev('k-c1', 'otro')), 'ERR:ALREADY_REVERSED%');
expect('D-8 audited with its reason', `(SELECT count(*) || '|' || min(reason) FROM audit_events WHERE action = 'ANNUL_DECLARED_COLLECTION' AND after_values ->> 'declared_collection_id' IN (SELECT d.id::text FROM declared_collection d WHERE d.cliente_id IN ('${CLI}', '${CLI2}')))`, '1|error de carga');
expect('D-9 no money', delta('snap'), 'none');

// ── E. rectify ──
const rect = (key, cli, amount, date, ikey) => `SELECT rectify_declared_collection(${P(`(SELECT id::text FROM declared_collection WHERE idempotency_key = '${key}')`)}::uuid, '${cli}'::uuid, ${amount}, ${lit(date)}::date, 'importe mal cargado', ${lit(ikey)})::text`;
expect('E-1 nothing to rectify: refused, and nothing stays', A(rect('k-a1', CLI, 2500, DAY, 'r0')), 'ERR:NOTHING_TO_RECTIFY%');
expect('E-2 … nothing stays', `(${BAL(CLI)} || '|' || (SELECT count(*) FROM declared_collection_reversal WHERE idempotency_key = 'r0'))`, '7490.00|0');
expect('E-3 rectify amount', A(rect('k-a1', CLI, 2000, DAY, 'r1'), 'e3'), 'OK:%"replayed": false%');
expect('E-4 net effect on the debt: +500', BAL(CLI), '7990.00');
expect('E-5 replay writes nothing', `(${A(rect('k-a1', CLI, 2000, DAY, 'r1'))} || ${BAL(CLI)})`, 'OK:%"replayed": true%7990.00');
expect('E-6 the original cannot be touched again', A(rect('k-a1', CLI, 1000, DAY, 'r2')), 'ERR:ALREADY_REVERSED%');
expect('E-7 a rectification may move it to another client', A(`SELECT rectify_declared_collection(${P(RES('e3', 'replacement_id'))}::uuid, '${CLI2}'::uuid, 2000, '${DAY}'::date, 'era otro cliente', 'r3')::text`), 'OK:%');
expect('E-8 … both balances follow', `(${BAL(CLI)} || '|' || ${BAL(CLI2)})`, '9990.00|-2300.00');
expect('E-9 audited', `(SELECT count(*)::text FROM audit_events WHERE action = 'RECTIFY_DECLARED_COLLECTION' AND after_values ->> 'declared_collection_id' IN (SELECT d.id::text FROM declared_collection d WHERE d.cliente_id IN ('${CLI}', '${CLI2}')))`, '2');
expect('E-10 no money', delta('snap'), 'none');
expect('E-11 a rectification into a closed period rolls everything back', A(rect('k-a7', CLI, 10, CLOSED, 'r4')), 'ERR:%');
expect('E-12 … the declaration stays alive', `(SELECT count(*)::text FROM declared_collection_reversal WHERE idempotency_key = 'r4')`, '0');

// ── F. closed periods ──
expect('F-1 a declaration in a closed period is refused', A(reg(10, 'k-f1', CLOSED)), 'ERR:%');
expect('F-2 … nothing stays', `(SELECT count(*)::text FROM declared_collection WHERE idempotency_key = 'k-f1')`, '0');
add(`DO $$ DECLARE v UUID; l BIGINT; BEGIN
  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type) VALUES ('${CLI}', 'COLLECTION', -5, '${CLOSED}', 'x', 'declared_collection') RETURNING id INTO l;
  INSERT INTO declared_collection (cliente_id, amount, effective_date, client_ledger_id, idempotency_key) VALUES ('${CLI}', 5, '${CLOSED}', l, 'k-closed');
END $$;`);
expect('F-3 annulling inside a closed period is refused', A(rev('k-closed')), 'ERR:%');
expect('F-4 … not reversed', `(SELECT count(*)::text FROM declared_collection_reversal r JOIN declared_collection d ON d.id = r.declared_collection_id WHERE d.idempotency_key = 'k-closed')`, '0');

// ── G. reading and access ──
const VIEW = (key, cols) => A(`SELECT ${cols} FROM fin_customer_collections WHERE row_id = 'D:' || ${P(`(SELECT id::text FROM declared_collection WHERE idempotency_key = '${key}')`)}`);
expect('G-1 a live declaration: origin, status, no operation, not a real account', VIEW('k-a7', `origin || '|' || status || '|' || account_type || '|' || coalesce(financial_operation_id::text, '-') || '|' || coalesce(source_id, '-') || '|' || counts_for_customer`), 'OK:DECLARED_MP|DECLARED|DECLARED|-|-|true');
expect('G-2 an annulled one: evidence, not counted', VIEW('k-c1', `status || '|' || reversal_kind || '|' || counts_for_customer || '|' || reversal_reason`), 'OK:ANNULLED|ANNUL|false|error de carga');
expect('G-3 a rectified one points nowhere; its replacement points to it', A(`SELECT count(*)::text FROM fin_customer_collections WHERE origin = 'DECLARED_MP' AND replacement_of IS NOT NULL AND cliente_id IN ('${CLI}', '${CLI2}')`), 'OK:2');
expect('G-4 the sum of the view is the ledger', A(`SELECT (SELECT sum(amount) FROM fin_customer_collections WHERE origin = 'DECLARED_MP' AND counts_for_customer AND cliente_id = '${CLI}')::text`), 'OK:15.00');
expect('G-5 an OPERATOR sees nothing', `(${O(`SELECT count(*)::text FROM declared_collection`)} || '|' || ${O(`SELECT count(*)::text FROM fin_customer_collections`)})`, 'OK:0|OK:0');
expect('G-6 an OPERATOR cannot declare', O(reg(10, 'k-g6')), 'ERR:FORBIDDEN%');
expect('G-7 anon cannot reach it', `(${as('anon', null, reg(10, 'k-g7'))} || '|' || ${as('anon', null, `SELECT count(*)::text FROM declared_collection`)})`, 'ERR:permission denied%|ERR:permission denied%');
expect('G-8 the internal cores are not callable', A(`SELECT declared_collection_new('${CLI}'::uuid, 1, '${DAY}'::date, NULL, 'x')::text`), 'ERR:permission denied%');
expect('G-9 evidence is immutable', `(pg_temp.err_of('UPDATE declared_collection SET amount = 1') || '|' || pg_temp.err_of('DELETE FROM declared_collection_reversal'))`, 'ERR:%|ERR:%');
expect('G-10 no direct write through the API', A(`INSERT INTO declared_collection (cliente_id, amount, effective_date, client_ledger_id, idempotency_key) VALUES ('${CLI}', 1, '${DAY}', 1, 'x') RETURNING id::text`), 'ERR:permission denied%');

// ── H. no double discount ──
add(`CREATE TEMP TABLE snap2 AS ${counts()};`);
const alloc = (pid, amount, key) => `SELECT mp_allocate_to_client(${P(MV(pid))}::bigint, '${CLI}'::uuid, ${amount}, '${DAY}'::date, ${lit(key)}, 'test')::text`;
expect('H-1 a new manual allocation is refused', A(alloc(P1, 1000, 'h1')), 'ERR:MP_CLIENT_ALLOCATION_DISABLED%');
expect('H-2 … nothing stays: no ledger, no allocation', delta('snap2'), 'none');
expect('H-3 Entradas sin vincular has no other door: same RPC, no date', A(`SELECT mp_allocate_to_client(${P(MV(P1))}::bigint, '${CLI}'::uuid, 1000, NULL, 'h3', 'test')::text`), 'ERR:MP_CLIENT_ALLOCATION_DISABLED%');
// a mapping made before 0112: the worker's route is not aborted
add(`ALTER TABLE mp_payer_client_map DISABLE TRIGGER trg_mp_payer_client_map_guard;`);
add(`SELECT pg_temp.must('H-4 setup: a mapping made before 0112', ${A(`SELECT mp_map_payer_to_client('800000103', '${CLI}'::uuid, 'Lote 5 test')::text`, 'h4')});`);
add(`SELECT pg_temp.must('H-4b setup: a deactivated one', ${A(`SELECT mp_map_payer_to_client('800000104', '${CLI}'::uuid, 'Lote 5 test')::text`, 'h4b')});`);
add(`ALTER TABLE mp_payer_client_map ENABLE TRIGGER trg_mp_payer_client_map_guard;`);
expect('H-5 an existing active mapping still allocates AUTO: the worker is not aborted', svc(`SELECT mp_auto_allocate(${P(MV(P3))})::text`), 'OK:%"allocated": true%');
add(`ALTER TABLE mp_client_allocation DISABLE TRIGGER trg_mp_client_allocation_manual_guard;`);
add(`SELECT pg_temp.must('H-6 setup: an allocation made before 0112', ${A(alloc(P2, 1000, 'h6'), 'h6')});`);
add(`ALTER TABLE mp_client_allocation ENABLE TRIGGER trg_mp_client_allocation_manual_guard;`);
expect('H-7 an existing allocation can still be reverted', A(`SELECT mp_reverse_client_allocation(${P(RES('h6', 'allocation_id'))}::uuid, 1000, 'h7', 'Lote 5 test')::text`), 'OK:%');
expect('H-8 the historical correction key still passes the guard for that client', `(SELECT pg_temp.err_of(format($q$INSERT INTO mp_client_allocation (mp_financial_movement_id, cliente_id, amount, origin, mode, effective_date, idempotency_key, reason, client_ledger_id) VALUES (%s, %L, 1, 'ALLOCATION', 'MANUAL', %L, 'COLLECTION-CORRECTION-MP:00000000-0000-0000-0000-000000000000', 'x', NULL)$q$, ${MV(P2)}, '${CLI}', '${DAY}')))`, 'ERR:MP_CLIENT_ALLOCATION_DISABLED%');

// ── J. no new payer → client association ──
add(`CREATE TEMP TABLE map_before AS SELECT count(*) AS n FROM mp_payer_client_map;`);
const MAP = (key) => `${RES(key, 'mapping_id')}`;
expect('J-1 a new mapping through the RPC is refused', A(`SELECT mp_map_payer_to_client('800000199', '${CLI}'::uuid, 'Lote 5 test')::text`), 'ERR:MP_PAYER_MAP_DISABLED%');
expect('J-2 a new mapping by SQL, even as the owner, is refused', `pg_temp.err_of($q$INSERT INTO mp_payer_client_map (mp_payer_id, cliente_id) VALUES ('800000198', '${CLI}')$q$)`, 'ERR:MP_PAYER_MAP_DISABLED%');
expect('J-3 an active mapping cannot point to another client', `pg_temp.err_of('UPDATE mp_payer_client_map SET cliente_id = ''${CLI2}'' WHERE id = ''' || ${MAP('h4')} || '''')`, 'ERR:MP_PAYER_MAP_DISABLED%');
expect('J-4 an active mapping cannot change its payer', `pg_temp.err_of('UPDATE mp_payer_client_map SET mp_payer_id = ''800000197'' WHERE id = ''' || ${MAP('h4')} || '''')`, 'ERR:MP_PAYER_MAP_DISABLED%');
expect('J-5 deactivating still works', A(`SELECT mp_unmap_payer(${P(MAP('h4b'))}::uuid, 'Lote 5 test')::text`), 'OK:%"activo": false%');
expect('J-6 a deactivated mapping cannot be reactivated', `pg_temp.err_of('UPDATE mp_payer_client_map SET activo = true, deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL WHERE id = ''' || ${MAP('h4b')} || '''')`, 'ERR:MP_PAYER_MAP_DISABLED%');
expect('J-7 nor recreated through the RPC', A(`SELECT mp_map_payer_to_client('800000104', '${CLI}'::uuid, 'Lote 5 test')::text`), 'ERR:MP_PAYER_MAP_DISABLED%');
expect('J-8 history stays: no row lost or added', `(SELECT (count(*) = (SELECT n FROM map_before))::text FROM mp_payer_client_map)`, 'true');
expect('J-9 a payer whose mapping is gone: mp_auto_allocate finds no evidence and does not discount', `(${svc(`SELECT mp_auto_allocate(${P(MV(P4))})::text`)} || '|' || (SELECT count(*) FROM mp_client_allocation WHERE mp_financial_movement_id = ${MV(P4)}))`, 'OK:%"reason": "NO_EVIDENCE"%|0');
expect('J-10 no active association can be created: only the pre-0112 active one remains', `(SELECT count(*)::text FROM mp_payer_client_map WHERE activo AND mp_payer_id LIKE '80000%')`, '1');

// ── I. cash and bank unchanged ──
const CASHACC = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo ORDER BY nombre LIMIT 1)`;
add(`CREATE TEMP TABLE snap3 AS ${counts()};`);
expect('I-1 a cash collection keeps its operation and posting', A(`SELECT register_collection('${CLI}'::uuid, 400, 'CASH', 'r-cash-1', '${DAY}'::date, ${P(CASHACC)}::uuid, NULL, 'efectivo')::text`, 'i1'), 'OK:%');
expect('I-2 … collections, operation and posting', delta('snap3'), 'collections=1,financial_operation=1,financial_posting=1');
expect('I-3 a cash collection can still be annulled, with money', A(`SELECT reverse_collection(${P(RES('i1', 'collection_id'))}::uuid, 'error', 'i3')::text`), 'OK:%');
expect('I-4 … compensating operation', delta('snap3'), 'collection_reversal=1,collections=1,financial_operation=2,financial_posting=2');

add('ROLLBACK;');

// ── run ──────────────────────────────────────────────────────────────────────
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
