/**
 * Verification profile ADR025_POST_0123 — the exact database state after target migrations 0001…0123 (caja-mejoras-v2):
 *   0121 Cuentas a pagar: payment_plan_item / payment_plan_item_link (append-only), the trigger fin_plan_link_payment on
 *        purchase_payment_allocation and expense_payable_payment, set_payment_plan / pay_plan_item / issue_plan_item_instruments, the
 *        helpers payment_plan_current_version / payment_plan_item_covered / payment_plan_open_amount / payment_plan_item_for_payment,
 *        the view fin_payables_due;
 *   0122 Flujo de caja: fin_cash_flow (read only);
 *   0123 Cartera de cheques: endorse_cheque_to_payable; purchase_allocated_amount, payment_plan_item_covered and the view
 *        fin_purchase_payment_status re-created so an endorsed client cheque counts as paid (same signatures, same columns).
 *
 * The whole 0001…0120 state is verified by ADR025_POST_0120. Before evaluating it, what 0121–0123 added or re-created is translated
 * back to what that profile pinned: the new definer identities, the new relations in the grant list, the new trigger on
 * expense_payable_payment, the 0104 body of purchase_allocated_amount and the 0110 definition of fin_purchase_payment_status. Everything
 * 0121–0123 created or re-created is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0120.mjs';

export const NAME = 'ADR025_POST_0123';
export const THROUGH = '0123';
const MIGRATIONS = ['0121_cuentas_a_pagar_plan_pagos.sql', '0122_caja_flujo_de_caja.sql', '0123_cartera_cheques_endoso.sql'];
const NEW_DEFINERS = [
  'endorse_cheque_to_payable(uuid,uuid,bigint,date,character varying,text)', 'fin_cash_flow(date,date,text)', 'fin_plan_link_payment()',
  'issue_plan_item_instruments(bigint,jsonb,character varying,text)', 'pay_plan_item(bigint,numeric,date,payment_method,uuid,character varying,text)',
  'set_payment_plan(uuid,jsonb,character varying,text)'];
const NEW_RELATIONS = ['fin_payables_due', 'payment_plan_item', 'payment_plan_item_link'];
const NEW_TRIGGERS = ['trg_ppa_plan_link', 'trg_epp_plan_link'];
// fin_purchase_payment_status: the 0110 definition (as POST_0110 pins it) and the 0123 one (an endorsed cheque counts as paid)
const PPS_0110 = '504b9a947a94c83a2db645c8d0f40b7e';
const PPS_0123 = 'c209e6f2706b68d80c98b30f48b672da';
const DUE_0121 = 'd71403d090e59393170da51d2a5fb69d';
const DEF = 'search_path=public, pg_temp';
// signature | definer | owner | config | EXECUTE anon / authenticated / service_role | file where the body in force is written
const FUNCTIONS = [
  ['endorse_cheque_to_payable(uuid,uuid,bigint,date,character varying,text)', true, DEF, 'falsetruefalse', 2],
  ['fin_cash_flow(date,date,text)', true, DEF, 'falsetruefalse', 1],
  ['fin_plan_link_payment()', true, DEF, 'falsefalsefalse', 0],
  ['issue_plan_item_instruments(bigint,jsonb,character varying,text)', true, DEF, 'falsetruefalse', 0],
  ['pay_plan_item(bigint,numeric,date,payment_method,uuid,character varying,text)', true, DEF, 'falsetruefalse', 0],
  ['payment_plan_current_version(uuid)', false, 'search_path=public', 'falsetruefalse', 0],
  ['payment_plan_item_covered(bigint)', false, 'search_path=public', 'falsetruefalse', 2],
  ['payment_plan_item_for_payment(bigint,numeric)', false, DEF, 'falsefalsefalse', 0],
  ['payment_plan_open_amount(uuid)', false, 'search_path=public', 'falsetruefalse', 0],
  ['purchase_allocated_amount(uuid)', false, 'search_path=public', 'falsefalsefalse', 2],
  ['set_payment_plan(uuid,jsonb,character varying,text)', true, DEF, 'falsetruefalse', 0],
];
const FN_NAMES = FUNCTIONS.map(([s]) => s.split('(')[0]);
const TABLES = ['payment_plan_item:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}', 'payment_plan_item_link:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}'];
const POLICIES = ['payment_plan_item:payment_plan_item_admin_select:SELECT', 'payment_plan_item_link:payment_plan_item_link_admin_select:SELECT'];
const SEQUENCES = ['payment_plan_item_id_seq:{postgres=rwU/postgres}', 'payment_plan_item_link_id_seq:{postgres=rwU/postgres}'];   // REVOKE leaves the owner only: no API privilege
const VIEWS = [`fin_payables_due:${DUE_0121}:{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}`,
  `fin_purchase_payment_status:${PPS_0123}:{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}`];
const TRIGGERS = [
  'expense_payable_payment:trg_epp_plan_link:fin_plan_link_payment():AFTER INSERT ROW',
  'payment_plan_item:trg_payment_plan_item_immutable:fin_evidence_immutable_guard():BEFORE UPDATE OR DELETE ROW',
  'payment_plan_item_link:trg_payment_plan_item_link_immutable:fin_evidence_immutable_guard():BEFORE UPDATE OR DELETE ROW',
  'purchase_payment_allocation:trg_ppa_plan_link:fin_plan_link_payment():AFTER INSERT ROW'];

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
function findAll(o, key, out = []) {
  if (!o || typeof o !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(o, key)) out.push(o);
  for (const v of Object.values(o)) findAll(v, key, out);
  return out;
}
/** md5 of the body of `fn` as written in a migration file (the server stores the body verbatim). */
function bodyMd5(repo, file, fn) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', file), 'utf8').replace(/\r/g, '');
  const re = /CREATE (?:OR REPLACE )?FUNCTION (\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g;
  let m; let last = 'missing';
  while ((m = re.exec(text))) if (m[1] === fn) last = createHash('md5').update(m[2]).digest('hex');
  return last;
}

