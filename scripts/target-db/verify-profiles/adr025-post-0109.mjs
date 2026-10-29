/**
 * Verification profile ADR025_POST_0109 — the exact database state after target migrations 0001…0109
 * (0109, Lote 2A: perfiles.nombre / apellido, set_profile_name (ADMIN, audited), fin_customer_collections + registered_by /
 * reversal_by). Privileges, RLS, policies and authentication of perfiles are unchanged — checked here exactly.
 *
 * The whole 0001…0108 state is verified by ADR025_POST_0108. Its expectations that change with 0109 are translated back before
 * evaluating it (and checked here exactly instead): the new SECURITY DEFINER identity (D), the fin_customer_collections
 * definition and columns (W of 0092 and the 0108 view check). A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0108.mjs';

export const NAME = 'ADR025_POST_0109';
export const THROUGH = '0109';
const MIGRATION = '0109_profile_names.sql';
const NEW_DEFINER = 'set_profile_name(uuid,text,text)';
const FUNCTION = 'set_profile_name(uuid,text,text)|true|postgres|search_path=public|falsetruefalse|5f24fd97482872b4ce5002e364eec9c5';
const VIEW_0092 = '53e3dd48b50863743cc343f13936d749';
const VIEW_0108 = 'aa5193fcd40e34176ecf49350296671b';
const VIEW_0109 = 'd4743fdfab73680886276cf8eab2fb94';
const COLS_0108 = 'row_id,business_date,created_at,cliente_id,client_name,amount,account_name,account_type,payment_method,notes,'
  + 'financial_operation_id,source_id,origin,status,correction_id,correction_role,counts_for_customer,'
  + 'reversal_kind,reversal_reason,reversal_at,replacement_of,sales_session_id';
const COLS_0109 = `${COLS_0108},registered_by,reversal_by`;
const PERFILES_COLUMNS = 'id:uuid::NO,email:character varying:255:NO,rol_type:USER-DEFINED::NO,activo:boolean::NO,'
  + 'created_at:timestamp with time zone::NO,updated_at:timestamp with time zone::NO,nombre:character varying:80:YES,apellido:character varying:80:YES';
const PERFILES_CHECKS = 'chk_perfiles_apellido:7fdd55fad82f926736ec35e6d2464e06,chk_perfiles_nombre:fe36cf751f3320c60a3b3aac5b60cb2e';
// unchanged since 0007 / 0013: RLS on, SELECT for authenticated only, the four policies
const PERFILES_ACL = 'truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const PERFILES_POLICIES = 'perfiles_admin_insert:INSERT:public,perfiles_admin_select:SELECT:public,perfiles_admin_update:UPDATE:public,perfiles_self_select:SELECT:public';

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');
function innerJson(sql) {
  const m = /^SELECT ([\s\S]*)::text;$/.exec(sql.trim());
  if (!m) throw new Error(`profile ${NAME}: unexpected query shape of the previous profile`);
  return m[1];
}
function find(o, key) {
  if (!o || typeof o !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(o, key)) return o;
  for (const v of Object.values(o)) { const r = find(v, key); if (r) return r; }
  return null;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0109', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0109'),
    'function', (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|'
                   || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                   || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', ''))
                  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_profile_name'),
    'overloads', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'set_profile_name'),
    'columns', (SELECT string_agg(column_name || ':' || data_type || ':' || coalesce(character_maximum_length::text, '') || ':' || is_nullable, ',' ORDER BY ordinal_position)
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfiles'),
    'checks', (SELECT string_agg(conname || ':' || md5(pg_get_constraintdef(oid)), ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.perfiles'::regclass AND contype = 'c'),
    'acl', (SELECT relrowsecurity::text || relforcerowsecurity::text || ':' || coalesce(relacl::text, 'NULL') FROM pg_class WHERE oid = 'public.perfiles'::regclass),
    'policies', (SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'perfiles'),
    'column_writes', (SELECT count(*) FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'perfiles'
                        AND grantee IN ('anon', 'authenticated', 'service_role') AND privilege_type <> 'SELECT'),
    'triggers', (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.perfiles'::regclass AND NOT tgisinternal),
    'named', (SELECT count(*) FROM perfiles WHERE nombre IS NOT NULL OR apellido IS NOT NULL),
    'view', md5(pg_get_viewdef('public.fin_customer_collections'::regclass)),
    'view_columns', (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fin_customer_collections'),
    'view_acl', (SELECT (reloptions @> ARRAY['security_invoker=true']) || ':' || relacl::text FROM pg_class WHERE oid = 'public.fin_customer_collections'::regclass))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0109 ?? {};
  // the 0108 state as POST_0108 knows it: without the 0109 definer, the 0108 view (definition + 22 columns)
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => d !== NEW_DEFINER);
  if (inner.a0108 && inner.a0108.view === VIEW_0109) { inner.a0108.view = VIEW_0108; if (inner.a0108.view_columns === COLS_0109) inner.a0108.view_columns = COLS_0108; }
  const cc = find(inner, 'cc0092')?.cc0092;
  if (cc && cc.view === VIEW_0109) cc.view = VIEW_0092;
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0109 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0109 SECURITY DEFINER: exactly +1 (set_profile_name)', realDefiners.includes(NEW_DEFINER), realDefiners.length);
  check('0109 set_profile_name: one overload, DEFINER, owner postgres, search_path, EXECUTE authenticated only, body as in 0109',
    a.function === FUNCTION && Number(a.overloads) === 1, String(a.function));
  check('0109 perfiles: nombre / apellido VARCHAR(80) optional, appended; other columns unchanged', a.columns === PERFILES_COLUMNS, String(a.columns));
  check('0109 perfiles: the two CHECK constraints (trimmed, non-empty, no control characters)', a.checks === PERFILES_CHECKS, String(a.checks));
  check('perfiles privileges / RLS / policies unchanged (SELECT for authenticated only, no column write, no trigger)',
    a.acl === PERFILES_ACL && a.policies === PERFILES_POLICIES && Number(a.column_writes) === 0 && Number(a.triggers) === 0,
    `${a.acl} · ${a.policies} · writes ${a.column_writes} · triggers ${a.triggers}`);
  check('0109 fin_customer_collections: definition as in 0109, 22 + 2 appended columns, security_invoker, SELECT for authenticated only',
    a.view === VIEW_0109 && a.view_columns === COLS_0109 && a.view_acl === 'true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}', `${a.view} · ${a.view_acl}`);
  if (ctx.deploymentCheck) check('0109 deployment: no name loaded right after the migration (nothing filled automatically)', Number(a.named) === 0, String(a.named));
  return out;
}
