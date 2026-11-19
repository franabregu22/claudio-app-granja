#!/usr/bin/env node
/**
 * 0134 — WhatsApp short conversation memory: wa_note_reply (the bot's reply of a message, once, gateway only, nothing financial)
 * and wa_context.history (the sender's previous messages of the last 24 h with the bot's reply). LOCAL TEST DATABASE ONLY; one
 * transaction, rolled back. If 0134 is not yet in the ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/wa_memoria_0134.test.mjs
 */
import { spawnSync } from 'node:child_process';
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

const FILE = '0134_wa_memoria_conversacion.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0134-0000-0000-00000000000a';
const ADMIN2 = 'aaaaaaaa-0134-0000-0000-00000000000b';
const GW = 'aaaaaaaa-0134-0000-0000-0000000000ff';
const PHONE = '+5491100000134';
const PHONE2 = '+5491100000135';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)})`;
const GWC = (call) => as('authenticated', GW, call);
const MSG = (k) => `(SELECT id FROM msg WHERE k = ${lit(k)})`;

add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0134')) AS has_0134 \\gset
\\if :has_0134
\\else
\\i /tmp/${FILE}
\\endif
CREATE TEMP TABLE msg (k TEXT PRIMARY KEY, id BIGINT);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; m TEXT; ok BOOLEAN := false; e TEXT; val TEXT;
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
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT;
    RESET ROLE;
  END;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || m END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like;
  ELSE RAISE NOTICE 'PASS %', p_name; END IF;
END $f$;
-- an accepted message of a sender: a text or a button, received p_ago ago
CREATE FUNCTION pg_temp.msg(p_key TEXT, p_phone TEXT, p_perfil UUID, p_text TEXT, p_button TEXT, p_ago INTERVAL) RETURNS BIGINT LANGUAGE plpgsql AS $f$
DECLARE v BIGINT;
BEGIN
  INSERT INTO wa.inbound_message (wamid, phone_e164, sender_perfil_id, meta_ts, received_at, kind, text_body, button_payload, raw_sha256, outcome)
  VALUES ('T0134-' || p_key, p_phone, p_perfil, now() - p_ago, now() - p_ago, CASE WHEN p_button IS NULL THEN 'text' ELSE 'interactive' END,
          p_text, p_button, md5(p_key), 'ACCEPTED') RETURNING id INTO v;
  INSERT INTO msg VALUES (p_key, v);
  RETURN v;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'wa-0134-admin@test.local', 'ADMIN'), ('${ADMIN2}', 'wa-0134-admin2@test.local', 'ADMIN');
INSERT INTO wa.config (singleton, gateway_user_id, enabled) VALUES (true, '${GW}', true)
  ON CONFLICT (singleton) DO UPDATE SET gateway_user_id = EXCLUDED.gateway_user_id, enabled = true;
INSERT INTO wa.sender (phone_e164, perfil_id) VALUES ('${PHONE}', '${ADMIN}'), ('${PHONE2}', '${ADMIN2}');
SELECT pg_temp.msg('old',   '${PHONE}',  '${ADMIN}',  'mensaje de ayer', NULL, interval '25 hours');
SELECT pg_temp.msg('m1',    '${PHONE}',  '${ADMIN}',  'gasté 18 mil', NULL, interval '3 minutes');
SELECT pg_temp.msg('other', '${PHONE2}', '${ADMIN2}', 'otro remitente', NULL, interval '2 minutes');
SELECT pg_temp.msg('b1',    '${PHONE}',  '${ADMIN}',  NULL, 'METHOD:00000000-0000-4000-8000-000000000001:1:CASH', interval '2 minutes');
SELECT pg_temp.msg('m2',    '${PHONE}',  '${ADMIN}',  'combustible', NULL, interval '1 minute');
SELECT pg_temp.msg('stale', '${PHONE}',  '${ADMIN}',  'viejo', NULL, interval '2 hours');
UPDATE wa.inbound_message SET outcome = 'STALE' WHERE id = (SELECT id FROM msg WHERE k = 'stale');
CREATE TEMP TABLE before_counts AS
  SELECT (SELECT count(*) FROM wa.draft) AS drafts, (SELECT count(*) FROM wa.confirmation) AS confs, (SELECT count(*) FROM financial_operation) AS ops,
         (SELECT count(*) FROM financial_posting) AS posts, (SELECT count(*) FROM purchases) AS purch, (SELECT count(*) FROM wa.audit_event) AS audits;`);

