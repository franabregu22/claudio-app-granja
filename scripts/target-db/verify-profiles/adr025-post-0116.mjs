/**
 * Verification profile ADR025_POST_0116 — the exact database state after target migrations 0001…0116
 * (0116: Caja — fin_movement_list (the unified list), fin_transfer_intent and its three ADMIN RPCs, fin_relate_bank_tax, and the
 * statement charge proposal that never re-books a tax already recorded: fin_statement_charge_proposal re-created (status RECORDED)
 * and fin_statement_charge_proposals re-created with the posting to match).
 *
 * The whole 0001…0115 state is verified by ADR025_POST_0115. 0116 adds one table and eight functions and re-creates two 0114
 * functions: the new SECURITY DEFINER identities, the new table in the ADR-018 table list and its grants, and the two re-created
 * 0114 bodies are translated back before evaluating it; everything 0116 created or changed is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0115.mjs';

export const NAME = 'ADR025_POST_0116';
export const THROUGH = '0116';
const MIGRATION = '0116_caja_movements_transfers.sql';
const NEW_DEFINERS = [
  'fin_cancel_transfer_intent(bigint,text)', 'fin_link_transfer_intent(bigint,text,bigint)', 'fin_movement_list(date,date,uuid,text,text,numeric,text,text,integer,integer)',
  'fin_register_transfer_intent(uuid,uuid,numeric,date,character varying,text)', 'fin_relate_bank_tax(bigint,bigint,text)'];
const NEW_RELATIONS = ['fin_transfer_intent', 'fin_transfer_intent_id_seq'];
const FN_NAMES = ['fin_movement_list', 'fin_transfer_intent_route', 'fin_register_transfer_intent', 'fin_link_transfer_intent', 'fin_cancel_transfer_intent',
  'fin_relate_bank_tax', 'fin_statement_recorded_charges', 'fin_statement_charge_proposal', 'fin_statement_charge_proposals'];
// the two 0114 functions 0116 re-creates: what ADR025_POST_0114 pinned, and what they are now
const REPLACED = {
  'fin_statement_charge_proposal(bigint)': 'fin_statement_charge_proposal(bigint)|false|postgres|search_path=public|falsefalsefalse|5be4d2c713a628967525e739d8a40cf6',
  'fin_statement_charge_proposals(uuid)': 'fin_statement_charge_proposals(uuid)|true|postgres|search_path=public|falsetruefalse|edefff5d52898780b1e9efaa0f67d3f5',
};
const FUNCTIONS = [
  'fin_cancel_transfer_intent(bigint,text)|true|postgres|search_path=public|falsetruefalse|@',
  'fin_link_transfer_intent(bigint,text,bigint)|true|postgres|search_path=public|falsetruefalse|@',
  'fin_movement_list(date,date,uuid,text,text,numeric,text,text,integer,integer)|true|postgres|search_path=public|falsetruefalse|@',
  'fin_register_transfer_intent(uuid,uuid,numeric,date,character varying,text)|true|postgres|search_path=public|falsetruefalse|@',
  'fin_relate_bank_tax(bigint,bigint,text)|true|postgres|search_path=public|falsetruefalse|@',
  'fin_statement_charge_proposal(bigint)|false|postgres|search_path=public|falsefalsefalse|@',
  'fin_statement_charge_proposals(uuid)|true|postgres|search_path=public|falsetruefalse|@',
  'fin_statement_recorded_charges(bigint,text)|false|postgres|search_path=public|falsefalsefalse|@',
  'fin_transfer_intent_route(uuid,uuid)|false|postgres|search_path=public|falsefalsefalse|@'];
const TABLES = ['fin_transfer_intent:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}', 'fin_transfer_intent_id_seq:falsefalse:NULL'];
const POLICIES = ['fin_transfer_intent:fin_transfer_intent_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5'];
const COLUMNS = ['fin_transfer_intent:id,from_account_id,to_account_id,amount,effective_date,reason,idempotency_key,status,transfer_operation_id,linked_source_id,linked_at,linked_by,cancelled_at,cancelled_by,cancel_reason,created_by,created_at'];

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
/** Every object holding `key` (the 0114 function list appears once, but the search does not assume it). */
function findAll(o, key, out = []) {
  if (!o || typeof o !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(o, key)) out.push(o);
  for (const v of Object.values(o)) findAll(v, key, out);
  return out;
}

export function buildSql(repo) {
  const IN = (xs) => xs.map((n) => `'${n}'`).join(', ');
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0116', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0116'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${IN(FN_NAMES)})) q),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${IN(NEW_RELATIONS)})),
    'policies', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || md5(coalesce(qual, '')) AS t
                   FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${IN(NEW_RELATIONS)})) q),
    'columns', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT table_name || ':' || string_agg(column_name, ',' ORDER BY ordinal_position) AS t
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${IN(NEW_RELATIONS)}) GROUP BY table_name) q),
    'intents', (SELECT count(*) FROM fin_transfer_intent),
    'intent_audits', (SELECT count(*) FROM audit_events WHERE entity_type = 'fin_transfer_intent'),
    'relate_audits', (SELECT count(*) FROM audit_events WHERE action = 'RELATE_BANK_TAX'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0116 ?? {};
  // the 0115 state as POST_0115 knows it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const tg = find(inner, 'table_grants');
  if (tg) tg.table_grants = tg.table_grants.filter((g) => !NEW_RELATIONS.includes(g.split(':')[0]));
  const ft = find(inner, 'fin_tables');
  if (ft) ft.fin_tables = ft.fin_tables.filter((t) => !NEW_RELATIONS.includes(t));
  for (const holder of findAll(inner, 'functions')) {
    if (Array.isArray(holder.functions)) holder.functions = holder.functions.map((f) => REPLACED[f.split('|')[0]] ?? f);
  }
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const shape = (xs) => (xs ?? []).map((f) => f.replace(/\|[0-9a-f]{32}$/, '|@'));
  check('0116 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0116 SECURITY DEFINER: exactly +5 (the list, three transfer-intent RPCs, the tax relation)', NEW_DEFINERS.every((d) => realDefiners.includes(d)),
    `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0116 functions: the RPCs EXECUTE authenticated only, the helpers no API EXECUTE', eq(shape(a.functions), FUNCTIONS), JSON.stringify(a.functions));
  check('0116 functions: bodies as in 0116 (md5 of the migration text)', eq(a.functions, fileBodies(ctx.repo)), JSON.stringify(a.functions));
  check('0116 table: RLS on, SELECT for authenticated only, one ADMIN policy; the sequence private', eq(a.tables, TABLES) && eq(a.policies, POLICIES), JSON.stringify([a.tables, a.policies]));
  check('0116 columns of fin_transfer_intent', eq(a.columns, COLUMNS), JSON.stringify(a.columns));
  if (ctx.deploymentCheck) check('0116 deployment: no transfer intent and no tax relation right after the migration',
    Number(a.intents) === 0 && Number(a.intent_audits) === 0 && Number(a.relate_audits) === 0, `${a.intents}|${a.intent_audits}|${a.relate_audits}`);
  return out;
}

/** The expected function rows with the md5 of each body as written in the migration file (the server stores the body verbatim). */
function fileBodies(repo) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', MIGRATION), 'utf8').replace(/\r/g, '');
  const bodies = new Map();
  const re = /CREATE (?:OR REPLACE )?FUNCTION (\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g;
  let m;
  while ((m = re.exec(text))) bodies.set(m[1], createHash('md5').update(m[2]).digest('hex'));
  return FUNCTIONS.map((f) => f.replace('|@', `|${bodies.get(f.split('(')[0]) ?? 'missing'}`));
}
