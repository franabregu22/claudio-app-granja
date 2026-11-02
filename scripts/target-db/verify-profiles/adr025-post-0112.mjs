/**
 * Verification profile ADR025_POST_0112 — the exact database state after target migrations 0001…0112
 * (0112, Lote 5, ADR-027: declared Mercado Pago collections — declared_collection / declared_collection_reversal, register / reverse /
 * rectify_declared_collection and their two internal cores, fin_customer_collections with the declarations appended,
 * trg_mp_client_allocation_manual_guard and trg_mp_payer_client_map_guard).
 *
 * The whole 0001…0111 state is verified by ADR025_POST_0111. What 0112 changes is translated back before evaluating it (the new
 * SECURITY DEFINER identities in D, the grants of the new tables in K, the fin_customer_collections definition) and checked here
 * exactly instead. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0111.mjs';

export const NAME = 'ADR025_POST_0112';
export const THROUGH = '0112';
const MIGRATION = '0112_declared_collections.sql';
const NEW_DEFINERS = ['declared_collection_new(uuid,numeric,date,text,text)', 'declared_collection_undo(uuid,text,text,text)', 'rectify_declared_collection(uuid,uuid,numeric,date,text,text)',
  'register_declared_collection(uuid,numeric,date,text,text)', 'reverse_declared_collection(uuid,text,text)'];
const NEW_RELATIONS = ['declared_collection', 'declared_collection_reversal'];
const FN_NAMES = ['declared_collection_new', 'declared_collection_undo', 'client_allocation_manual_guard', 'payer_client_map_guard', 'rectify_declared_collection', 'register_declared_collection', 'reverse_declared_collection'];
// before 0112 → after 0112
const VIEW = ['d4743fdfab73680886276cf8eab2fb94', 'e6b9b39aeda3857994cc1c9886d5bb39'];
const FUNCTIONS = [
  'client_allocation_manual_guard()|false|postgres|search_path=public, pg_temp|falsefalsefalse|5462e78d34e4cd131bc8c0ea733a5077',
  'declared_collection_new(uuid,numeric,date,text,text)|true|postgres|search_path=public|falsefalsefalse|3c480d5539111ccc42e048c71a35acfa',
  'declared_collection_undo(uuid,text,text,text)|true|postgres|search_path=public|falsefalsefalse|5dc2c9012189dcd327de098fc03eb56d',
  'payer_client_map_guard()|false|postgres|search_path=public, pg_temp|falsefalsefalse|c09119969602aa49090365f3d3dae90e',
  'rectify_declared_collection(uuid,uuid,numeric,date,text,text)|true|postgres|search_path=public|falsetruefalse|2d13f325f33368221cd6ab7c4c55f25a',
  'register_declared_collection(uuid,numeric,date,text,text)|true|postgres|search_path=public|falsetruefalse|539f54abb019c2043e41a25f48f4d6be',
  'reverse_declared_collection(uuid,text,text)|true|postgres|search_path=public|falsetruefalse|6aa1ea5fae5c19d9ab2375ac16524331'];
const TABLES = [
  'declared_collection:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}',
  'declared_collection_reversal:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}'];
const POLICIES = [
  'declared_collection:declared_collection_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5',
  'declared_collection_reversal:declared_collection_reversal_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5'];
const TRIGGERS = [
  'declared_collection:trg_declared_collection_immutable:fin_evidence_immutable_guard():O',
  'declared_collection_reversal:trg_declared_collection_reversal_immutable:fin_evidence_immutable_guard():O',
  'mp_client_allocation:trg_mp_client_allocation_manual_guard:client_allocation_manual_guard():O',
  'mp_payer_client_map:trg_mp_payer_client_map_guard:payer_client_map_guard():O'];
const COLUMNS = [
  'declared_collection:id,cliente_id,amount,effective_date,note,client_ledger_id,idempotency_key,created_by,created_at',
  'declared_collection_reversal:id,declared_collection_id,kind,amount,client_reversal_ledger_id,replacement_id,idempotency_key,reason,created_by,created_at'];

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
function each(o, fn) {   // every object node (depth first)
  if (!o || typeof o !== 'object') return;
  fn(o);
  for (const v of Object.values(o)) each(v, fn);
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0112', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0112'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${FN_NAMES.map((n) => `'${n}'`).join(', ')})) q),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN ('declared_collection', 'declared_collection_reversal')),
    'policies', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || md5(coalesce(qual, '')) AS t
                   FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('declared_collection', 'declared_collection_reversal')) q),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tgrelid::regclass::text || ':' || tgname || ':' || tgfoid::regprocedure::text || ':' || tgenabled::text AS t FROM pg_trigger
                   WHERE NOT tgisinternal AND tgrelid IN ('public.declared_collection'::regclass, 'public.declared_collection_reversal'::regclass, 'public.mp_client_allocation'::regclass, 'public.mp_payer_client_map'::regclass)
                     AND tgname IN ('trg_declared_collection_immutable', 'trg_declared_collection_reversal_immutable', 'trg_mp_client_allocation_manual_guard', 'trg_mp_payer_client_map_guard')) q),
    'view', md5(pg_get_viewdef('public.fin_customer_collections'::regclass)),
    'columns', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT table_name || ':' || string_agg(column_name, ',' ORDER BY ordinal_position) AS t
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('declared_collection', 'declared_collection_reversal') GROUP BY table_name) q),
    'declared', (SELECT count(*) FROM declared_collection), 'reversals', (SELECT count(*) FROM declared_collection_reversal),
    'audits', (SELECT count(*) FROM audit_events WHERE action IN ('DECLARE_COLLECTION', 'ANNUL_DECLARED_COLLECTION', 'RECTIFY_DECLARED_COLLECTION')),
    'ledger_links', (SELECT count(*) FROM client_ledger WHERE source_entity_type IN ('declared_collection', 'declared_collection_reversal')))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0112 ?? {};
  // the 0111 state as POST_0111 knows it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const tg = find(inner, 'table_grants');
  if (tg) tg.table_grants = tg.table_grants.filter((g) => !NEW_RELATIONS.includes(g.split(':')[0]));
  each(inner, (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (v === VIEW[1]) o[k] = VIEW[0];
        else if (v.includes(`fin_customer_collections:${VIEW[1]}:`)) o[k] = v.replace(`fin_customer_collections:${VIEW[1]}:`, `fin_customer_collections:${VIEW[0]}:`);
      } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        o[k] = v.map((x) => x.replace(`fin_customer_collections:${VIEW[1]}:`, `fin_customer_collections:${VIEW[0]}:`));
      }
    }
  });
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check('0112 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0112 SECURITY DEFINER: exactly +5 (3 ADMIN RPCs + 2 internal cores)', NEW_DEFINERS.every((d) => realDefiners.includes(d)), `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0112 functions: the RPCs EXECUTE authenticated only; the cores and both guards no API EXECUTE; bodies as in 0112', eq(a.functions, FUNCTIONS), JSON.stringify(a.functions));
  check('0112 tables: RLS on, SELECT for authenticated only, one ADMIN policy each', eq(a.tables, TABLES) && eq(a.policies, POLICIES), JSON.stringify([a.tables, a.policies]));
  check('0112 triggers: both tables immutable; new manual Mercado Pago allocations and new payer mappings guarded (enabled)', eq(a.triggers, TRIGGERS), JSON.stringify(a.triggers));
  check('0112 view fin_customer_collections with the declarations appended', a.view === VIEW[1], String(a.view));
  check('0112 columns of the two tables', eq(a.columns, COLUMNS), JSON.stringify(a.columns));
  if (ctx.deploymentCheck) check('0112 deployment: no declaration, no reversal, no audit, no ledger row right after the migration',
    [a.declared, a.reversals, a.audits, a.ledger_links].every((x) => Number(x) === 0), `${a.declared}|${a.reversals}|${a.audits}|${a.ledger_links}`);
  return out;
}
