/**
 * Verification profile ADR025_POST_0108 — the exact database state after target migrations 0001…0108
 * (0108, Lote 1E: anular / rectificar cobros en efectivo y bancos — collection_reversal, reverse_collection,
 * rectify_collection, collection_reversal_core, the bank-reconciliation guard on fin_statement_match, and
 * fin_customer_collections with five appended columns).
 *
 * The whole 0001…0107 state is verified by ADR025_POST_0107. Two of its expectations change with 0108 and are translated back
 * before evaluating it (and checked here exactly instead): the four new SECURITY DEFINER identities (D) and the
 * fin_customer_collections definition (W, 0092 hash). A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0107.mjs';

export const NAME = 'ADR025_POST_0108';
export const THROUGH = '0108';
const MIGRATION = '0108_collection_reversal.sql';
const VIEW_0092 = '53e3dd48b50863743cc343f13936d749';
const VIEW_0108 = 'aa5193fcd40e34176ecf49350296671b';
const VIEW_COLUMNS = 'row_id,business_date,created_at,cliente_id,client_name,amount,account_name,account_type,payment_method,notes,'
  + 'financial_operation_id,source_id,origin,status,correction_id,correction_role,counts_for_customer,'
  + 'reversal_kind,reversal_reason,reversal_at,replacement_of,sales_session_id';
// identity | SECURITY DEFINER | owner | config | EXECUTE anon / authenticated / service_role | md5(body)
const FUNCTIONS = [
  'collection_reversal_core(uuid,text,text,text)|true|postgres|search_path=public|falsefalsefalse|1ceea2b315c4a16fce75cff99ef4b9f5',
  'fin_statement_match_collection_reversal_guard()|true|postgres|search_path=public, pg_temp|falsefalsefalse|164050ab42c283cf6a3a9431fe90c6f3',
  'rectify_collection(uuid,uuid,numeric,uuid,date,text,text)|true|postgres|search_path=public|falsetruefalse|6d5dbbf0c826c51491046bf80dba6fc1',
  'reverse_collection(uuid,text,text)|true|postgres|search_path=public|falsetruefalse|8fd9f23588863bcc80445d3f81393c7a',
];
const NEW_DEFINERS = FUNCTIONS.map((f) => f.split('|')[0]);
const TRIGGERS = [
  'trg_collection_reversal_immutable:collection_reversal:O:27:fin_evidence_immutable_guard',
  'trg_fin_statement_match_collection_reversal:fin_statement_match:O:7:fin_statement_match_collection_reversal_guard',
];
const CONSTRAINTS = 'chk_cr_kind_replacement:c,chk_cr_not_self:c,collection_reversal_amount_check:c,collection_reversal_client_reversal_ledger_id_fkey:f,'
  + 'collection_reversal_client_reversal_ledger_id_key:u,collection_reversal_collection_id_fkey:f,collection_reversal_collection_id_key:u,'
  + 'collection_reversal_created_by_fkey:f,collection_reversal_idempotency_key_check:c,collection_reversal_idempotency_key_key:u,'
  + 'collection_reversal_kind_check:c,collection_reversal_pkey:p,collection_reversal_reason_check:c,collection_reversal_replacement_collection_id_fkey:f,'
  + 'collection_reversal_replacement_collection_id_key:u,collection_reversal_reversal_operation_id_fkey:f,collection_reversal_reversal_operation_id_key:u';

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');
function innerJson(sql) {
  const m = /^SELECT ([\s\S]*)::text;$/.exec(sql.trim());
  if (!m) throw new Error(`profile ${NAME}: unexpected query shape of the previous profile`);
  return m[1];
}
/** The first nested object (depth-first) that has `key`. */
function find(o, key) {
  if (!o || typeof o !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(o, key)) return o;
  for (const v of Object.values(o)) { const r = find(v, key); if (r) return r; }
  return null;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0108', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0108'),
    'functions', (SELECT coalesce(json_agg(r ORDER BY r), '[]') FROM (
       SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|'
              || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
              || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS r
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('collection_reversal_core', 'reverse_collection', 'rectify_collection', 'fin_statement_match_collection_reversal_guard')) f),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (
       SELECT tgname || ':' || tgrelid::regclass || ':' || tgenabled::text || ':' || tgtype || ':' || tgfoid::regproc AS t
         FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_collection_reversal_immutable', 'trg_fin_statement_match_collection_reversal')) t),
    'table', (SELECT relrowsecurity || ':' || (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies WHERE tablename = 'collection_reversal') || ':'
               || has_table_privilege('authenticated', 'public.collection_reversal', 'SELECT') || has_table_privilege('authenticated', 'public.collection_reversal', 'INSERT,UPDATE,DELETE')
               || has_table_privilege('anon', 'public.collection_reversal', 'SELECT') || has_table_privilege('service_role', 'public.collection_reversal', 'SELECT')
              FROM pg_class WHERE oid = to_regclass('public.collection_reversal')),
    'constraints', (SELECT string_agg(conname || ':' || contype::text, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.collection_reversal')),
    'reversals', (SELECT count(*) FROM collection_reversal),
    'view', md5(pg_get_viewdef('public.fin_customer_collections'::regclass)),
    'view_columns', (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fin_customer_collections'),
    'view_acl', (SELECT (reloptions @> ARRAY['security_invoker=true']) || ':' || relacl::text FROM pg_class WHERE oid = 'public.fin_customer_collections'::regclass))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0108 ?? {};
  // the 0107 state as POST_0107 knows it: without the four 0108 definers, the 0092 view hash
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const cc = find(inner, 'cc0092')?.cc0092;
  if (cc && cc.view === VIEW_0108) cc.view = VIEW_0092;
  // POST_0106 aggregates wa_definers with json_agg(… ORDER BY 1) — a constant, so the order follows physical row order: the same
  // set may come back in another order (it does on a fresh rebuild). Compare it as the set it is.
  const wa = inner.prev?.a0106;   // inner = POST_0107's result; its prev = POST_0106's, whose own block is a0106
  if (wa && Array.isArray(wa.wa_definers)) wa.wa_definers = [...wa.wa_definers].sort();
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0108 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0108 SECURITY DEFINER: exactly +4 (reverse_collection, rectify_collection, collection_reversal_core, reconciliation guard)',
    NEW_DEFINERS.every((d) => realDefiners.includes(d)), realDefiners.length);
  check('0108 functions: DEFINER, owner postgres, search_path, EXECUTE only reverse / rectify for authenticated, bodies as in 0108',
    JSON.stringify(a.functions) === JSON.stringify(FUNCTIONS), JSON.stringify(a.functions));
  check('0108 triggers: collection_reversal immutable; BEFORE INSERT guard on fin_statement_match, enabled',
    JSON.stringify(a.triggers) === JSON.stringify(TRIGGERS), JSON.stringify(a.triggers));
  check('0108 collection_reversal: RLS, ADMIN SELECT policy only, SELECT for authenticated, no writes, nothing for anon / service_role',
    a.table === 'true:collection_reversal_admin_select:SELECT:truefalsefalsefalse', String(a.table));
  check('0108 collection_reversal constraints (one reversal per collection, unique key / operation / ledger / replacement)', a.constraints === CONSTRAINTS, String(a.constraints));
  check('0108 fin_customer_collections: definition as in 0108, 17 + 5 appended columns, security_invoker, SELECT for authenticated only',
    a.view === VIEW_0108 && a.view_columns === VIEW_COLUMNS && a.view_acl === 'true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}',
    `${a.view} · ${a.view_acl}`);
  if (ctx.deploymentCheck) check('0108 deployment: no reversal yet right after the migration (data untouched)', Number(a.reversals) === 0, String(a.reversals));
  return out;
}