// ── A. wa_note_reply ─────────────────────────────────────────────────────────
expect('A-1 the gateway stores the bot reply of an accepted fresh message', GWC(`SELECT wa_note_reply({{${MSG('m1')}}}::bigint, '  ¿Qué compraste o pagaste?  ')::text`), 'OK:{"ok": true}');
expect('A-2 … trimmed, with its time', `(SELECT bot_reply || '|' || (bot_reply_at IS NOT NULL) FROM wa.inbound_message WHERE id = ${MSG('m1')})`, '¿Qué compraste o pagaste?|true');
expect('A-3 once: a retry returns replay and never overwrites', GWC(`SELECT wa_note_reply({{${MSG('m1')}}}::bigint, 'otra cosa')::text`), 'OK:%"replay": true%');
expect('A-3b … the first text stays', `(SELECT bot_reply FROM wa.inbound_message WHERE id = ${MSG('m1')})`, '¿Qué compraste o pagaste?');
expect('A-4 it is not an action: the message can still drive one (used_action stays NULL)', `(SELECT coalesce(used_action, 'none') FROM wa.inbound_message WHERE id = ${MSG('m1')})`, 'none');
expect('A-5 only the gateway user (an ADMIN of the ERP is refused)', as('authenticated', ADMIN, `SELECT wa_note_reply({{${MSG('m2')}}}::bigint, 'x')::text`), 'ERR:FORBIDDEN%');
expect('A-6 anon cannot even call it', as('anon', null, `SELECT wa_note_reply({{${MSG('m2')}}}::bigint, 'x')::text`), 'ERR:permission denied%');
expect('A-7 a non-accepted message is refused', GWC(`SELECT wa_note_reply({{${MSG('stale')}}}::bigint, 'x')::text`), 'ERR:WA_MESSAGE_NOT_ACCEPTED%');
expect('A-8 a message older than one hour is refused', GWC(`SELECT wa_note_reply({{${MSG('old')}}}::bigint, 'x')::text`), 'ERR:WA_MESSAGE_TOO_OLD%');
expect('A-9 an empty reply is refused', GWC(`SELECT wa_note_reply({{${MSG('m2')}}}::bigint, '   ')::text`), 'ERR:WA_INVALID_PAYLOAD%');
expect('A-10 a long reply is accepted …', GWC(`SELECT wa_note_reply({{${MSG('b1')}}}::bigint, repeat('a', 1500))::text`), 'OK:{"ok": true}');
expect('A-10b … and cut to 1000 characters', `(SELECT length(bot_reply) FROM wa.inbound_message WHERE id = ${MSG('b1')})`, '1000');
expect('A-11 a sender no longer authorized: refused', `(SELECT ${as('postgres', null, `UPDATE wa.sender SET activo = false WHERE phone_e164 = '${PHONE2}' RETURNING 'x'`)} || '|' || ${GWC(`SELECT wa_note_reply({{${MSG('other')}}}::bigint, 'x')::text`)})`, 'OK:x|ERR:WA_OWNER_NOT_AUTHORIZED%');
add(`UPDATE wa.sender SET activo = true WHERE phone_e164 = '${PHONE2}';`);
expect('A-12 the column CHECK holds (no empty / oversized text written directly)', `pg_temp.run_as('postgres', NULL, $q$UPDATE wa.inbound_message SET bot_reply = '' WHERE id = (SELECT id FROM msg WHERE k = 'm2') RETURNING 'x'$q$)`, 'ERR:%check%');

