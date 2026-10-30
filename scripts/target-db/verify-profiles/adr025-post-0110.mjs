/**
 * Verification profile ADR025_POST_0110 — the exact database state after target migrations 0001…0110
 * (0110, Lote 3B: pending expense → supplier (assign_payable_to_supplier), due / estimated payment dates (purchase_payment_date,
 * set_payment_date, payment_date_current), the link guard on expense_payable_payment, the views fin_payment_calendar and
 * fin_supplier_unallocated_payments (new) and fin_purchase_payment_status / fin_expense_payables (re-created with appended columns)).
 *
 * The whole 0001…0109 state is verified by ADR025_POST_0109. Its expectations that change with 0110 are translated back before
 * evaluating it (and checked here exactly instead): the three new SECURITY DEFINER identities (D), the grants of the two new views
 * (K), the definitions of fin_purchase_payment_status (0104 views) and fin_expense_payables (0106 views). A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0109.mjs';

export const NAME = 'ADR025_POST_0110';
export const THROUGH = '0110';
const MIGRATION = '0110_payables_supplier_link_calendar.sql';
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const NEW_DEFINERS = ['assign_payable_to_supplier(uuid,uuid,text,character varying,character varying)', 'expense_payable_payment_link_guard()',
  'set_payment_date(uuid,text,date,text)'];
const FUNCTIONS = [
  'assign_payable_to_supplier(uuid,uuid,text,character varying,character varying)|true|postgres|search_path=public|falsetruefalse|f78580f09ba2910e42cc6b1b2685e4f4',
  'expense_payable_payment_link_guard()|true|postgres|search_path=public, pg_temp|falsefalsefalse|b0b0d461ff624a73d17261ed17090200',
  'payment_date_current(uuid,text)|false|postgres|search_path=public|falsetruefalse|52414c591070f092ebe900460ca0dbfa',
  'set_payment_date(uuid,text,date,text)|true|postgres|search_path=public|falsetruefalse|ff7571f55a07e5c86639c87a70c51259',
];
const FN_NAMES = ['assign_payable_to_supplier', 'expense_payable_payment_link_guard', 'payment_date_current', 'set_payment_date'];
const TABLES = ['expense_payable_supplier_link:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}',
  'purchase_payment_date:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}'];
const POLICIES = ['expense_payable_supplier_link:expense_payable_supplier_link_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5',
  'purchase_payment_date:purchase_payment_date_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5'];
const TRIGGERS = ['expense_payable_payment:trg_expense_payable_payment_immutable:fin_evidence_immutable_guard()',
  'expense_payable_payment:trg_expense_payable_payment_link_guard:expense_payable_payment_link_guard()',
  'expense_payable_supplier_link:trg_expense_payable_supplier_link_immutable:fin_evidence_immutable_guard()',
  'purchase_payment_date:trg_purchase_payment_date_immutable:fin_evidence_immutable_guard()'];
const ACL = '{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const NEW_VIEWS = ['fin_payment_calendar', 'fin_supplier_unallocated_payments'];
const VIEWS = [`fin_expense_payables:975915d8ab8c258a9b00e43530231696:${ACL}`, `fin_payment_calendar:5c8454f777adde63d1369e2c227d07ae:${ACL}`,
  `fin_purchase_payment_status:504b9a947a94c83a2db645c8d0f40b7e:${ACL}`, `fin_supplier_unallocated_payments:fd7770c773391dbcc3b43188e4e45e5f:${ACL}`];
const COLUMNS = [
  'fin_expense_payables:payable_id,purchase_id,purchase_root_id,economic_date,concept,counterparty_name,expense_category_id,category_name,nature,fiscal_document_id,amount,paid,pending,due_date,status,origin,created_at,created_by,planned_date',
  'fin_payment_calendar:item_kind,item_id,purchase_root_id,purchase_id,supplier_id,supplier_name,concept,document_number,economic_date,amount_total,amount,due_date,planned_date,link_status,bank_account_name,linked_invoice_number',
  'fin_purchase_payment_status:purchase_id,purchase_root_id,supplier_id,supplier_name,supplier_invoice_number,fiscal_document_id,economic_date,amount_total,scheduled,debited,other_payments,pending,voided_instruments,due_date,planned_date',
  'fin_supplier_unallocated_payments:financial_operation_id,supplier_id,effective_date,reason,paid,allocated,available',
];
// the definitions before 0110 (POST_0104 / POST_0106 expectations), restored when the 0110 one is found
const BACK = [['fin_purchase_payment_status:504b9a947a94c83a2db645c8d0f40b7e:', 'fin_purchase_payment_status:bf49bf77321d33371782f2928cf55d42:'],
  ['fin_expense_payables:975915d8ab8c258a9b00e43530231696:', 'fin_expense_payables:8719e2f8011974601ad25833d77e5bb3:']];

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
const NEW_TABLES = ['expense_payable_supplier_link', 'purchase_payment_date'];
const VIEW_NAMES = ['fin_expense_payables', 'fin_payment_calendar', 'fin_purchase_payment_status', 'fin_supplier_unallocated_payments'];

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0110', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0110'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|'
                   || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                   || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
                  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${FN_NAMES.map(lit).join(', ')})) q),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${NEW_TABLES.map(lit).join(', ')})),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || md5(coalesce(qual, '')) ORDER BY tablename, policyname), '[]')
                   FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${NEW_TABLES.map(lit).join(', ')})),
    'column_writes', (SELECT count(*) FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name IN (${NEW_TABLES.map(lit).join(', ')})
                        AND grantee IN ('anon', 'authenticated', 'service_role') AND privilege_type <> 'SELECT'),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tgrelid::regclass::text || ':' || tgname || ':' || tgfoid::regprocedure::text AS t FROM pg_trigger
                   WHERE NOT tgisinternal AND tgrelid IN ('public.expense_payable_supplier_link'::regclass, 'public.purchase_payment_date'::regclass, 'public.expense_payable_payment'::regclass)) q),
    'views', (SELECT coalesce(json_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${VIEW_NAMES.map(lit).join(', ')})),
    'columns', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT table_name || ':' || string_agg(column_name, ',' ORDER BY ordinal_position) AS t
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${VIEW_NAMES.map(lit).join(', ')}) GROUP BY table_name) q),
    'links', (SELECT count(*) FROM expense_payable_supplier_link),
    'dates', (SELECT count(*) FROM purchase_payment_date),
    'link_audits', (SELECT count(*) FROM audit_events WHERE action IN ('LINK_SUPPLIER', 'SET_DUE_DATE', 'SET_PLANNED_PAYMENT_DATE')))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0110 ?? {};
  // the 0109 state as POST_0109 knows it: without the 0110 definers and view grants, the two re-created views as before 0110
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const tg = find(inner, 'table_grants');
  if (tg) tg.table_grants = tg.table_grants.filter((g) => !NEW_VIEWS.includes(g.split(':')[0]));
  for (const key of ['a0104', 'a0106']) {
    const o = find(inner, key)?.[key];
    if (o && Array.isArray(o.views)) o.views = o.views.map((v) => BACK.reduce((x, [now, before]) => (x.startsWith(now) ? before + x.slice(now.length) : x), v));
  }
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  const realGrants = find(s.prev, 'table_grants')?.table_grants ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0110 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0110 SECURITY DEFINER: exactly +3 (assign_payable_to_supplier, set_payment_date, expense_payable_payment_link_guard)',
    NEW_DEFINERS.every((d) => realDefiners.includes(d)), `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0110 functions: the two ADMIN RPCs DEFINER (EXECUTE authenticated only), the link guard DEFINER with no API EXECUTE, payment_date_current INVOKER; one overload each; bodies as in 0110',
    JSON.stringify(a.functions) === JSON.stringify(FUNCTIONS), JSON.stringify(a.functions));
  check('0110 tables expense_payable_supplier_link / purchase_payment_date: RLS on, SELECT for authenticated only, no column write; one ADMIN SELECT policy each',
    JSON.stringify(a.tables) === JSON.stringify(TABLES) && JSON.stringify(a.policies) === JSON.stringify(POLICIES) && Number(a.column_writes) === 0,
    JSON.stringify([a.tables, a.policies, a.column_writes]));
  check('0110 triggers: both new tables immutable; expense_payable_payment immutable + the link guard',
    JSON.stringify(a.triggers) === JSON.stringify(TRIGGERS), JSON.stringify(a.triggers));
  check('0110 views fin_payment_calendar / fin_supplier_unallocated_payments (new) and fin_purchase_payment_status / fin_expense_payables (re-created): security_invoker, owner postgres, SELECT authenticated only, definitions as in 0110',
    JSON.stringify(a.views) === JSON.stringify(VIEWS), JSON.stringify(a.views));
  check('0110 view columns: the re-created views keep every column in place and only append due_date / planned_date (planned_date)',
    JSON.stringify(a.columns) === JSON.stringify(COLUMNS), JSON.stringify(a.columns));
  check('0110 grants of the new fin_% views: SELECT for authenticated only',
    JSON.stringify(realGrants.filter((g) => NEW_VIEWS.includes(g.split(':')[0]))) === JSON.stringify(NEW_VIEWS.map((v) => `${v}:authenticated:SELECT`)),
    realGrants.filter((g) => NEW_VIEWS.includes(g.split(':')[0])).join(' '));
  if (ctx.deploymentCheck) check('0110 deployment: no link, no date, no link / date audit right after the migration (nothing linked or dated automatically)',
    Number(a.links) === 0 && Number(a.dates) === 0 && Number(a.link_audits) === 0, `${a.links}|${a.dates}|${a.link_audits}`);
  return out;
}
