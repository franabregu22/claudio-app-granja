/**
 * Verification profile ADR025_POST_0124 — the exact database state after target migrations 0001…0124 (caja-mejoras-v2):
 *   0124 Gastos: purchase_annulment (append-only) + annul_expense; fin_annulled_payment_guard on purchase_payment_allocation and
 *        expense_payable_payment; expense_payable_amount; the view fin_expense_annulments; re-created with the same identity:
 *        fin_expense_payables, fin_purchase_payment_status, pnl_line_item, report_fiscal_period (annulled expenses out; a pending expense's
 *        amount in force = its current version), rectify_purchase_details and pay_pending_expense.
 *
 * The whole 0001…0123 state is verified by ADR025_POST_0123. Before evaluating it, what 0124 added or re-created is translated back to
 * what that profile (and the ones it chains) pinned: the two new definer identities, the two new relations in the grant list, the two
 * new guard triggers, the 0123 / 0110 / 0101 definitions of the three re-created views and the 0117 / 0106 bodies of the two re-created
 * functions. Everything 0124 created or re-created is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0123.mjs';

export const NAME = 'ADR025_POST_0124';
export const THROUGH = '0124';
const MIGRATION = '0124_gastos_anular_y_editar.sql';
const NEW_DEFINERS = ['annul_expense(uuid,text,character varying,date)', 'fin_annulled_payment_guard()'];
const NEW_RELATIONS = ['fin_expense_annulments', 'purchase_annulment'];
const NEW_TRIGGERS = ['trg_ppa_annulled_guard', 'trg_epp_annulled_guard', 'trg_purchase_annulment_immutable'];
// view md5: what the previous profiles pinned (0123 state) → what 0124 serves
const VIEW_MD5 = {
  fin_purchase_payment_status: ['c209e6f2706b68d80c98b30f48b672da', '87c08e47b0009216690d5e34679a70ca'],
  fin_expense_payables: ['975915d8ab8c258a9b00e43530231696', '0bca7aee6a891525bd6b479db1dcd6d7'],
  pnl_line_item: ['940fd8c46fea5c78bc9f3c6984d61d53', '969ee9cd7ad9e21af9ed82bb91d88bb9'],
  report_fiscal_period: ['7ffff1e3a0acd30fdd74a30081a0faa5', 'db26c387b554cf377de50a9162a1065c'],
};
const ANNUL_VIEW = 'fin_expense_annulments:495d71fbd297ece1d6f503fc7e453167:{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
// re-created functions: the file that held the body before 0124
const OLD_BODY = { rectify_purchase_details: '0117_expense_paid_supplier_rectify.sql', pay_pending_expense: '0106_pending_expenses.sql' };
const DEF = 'search_path=public, pg_temp';
const FUNCTIONS = [
  ['annul_expense(uuid,text,character varying,date)', true, DEF, 'falsetruefalse'],
  ['expense_payable_amount(uuid)', false, 'search_path=public', 'falsetruefalse'],
  ['fin_annulled_payment_guard()', true, DEF, 'falsefalsefalse'],
  ['pay_pending_expense(uuid,numeric,date,uuid,payment_method,character varying,text)', true, 'search_path=public', 'falsetruefalse'],
  ['rectify_purchase_details(uuid,character varying,uuid,purchase_nature,date,uuid,character varying,numeric,numeric,text,jsonb)', true, DEF, 'falsetruefalse'],
];
const FN_NAMES = FUNCTIONS.map(([s]) => s.split('(')[0]);
const TABLE = 'purchase_annulment:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const POLICY = 'purchase_annulment:purchase_annulment_admin_select:SELECT';
const SEQUENCE = 'purchase_annulment_id_seq:{postgres=rwU/postgres}';
const TRIGGERS = [
  'expense_payable_payment:trg_epp_annulled_guard:fin_annulled_payment_guard():BEFORE INSERT ROW',
  'purchase_annulment:trg_purchase_annulment_immutable:fin_evidence_immutable_guard():BEFORE UPDATE OR DELETE ROW',
  'purchase_payment_allocation:trg_ppa_annulled_guard:fin_annulled_payment_guard():BEFORE INSERT ROW'];

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
  'a0124', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0124'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${IN(FN_NAMES)})) q),
    'table', (SELECT c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'purchase_annulment'),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd ORDER BY policyname), '[]') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchase_annulment'),
    'sequence', (SELECT c.relname || ':' || coalesce(c.relacl::text, 'NULL') FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'purchase_annulment_id_seq'),
    'views', (SELECT coalesce(json_object_agg(c.relname, md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL')), '{}')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('fin_expense_annulments', ${IN(Object.keys(VIEW_MD5))})),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tg.tgrelid::regclass::text || ':' || tg.tgname || ':' || tg.tgfoid::regprocedure::text || ':'
        || CASE WHEN tg.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END || ' ' || concat_ws(' OR ', CASE WHEN tg.tgtype & 4 = 4 THEN 'INSERT' END, CASE WHEN tg.tgtype & 16 = 16 THEN 'UPDATE' END, CASE WHEN tg.tgtype & 8 = 8 THEN 'DELETE' END)
        || ' ' || CASE WHEN tg.tgtype & 1 = 1 THEN 'ROW' ELSE 'STATEMENT' END AS t
        FROM pg_trigger tg WHERE NOT tg.tgisinternal AND tg.tgenabled = 'O' AND tg.tgname IN (${IN(NEW_TRIGGERS)})) q),
    'annulments', (SELECT count(*) FROM purchase_annulment WHERE to_regclass('public.purchase_annulment') IS NOT NULL))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0124 ?? {};
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  for (const h of findAll(inner, 'table_grants')) if (Array.isArray(h.table_grants)) h.table_grants = h.table_grants.filter((g) => !NEW_RELATIONS.includes(String(g).split(':')[0]));
  for (const h of findAll(inner, 'fin_tables')) if (Array.isArray(h.fin_tables)) h.fin_tables = h.fin_tables.filter((t) => !NEW_RELATIONS.includes(t));
  for (const h of findAll(inner, 'triggers')) {
    if (Array.isArray(h.triggers)) h.triggers = h.triggers.filter((t) => typeof t !== 'string' || !NEW_TRIGGERS.some((n) => t.includes(`:${n}:`) || t.startsWith(`${n}:`)));
  }
  for (const h of findAll(inner, 'views')) {
    if (Array.isArray(h.views)) h.views = h.views.map((v) => {
      if (typeof v !== 'string') return v;
      for (const [name, [old, now]] of Object.entries(VIEW_MD5)) if (v.startsWith(`${name}:${now}:`)) return v.replace(now, old);
      return v;
    });
  }
  for (const h of findAll(inner, 'functions')) {
    if (Array.isArray(h.functions)) h.functions = h.functions.map((f) => {
      if (typeof f !== 'string') return f;
      const name = f.split('(')[0];
      return OLD_BODY[name] ? f.replace(/[0-9a-f]{32}$/, bodyMd5(ctx.repo, OLD_BODY[name], name)) : f;
    });
  }
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const expectedFns = FUNCTIONS.map(([sig, def, cfg, priv]) => `${sig}|${def}|postgres|${cfg}|${priv}|${bodyMd5(ctx.repo, MIGRATION, sig.split('(')[0])}`).sort();
  const views = a.views ?? {};
  check('0124 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0124 SECURITY DEFINER: exactly +2 (annul_expense, the payment guard)', NEW_DEFINERS.every((d) => realDefiners.includes(d)),
    `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0124 functions: annul RPC EXECUTE authenticated only, the guard no API EXECUTE; rectification and pending-expense payment re-created; bodies as in 0124',
    eq(a.functions, expectedFns), JSON.stringify(a.functions));
  check('0124 table purchase_annulment: RLS on, SELECT for authenticated only, one ADMIN SELECT policy; its sequence without API privilege',
    a.table === TABLE && eq(a.policies, [POLICY]) && a.sequence === SEQUENCE, JSON.stringify([a.table, a.policies, a.sequence]));
  check('0124 views: fin_expense_annulments (new) and the four re-created ones as in 0124, security_invoker, SELECT authenticated only',
    `fin_expense_annulments:${views.fin_expense_annulments}` === ANNUL_VIEW
      && Object.entries(VIEW_MD5).every(([n, [, now]]) => String(views[n]).startsWith(`${now}:{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}`)),
    JSON.stringify(views));
  check('0124 triggers: nothing is paid or allocated against an annulled expense; the annulment is append-only', eq(a.triggers, TRIGGERS), JSON.stringify(a.triggers));
  if (ctx.deploymentCheck) check('0124 deployment: no annulment right after the migration', Number(a.annulments) === 0, String(a.annulments));
  return out;
}