// ── B. wa_context.history ────────────────────────────────────────────────────
const CTX = (k) => GWC(`SELECT (wa_context({{${MSG(k)}}}::bigint) -> 'history')::text`);
expect('B-1 the previous messages of THIS sender, oldest first, with the bot reply; the button by its kind and method only',
  CTX('m2'), 'OK:[{%"bot": "¿Qué compraste o pagaste?"%"text": "gasté 18 mil"%}, {%"button": "METHOD"%"button_method": "CASH"%}]');
expect('B-2 … never the button ids, another sender, a non-accepted or a >24 h message, nor the message itself', `(SELECT (h !~ '[0-9a-f]{8}-[0-9a-f]{4}-' AND h NOT LIKE '%otro remitente%' AND h NOT LIKE '%viejo%' AND h NOT LIKE '%mensaje de ayer%' AND h NOT LIKE '%"combustible"%')::text
   FROM (SELECT ${CTX('m2')} AS h) x)`, 'true');
expect('B-3 the first message has an empty history', CTX('m1'), 'OK:[]');
expect('B-4 the rest of the context is unchanged (ok, open, waiting, catalog)', GWC(`SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(wa_context({{${MSG('m2')}}}::bigint)) k)`),
  'OK:catalog,history,ok,open,waiting');
expect('B-5 at most 8 previous messages', `(SELECT ${as('postgres', null, `SELECT count(pg_temp.msg('h' || g, '${PHONE}', '${ADMIN}', 'h' || g, NULL, interval '30 seconds'))::text FROM generate_series(1, 12) g`)} || '|' ||
  ${GWC(`SELECT jsonb_array_length(wa_context({{(SELECT max(id) FROM msg)}}::bigint) -> 'history')::text`)})`, 'OK:12|OK:8');
expect('B-6 wa_context still refuses anyone but the gateway', as('authenticated', ADMIN, `SELECT wa_context({{${MSG('m2')}}}::bigint)::text`), 'ERR:FORBIDDEN%');

// ── C. nothing financial ─────────────────────────────────────────────────────
expect('C-1 nothing financial: no draft, confirmation, operation, posting, purchase or wa audit event written', `(SELECT (b.drafts = (SELECT count(*) FROM wa.draft) AND b.confs = (SELECT count(*) FROM wa.confirmation) AND b.ops = (SELECT count(*) FROM financial_operation)
   AND b.posts = (SELECT count(*) FROM financial_posting) AND b.purch = (SELECT count(*) FROM purchases) AND b.audits = (SELECT count(*) FROM wa.audit_event))::text FROM before_counts b)`, 'true');
expect('C-2 privileges: SECURITY DEFINER, owner postgres, EXECUTE only for authenticated', `(SELECT p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|' ||
   has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
   FROM pg_proc p WHERE p.oid = 'public.wa_note_reply(bigint,text)'::regprocedure)`, 'true|postgres|truefalsefalse');

add('ROLLBACK;');

const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const containers = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean);
const container = containers.find((c) => (dockerRun(['port', c, '5432/tcp']).stdout || '').includes(`:${target.port}`));
if (!container) { console.error(`  no running supabase_db container mapped to the guarded port ${target.port}. Run \`supabase start\`.`); process.exit(1); }
console.log(`  container: ${container}`);
const cp = dockerRun(['exec', '-i', container, 'sh', '-c', `cat > /tmp/${FILE}`], readFileSync(MIGRATION, 'utf8'));
if (cp.status !== 0) { console.error('  could not copy the migration into the container'); process.exit(1); }
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n');
let pass = 0; let fail = 0;
for (const l of lines) {
  const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
  if (m) { if (m[1] === 'PASS') { pass += 1; console.log(`    OK   ${m[2]}`); } else { fail += 1; console.log(`    MAL  ${m[2]}`); } }
}
if (r.status !== 0) { fail += 1; console.log(`    MAL  psql aborted: ${(lines.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300)}`); }
console.log(`\n  ${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
