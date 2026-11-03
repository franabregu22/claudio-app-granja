/**
 * Verification profile ADR025_POST_0115 — the exact database state after target migrations 0001…0115
 * (0115: an own cheque debited before the bank cut — fin_instrument_precut_debit (immutable evidence), the two ADMIN RPCs
 * fin_instrument_precut_candidates / fin_mark_instrument_debited_precut, the internal check and the trigger that keeps such a cheque
 * DEBITED).
 *
 * The whole 0001…0114 state is verified by ADR025_POST_0114. 0115 adds one table and four functions and changes no existing function:
 * the new SECURITY DEFINER identities and the new table in the ADR-018 table list and its grants are translated back before evaluating
 * it, and everything 0115 created is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0114.mjs';

export const NAME = 'ADR025_POST_0115';
export const THROUGH = '0115';
const MIGRATION = '0115_fin_instrument_precut_debit.sql';
const NEW_DEFINERS = ['fin_instrument_precut_candidates(uuid)', 'fin_mark_instrument_debited_precut(uuid,bigint,date,character varying,text)'];
const NEW_RELATIONS = ['fin_instrument_precut_debit'];
const FN_NAMES = ['fin_instrument_precut_final_guard', 'fin_instrument_precut_check', 'fin_instrument_precut_candidates', 'fin_mark_instrument_debited_precut'];
const FUNCTIONS = [
  'fin_instrument_precut_candidates(uuid)|true|postgres|search_path=public|falsetruefalse|10707da7ba21ef871d15cfdbbc07507e',
  'fin_instrument_precut_check(financial_instrument,fin_statement_line)|false|postgres|search_path=public|falsefalsefalse|b470e69dbb93faed9d6d83d11d92f9d0',
  'fin_instrument_precut_final_guard()|false|postgres|search_path=public|falsefalsefalse|a64ef7e8433d808ac5870339dbf00b6a',
  'fin_mark_instrument_debited_precut(uuid,bigint,date,character varying,text)|true|postgres|search_path=public|falsetruefalse|36b7383315560d5785a962ac4a47a1d1'];
const TABLES = ['fin_instrument_precut_debit:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}'];
const POLICIES = ['fin_instrument_precut_debit:fin_instrument_precut_debit_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5'];
const TRIGGERS = [
  'fin_instrument_precut_debit:trg_fin_instrument_precut_debit_immutable:fin_evidence_immutable_guard():O',
  'financial_instrument:trg_financial_instrument_precut_final:fin_instrument_precut_final_guard():O'];
const COLUMNS = ['fin_instrument_precut_debit:financial_instrument_id,statement_line_id,cutover_id,debited_date,idempotency_key,reason,created_by,created_at'];

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
  const IN = (xs) => xs.map((n) => `'${n}'`).join(', ');
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0115', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0115'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${IN(FN_NAMES)})) q),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${IN(NEW_RELATIONS)})),
    'policies', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || md5(coalesce(qual, '')) AS t
                   FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${IN(NEW_RELATIONS)})) q),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tgrelid::regclass::text || ':' || tgname || ':' || tgfoid::regprocedure::text || ':' || tgenabled::text AS t FROM pg_trigger
                   WHERE NOT tgisinternal AND (tgrelid = 'public.fin_instrument_precut_debit'::regclass OR tgname = 'trg_financial_instrument_precut_final')) q),
    'columns', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT table_name || ':' || string_agg(column_name, ',' ORDER BY ordinal_position) AS t
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${IN(NEW_RELATIONS)}) GROUP BY table_name) q),
    'precut', (SELECT count(*) FROM fin_instrument_precut_debit),
    'precut_audits', (SELECT count(*) FROM audit_events WHERE action = 'DEBIT_PRE_CUTOVER'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0115 ?? {};
  // the 0114 state as POST_0114 knows it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const tg = find(inner, 'table_grants');
  if (tg) tg.table_grants = tg.table_grants.filter((g) => !NEW_RELATIONS.includes(g.split(':')[0]));
  const ft = find(inner, 'fin_tables');
  if (ft) ft.fin_tables = ft.fin_tables.filter((t) => !NEW_RELATIONS.includes(t));
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check('0115 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0115 SECURITY DEFINER: exactly +2 (the two ADMIN RPCs)', NEW_DEFINERS.every((d) => realDefiners.includes(d)), `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0115 functions: the RPCs EXECUTE authenticated only; the check and the guard no API EXECUTE; bodies as in 0115', eq(a.functions, FUNCTIONS), JSON.stringify(a.functions));
  check('0115 table: RLS on, SELECT for authenticated only, one ADMIN policy', eq(a.tables, TABLES) && eq(a.policies, POLICIES), JSON.stringify([a.tables, a.policies]));
  check('0115 the evidence is immutable; a cheque debited before the cut stays debited', eq(a.triggers, TRIGGERS), JSON.stringify(a.triggers));
  check('0115 columns of the evidence table', eq(a.columns, COLUMNS), JSON.stringify(a.columns));
  if (ctx.deploymentCheck) check('0115 deployment: nothing settled right after the migration', Number(a.precut) === 0 && Number(a.precut_audits) === 0, `${a.precut}|${a.precut_audits}`);
  return out;
}