export function buildSql(repo) {
  const IN = (xs) => xs.map((n) => `'${n}'`).join(', ');
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0123', json_build_object(
    'ledger', (SELECT coalesce(json_agg(filename || '|' || sha256 ORDER BY version), '[]') FROM migration_ledger.applied WHERE version IN ('0121', '0122', '0123')),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${IN(FN_NAMES)})) q),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('payment_plan_item', 'payment_plan_item_link')),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd ORDER BY tablename, policyname), '[]') FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('payment_plan_item', 'payment_plan_item_link')),
    'sequences', (SELECT coalesce(json_agg(c.relname || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S' AND c.relname IN ('payment_plan_item_id_seq', 'payment_plan_item_link_id_seq')),
    'views', (SELECT coalesce(json_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('fin_payables_due', 'fin_purchase_payment_status')),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tg.tgrelid::regclass::text || ':' || tg.tgname || ':' || tg.tgfoid::regprocedure::text || ':'
        || CASE WHEN tg.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END || ' ' || concat_ws(' OR ', CASE WHEN tg.tgtype & 4 = 4 THEN 'INSERT' END, CASE WHEN tg.tgtype & 16 = 16 THEN 'UPDATE' END, CASE WHEN tg.tgtype & 8 = 8 THEN 'DELETE' END)
        || ' ' || CASE WHEN tg.tgtype & 1 = 1 THEN 'ROW' ELSE 'STATEMENT' END AS t
        FROM pg_trigger tg WHERE NOT tg.tgisinternal AND tg.tgenabled = 'O' AND tg.tgname IN ('trg_ppa_plan_link', 'trg_epp_plan_link', 'trg_payment_plan_item_immutable', 'trg_payment_plan_item_link_immutable')) q),
    'plans', (SELECT count(*) FROM payment_plan_item WHERE to_regclass('public.payment_plan_item') IS NOT NULL),
    'endorse_audits', (SELECT count(*) FROM audit_events WHERE action IN ('SET_PAYMENT_PLAN', 'ENDORSE_TO_PAYABLE')))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0123 ?? {};
  // the 0120 state as POST_0120 knows it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  for (const h of findAll(inner, 'table_grants')) if (Array.isArray(h.table_grants)) h.table_grants = h.table_grants.filter((g) => !NEW_RELATIONS.includes(String(g).split(':')[0]));
  for (const h of findAll(inner, 'fin_tables')) if (Array.isArray(h.fin_tables)) h.fin_tables = h.fin_tables.filter((t) => !NEW_RELATIONS.includes(t));
  for (const h of findAll(inner, 'triggers')) {
    if (Array.isArray(h.triggers)) h.triggers = h.triggers.filter((t) => typeof t !== 'string' || !NEW_TRIGGERS.some((n) => t.includes(`:${n}:`)));
  }
  for (const h of findAll(inner, 'views')) {
    if (Array.isArray(h.views)) h.views = h.views.map((v) => (typeof v === 'string' && v.startsWith(`fin_purchase_payment_status:${PPS_0123}:`) ? v.replace(PPS_0123, PPS_0110) : v));
  }
  const old0104 = bodyMd5(ctx.repo, '0104_purchase_payments_instruments.sql', 'purchase_allocated_amount');
  for (const h of findAll(inner, 'functions')) {
    if (Array.isArray(h.functions)) h.functions = h.functions.map((f) => (typeof f === 'string' && f.startsWith('purchase_allocated_amount(uuid)|') ? f.replace(/[0-9a-f]{32}$/, old0104) : f));
  }
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const expectedFns = FUNCTIONS.map(([sig, def, cfg, priv, file]) => `${sig}|${def}|postgres|${cfg}|${priv}|${bodyMd5(ctx.repo, MIGRATIONS[file], sig.split('(')[0])}`).sort();
  check('0121–0123 ledger rows = repository files (name + full sha256)', eq(a.ledger, MIGRATIONS.map((f) => `${f}|${shaOf(ctx.repo, f)}`)), JSON.stringify(a.ledger).slice(0, 200));
  check('0121–0123 SECURITY DEFINER: exactly +6 (plan, pay item, item cheques, the link trigger, cash flow, endorsement)', NEW_DEFINERS.every((d) => realDefiners.includes(d)),
    `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0121–0123 functions: RPCs EXECUTE authenticated only, trigger / internal helper no API EXECUTE; one overload each; bodies as in the migrations in force',
    eq(a.functions, expectedFns), JSON.stringify(a.functions));
  check('0121 tables payment_plan_item / payment_plan_item_link: RLS on, SELECT for authenticated only, one ADMIN SELECT policy each; sequences without API privilege',
    eq(a.tables, TABLES) && eq(a.policies, POLICIES) && eq(a.sequences, SEQUENCES), JSON.stringify([a.tables, a.policies, a.sequences]));
  check('0121 / 0123 views fin_payables_due (new) and fin_purchase_payment_status (re-created): security_invoker, owner postgres, SELECT authenticated only, definitions as in 0121 / 0123',
    eq(a.views, VIEWS), JSON.stringify(a.views));
  check('0121 triggers: a payment of an obligation with a plan is linked (allocation + pending-expense payment); plan tables append-only', eq(a.triggers, TRIGGERS), JSON.stringify(a.triggers));
  if (ctx.deploymentCheck) check('0121–0123 deployment: no plan and no endorsement right after the migration', Number(a.plans) === 0 && Number(a.endorse_audits) === 0, `${a.plans}|${a.endorse_audits}`);
  return out;
}
