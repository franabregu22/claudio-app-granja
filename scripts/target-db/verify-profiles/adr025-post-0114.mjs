/**
 * Verification profile ADR025_POST_0114 — the exact database state after target migrations 0001…0114
 * (0114, ADR-018 §23: bank charges from the statement — fin_statement_charge_rule (seeded), fin_statement_charge_booking, the two ADMIN
 * RPCs fin_statement_charge_proposals / fin_book_statement_charges and three internal helpers).
 *
 * The whole 0001…0113 state is verified by ADR025_POST_0113. 0114 adds two tables and five functions: the new SECURITY DEFINER
 * identities, the two tables in the ADR-018 table list and their grants are translated back before evaluating it, and everything 0114
 * created is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0113.mjs';

export const NAME = 'ADR025_POST_0114';
export const THROUGH = '0114';
const MIGRATION = '0114_fin_statement_charges.sql';
const NEW_DEFINERS = ['fin_book_statement_charges(uuid,jsonb,character varying)', 'fin_statement_charge_proposals(uuid)'];
const NEW_RELATIONS = ['fin_statement_charge_booking', 'fin_statement_charge_rule'];
const FN_NAMES = ['fin_statement_line_cut_class', 'fin_statement_charge_proposal', 'fin_statement_charge_proposals', 'fin_statement_bank_iva', 'fin_book_statement_charges'];
const FUNCTIONS = [
  'fin_book_statement_charges(uuid,jsonb,character varying)|true|postgres|search_path=public|falsetruefalse|21ad14c9a9c24444b64db00e17b62765',
  'fin_statement_bank_iva(uuid,numeric,date,text,text)|false|postgres|search_path=public|falsefalsefalse|5bc3b66a62c54759eb81e9a75f7859dd',
  'fin_statement_charge_proposal(bigint)|false|postgres|search_path=public|falsefalsefalse|5be4d2c713a628967525e739d8a40cf6',
  'fin_statement_charge_proposals(uuid)|true|postgres|search_path=public|falsetruefalse|edefff5d52898780b1e9efaa0f67d3f5',
  'fin_statement_line_cut_class(bigint)|false|postgres|search_path=public|falsefalsefalse|7462b2c93a3a532b24110ff3ad97d8cc'];
const TABLES = [
  'fin_statement_charge_booking:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}',
  'fin_statement_charge_rule:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}',
  'fin_statement_charge_rule_id_seq:falsefalse:{postgres=rwU/postgres}'];
const POLICIES = [
  'fin_statement_charge_booking:fin_statement_charge_booking_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5',
  'fin_statement_charge_rule:fin_statement_charge_rule_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5'];
const TRIGGERS = ['fin_statement_charge_booking:trg_fin_statement_charge_booking_immutable:fin_evidence_immutable_guard():O'];
const COLUMNS = [
  'fin_statement_charge_booking:statement_line_id,rule_id,kind,financial_operation_id,financial_posting_id,statement_match_id,purchase_id,batch_key,booked_by,booked_at',
  'fin_statement_charge_rule:id,format_code,pattern,kind,label,expense_category_id,activo,created_at'];
// the five seeded rules (format, pattern, kind, label, a category present for the two fees, active)
const RULES = '2b1d61c484c39f9c94e8bc13759fd3cd|5';

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
  'a0114', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0114'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${IN(FN_NAMES)})) q),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${IN([...NEW_RELATIONS, 'fin_statement_charge_rule_id_seq'])})),
    'policies', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || md5(coalesce(qual, '')) AS t
                   FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${IN(NEW_RELATIONS)})) q),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tgrelid::regclass::text || ':' || tgname || ':' || tgfoid::regprocedure::text || ':' || tgenabled::text AS t FROM pg_trigger
                   WHERE NOT tgisinternal AND tgrelid IN ('public.fin_statement_charge_rule'::regclass, 'public.fin_statement_charge_booking'::regclass)) q),
    'columns', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT table_name || ':' || string_agg(column_name, ',' ORDER BY ordinal_position) AS t
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${IN(NEW_RELATIONS)}) GROUP BY table_name) q),
    'rules', (SELECT md5(string_agg(format_code || '|' || pattern || '|' || kind || '|' || label || '|' || (expense_category_id IS NOT NULL) || '|' || activo, E'\\n' ORDER BY format_code, pattern)) || '|' || count(*) FROM fin_statement_charge_rule),
    'bookings', (SELECT count(*) FROM fin_statement_charge_booking),
    'batch_audits', (SELECT count(*) FROM audit_events WHERE action = 'FIN_STATEMENT_CHARGES_BOOKED'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0114 ?? {};
  // the 0113 state as POST_0113 knows it
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
  check('0114 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0114 SECURITY DEFINER: exactly +2 (the two ADMIN RPCs)', NEW_DEFINERS.every((d) => realDefiners.includes(d)), `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0114 functions: the RPCs EXECUTE authenticated only; the helpers no API EXECUTE; bodies as in 0114', eq(a.functions, FUNCTIONS), JSON.stringify(a.functions));
  check('0114 tables: RLS on, SELECT for authenticated only, one ADMIN policy each; the rule sequence private', eq(a.tables, TABLES) && eq(a.policies, POLICIES), JSON.stringify([a.tables, a.policies]));
  check('0114 the booking evidence is immutable', eq(a.triggers, TRIGGERS), JSON.stringify(a.triggers));
  check('0114 columns of the two tables', eq(a.columns, COLUMNS), JSON.stringify(a.columns));
  check('0114 the five seeded recognition rules (BNA: debits / credits tax, fee, eCheq, IVA; Patagonia: debits / credits tax)', a.rules === RULES, String(a.rules));
  if (ctx.deploymentCheck) check('0114 deployment: nothing booked right after the migration', Number(a.bookings) === 0 && Number(a.batch_audits) === 0, `${a.bookings}|${a.batch_audits}`);
  return out;
}
