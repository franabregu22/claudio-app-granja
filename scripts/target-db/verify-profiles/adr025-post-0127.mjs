/**
 * Verification profile ADR025_POST_0127 — the exact database state after target migrations 0001…0127 (alimento-balanceado-v1):
 *   0125 Alimento: feed_formula_line.section, feed_formula_version.comment, feed_type.standard_batch_kg / inactive_from,
 *        feed_manufacturing.notes; feed_stock_period + assert_feed_month_open / close_feed_month / reopen_feed_month; the recipe RPCs
 *        set_feed_formula_comment / set_feed_type_standard_batch / set_feed_type_active; publish_feed_formula_version (+p_comment),
 *        register_feed_manufacturing (+p_notes), rectify_feed_manufacturing (+p_notes) re-created with a wider identity;
 *        feed_formula_line_safe (+section); report_feed_month, report_feed_recipe_change.
 *   0126 Costo y resultados: expense_category.feed_ingredient_id / is_feed_freight; feed_purchase_quantity, feed_freight_allocation;
 *        feed_cost_start, set_expense_category_feed, set_feed_purchase_quantity, allocate_feed_freight; the cost views; pnl_line_item.
 *   0127 Etiquetas: purchase_tag + set_purchase_tag; fin_purchase_tag, fin_expense_tag_total; fin_operation_list (+p_tag_id, p_sin_etiqueta).
 *
 * The whole 0001…0124 state is verified by ADR025_POST_0124. Before evaluating it, what 0125–0127 added or re-created is translated back
 * to what that profile (and the ones it chains) pinned: the new definer identities out, the four widened identities back to their old
 * ones, the new relations out of the grant lists, pnl_line_item back to its 0124 definition and fin_operation_list back to its 0120 body.
 * Everything 0125–0127 created or re-created is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0124.mjs';

export const NAME = 'ADR025_POST_0127';
export const THROUGH = '0127';
const MIGRATIONS = { '0125': '0125_alimento_recetas_fabricaciones_cierre.sql', '0126': '0126_alimento_costo_y_resultados.sql', '0127': '0127_gastos_etiquetas.sql' };
const NEW_DEFINERS = ['allocate_feed_freight(uuid,jsonb)', 'assert_feed_month_open(date)', 'close_feed_month(date,jsonb,text)', 'reopen_feed_month(date,text)',
  'set_expense_category_feed(uuid,uuid,boolean)', 'set_feed_formula_comment(uuid,text)', 'set_feed_purchase_quantity(uuid,numeric,boolean)',
  'set_feed_type_active(uuid,boolean)', 'set_feed_type_standard_batch(uuid,numeric)', 'set_purchase_tag(uuid,uuid)'];
// widened identities: what 0125–0127 serve → what the previous profiles pinned
const OL = 'date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer';
const WIDENED = {
  'publish_feed_formula_version(uuid,date,jsonb,text,text)': 'publish_feed_formula_version(uuid,date,jsonb,text)',
  'register_feed_manufacturing(uuid,date,numeric,character varying,character varying,text,text)': 'register_feed_manufacturing(uuid,date,numeric,character varying,character varying,text)',
  'rectify_feed_manufacturing(character varying,uuid,numeric,text,character varying,uuid,text)': 'rectify_feed_manufacturing(character varying,uuid,numeric,text,character varying,uuid)',
  [`fin_operation_list(${OL},uuid,boolean)`]: `fin_operation_list(${OL})`,
};
// the previous body of a re-created function a previous profile pins (name → file that held it)
const OLD_BODY = { fin_operation_list: '0120_todas_las_operaciones_detalle.sql' };
const NEW_RELATIONS = ['feed_stock_period', 'feed_purchase_quantity', 'feed_freight_allocation', 'purchase_tag', 'report_feed_month', 'report_feed_recipe_change',
  'report_feed_purchase', 'report_feed_freight', 'report_feed_ingredient_cost_month', 'report_feed_recipe_cost_month', 'report_feed_consumption_cost',
  'fin_purchase_tag', 'fin_expense_tag_total'];
// view md5: what 0124 pinned → what 0126 serves
const VIEW_MD5 = { pnl_line_item: ['969ee9cd7ad9e21af9ed82bb91d88bb9', '8db5c8c43a46a6ae98c2b00c6d24c074'] };
const ACL = '{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const VIEWS = {
  feed_formula_line_safe: `766cc844f01e5aa360e12bffe86024f2:{security_invoker=false}:postgres:${ACL}`,
  fin_expense_tag_total: `c4cf60a0259d74932b40265c7af99fb3:{security_invoker=true}:postgres:${ACL}`,
  fin_purchase_tag: `47ef58c2831cbb07b879e5648416e06b:{security_invoker=true}:postgres:${ACL}`,
  pnl_line_item: `8db5c8c43a46a6ae98c2b00c6d24c074:{security_invoker=true}:postgres:${ACL}`,
  report_feed_consumption_cost: `53d7ee02447e3f1fda9b16eedd8501c3:{security_invoker=true}:postgres:${ACL}`,
  report_feed_freight: `4942f6912e870725827800b9544707a2:{security_invoker=true}:postgres:${ACL}`,
  report_feed_ingredient_cost_month: `e009053fd05dc33ead687297a4082796:{security_invoker=true}:postgres:${ACL}`,
  report_feed_month: `c5259cf78f49428f119748c7f724766a:{security_invoker=true}:postgres:${ACL}`,
  report_feed_purchase: `cd57680fbccef6e9cdcafea4caec4aff:{security_invoker=true}:postgres:${ACL}`,
  report_feed_recipe_change: `8e1a734164f78a428ea764781157d2af:{security_invoker=true}:postgres:${ACL}`,
  report_feed_recipe_cost_month: `41e85ee9a9b40f9612c026248c2ae3bf:{security_invoker=true}:postgres:${ACL}`,
};
const P = 'search_path=public';
// [identity, definer, config, privileges anon/authenticated/service_role, migration whose body it is]
const FUNCTIONS = [
  ['allocate_feed_freight(uuid,jsonb)', true, P, 'falsetruefalse', '0126'],
  ['assert_feed_month_open(date)', true, P, 'falsetruefalse', '0125'],
  ['close_feed_month(date,jsonb,text)', true, P, 'falsetruefalse', '0125'],
  ['feed_cost_start()', false, '', 'falsetruefalse', '0126'],
  [`fin_operation_list(${OL},uuid,boolean)`, true, 'search_path=public, pg_temp', 'falsetruefalse', '0127'],
  ['publish_feed_formula_version(uuid,date,jsonb,text,text)', true, P, 'falsetruefalse', '0125'],
  ['rectify_feed_manufacturing(character varying,uuid,numeric,text,character varying,uuid,text)', true, P, 'falsetruefalse', '0125'],
  ['register_feed_manufacturing(uuid,date,numeric,character varying,character varying,text,text)', true, P, 'falsetruefalse', '0125'],
  ['reopen_feed_month(date,text)', true, P, 'falsetruefalse', '0125'],
  ['set_expense_category_feed(uuid,uuid,boolean)', true, P, 'falsetruefalse', '0126'],
  ['set_feed_formula_comment(uuid,text)', true, P, 'falsetruefalse', '0125'],
  ['set_feed_purchase_quantity(uuid,numeric,boolean)', true, P, 'falsetruefalse', '0126'],
  ['set_feed_type_active(uuid,boolean)', true, P, 'falsetruefalse', '0125'],
  ['set_feed_type_standard_batch(uuid,numeric)', true, P, 'falsetruefalse', '0125'],
  ['set_purchase_tag(uuid,uuid)', true, P, 'falsetruefalse', '0127'],
];
const FN_NAMES = [...new Set(FUNCTIONS.map(([s]) => s.split('(')[0]))];
const TABLES = [
  `feed_freight_allocation:true:${ACL}`, 'feed_freight_allocation_id_seq:false:NULL', `feed_purchase_quantity:true:${ACL}`,
  `feed_stock_period:true:${ACL}`, `purchase_tag:true:${ACL}`];
const POLICIES = ['feed_freight_allocation:feed_freight_allocation_admin_select:SELECT', 'feed_purchase_quantity:feed_purchase_quantity_admin_select:SELECT',
  'feed_stock_period:feed_stock_period_select:SELECT', 'purchase_tag:purchase_tag_admin_select:SELECT'];
const COLUMNS = ['expense_category.feed_ingredient_id:uuid:YES:-', 'expense_category.is_feed_freight:bool:NO:false',
  "feed_formula_line.section:feed_formula_section:NO:'MACRO'::feed_formula_section", 'feed_formula_version.comment:text:YES:-',
  'feed_manufacturing.notes:text:YES:-', 'feed_type.inactive_from:date:YES:-', 'feed_type.standard_batch_kg:numeric:NO:200'];

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
const unwiden = (s) => { for (const [now, old] of Object.entries(WIDENED)) if (s === now || s.startsWith(`${now}|`)) return s.replace(now, old); return s; };
const viewBack = (v) => { for (const [, [old, now]] of Object.entries(VIEW_MD5)) if (typeof v === 'string' && v.includes(now)) return v.replace(now, old); return v; };

export function buildSql(repo) {
  const IN = (xs) => xs.map((n) => `'${n}'`).join(', ');
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0127', json_build_object(
    'ledger', (SELECT coalesce(json_object_agg(version, filename || '|' || sha256), '{}') FROM migration_ledger.applied WHERE version IN ('0125', '0126', '0127')),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${IN(FN_NAMES)})) q),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]') FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('feed_stock_period', 'feed_purchase_quantity', 'feed_freight_allocation', 'purchase_tag', 'feed_freight_allocation_id_seq')),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd ORDER BY tablename, policyname), '[]') FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('feed_stock_period', 'feed_purchase_quantity', 'feed_freight_allocation', 'purchase_tag')),
    'views', (SELECT coalesce(json_object_agg(c.relname, md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL')), '{}')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${IN(Object.keys(VIEWS))})),
    'columns', (SELECT coalesce(json_agg(table_name || '.' || column_name || ':' || udt_name || ':' || is_nullable || ':' || coalesce(column_default, '-') ORDER BY table_name, column_name), '[]')
        FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'feed_formula_line' AND column_name = 'section') OR (table_name = 'feed_formula_version' AND column_name = 'comment')
          OR (table_name = 'feed_type' AND column_name IN ('standard_batch_kg', 'inactive_from')) OR (table_name = 'feed_manufacturing' AND column_name = 'notes')
          OR (table_name = 'expense_category' AND column_name IN ('feed_ingredient_id', 'is_feed_freight')))),
    'cost_start', (SELECT CASE WHEN to_regprocedure('public.feed_cost_start()') IS NULL THEN NULL ELSE feed_cost_start()::text END),
    'rows', (SELECT CASE WHEN to_regclass('public.purchase_tag') IS NULL THEN NULL ELSE
        (SELECT count(*) FROM feed_stock_period) + (SELECT count(*) FROM feed_purchase_quantity) + (SELECT count(*) FROM feed_freight_allocation)
        + (SELECT count(*) FROM purchase_tag) + (SELECT count(*) FROM expense_category WHERE feed_ingredient_id IS NOT NULL OR is_feed_freight) END))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0127 ?? {};
  const inner = JSON.parse(JSON.stringify(s.prev));
  for (const h of findAll(inner, 'definers')) if (Array.isArray(h.definers)) h.definers = h.definers.filter((d) => !NEW_DEFINERS.includes(d)).map(unwiden);
  for (const h of findAll(inner, 'table_grants')) if (Array.isArray(h.table_grants)) h.table_grants = h.table_grants.filter((g) => !NEW_RELATIONS.includes(String(g).split(':')[0]));
  for (const h of findAll(inner, 'fin_tables')) if (Array.isArray(h.fin_tables)) h.fin_tables = h.fin_tables.filter((t) => !NEW_RELATIONS.includes(t));
  for (const h of findAll(inner, 'views')) {
    if (Array.isArray(h.views)) h.views = h.views.map(viewBack);
    else if (h.views && typeof h.views === 'object') for (const k of Object.keys(h.views)) h.views[k] = viewBack(h.views[k]);
  }
  for (const h of findAll(inner, 'functions')) {
    if (Array.isArray(h.functions)) h.functions = h.functions.map((f) => {
      if (typeof f !== 'string') return f;
      const back = unwiden(f);
      const name = back.split('(')[0];
      return OLD_BODY[name] && back !== f ? back.replace(/[0-9a-f]{32}$/, bodyMd5(ctx.repo, OLD_BODY[name], name)) : back;
    });
  }
  const out = prev.evaluate(inner, { ...ctx, deploymentCheck: false }).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const ledger = a.ledger ?? {};
  check('0125 / 0126 / 0127 ledger rows = repository files (name + full sha256)',
    Object.entries(MIGRATIONS).every(([v, f]) => ledger[v] === `${f}|${shaOf(ctx.repo, f)}`), JSON.stringify(ledger).slice(0, 200));
  check('0125–0127 SECURITY DEFINER: exactly +10 new identities, the four widened ones replace their old identities',
    NEW_DEFINERS.every((d) => realDefiners.includes(d)) && Object.keys(WIDENED).every((d) => realDefiners.includes(d)) && Object.values(WIDENED).every((d) => !realDefiners.includes(d)),
    `missing=[${[...NEW_DEFINERS, ...Object.keys(WIDENED)].filter((d) => !realDefiners.includes(d)).join(' ')}] old=[${Object.values(WIDENED).filter((d) => realDefiners.includes(d)).join(' ')}]`);
  const expectedFns = FUNCTIONS.map(([sig, def, cfg, priv, v]) => `${sig}|${def}|postgres|${cfg}|${priv}|${bodyMd5(ctx.repo, MIGRATIONS[v], sig.split('(')[0])}`).sort();
  check('0125–0127 functions: one overload each, EXECUTE authenticated only (no anon / service_role), bodies as in their migration',
    eq(a.functions, expectedFns), JSON.stringify((a.functions ?? []).filter((f) => !expectedFns.includes(f))).slice(0, 400));
  check('0125–0127 tables: RLS on, SELECT for authenticated only, one SELECT policy each; the allocation sequence without API privilege',
    eq(a.tables, TABLES) && eq(a.policies, POLICIES), JSON.stringify([a.tables, a.policies]));
  check('0125–0127 views: the new ones and the re-created feed_formula_line_safe / pnl_line_item as in their migration, owner postgres, SELECT authenticated only',
    eq(Object.keys(a.views ?? {}).sort(), Object.keys(VIEWS).sort()) && Object.entries(VIEWS).every(([n, v]) => a.views[n] === v),
    JSON.stringify(Object.entries(a.views ?? {}).filter(([n, v]) => VIEWS[n] !== v)));
  check('0125 / 0126 columns: section (MACRO by default), comment, standard batch (200), inactive_from, notes, feed ingredient / freight role',
    eq(a.columns, COLUMNS), JSON.stringify(a.columns));
  check('0126 the P&L by consumption starts on 2026-11-01', a.cost_start === '2026-11-01', String(a.cost_start));
  if (ctx.deploymentCheck) check('0125–0127 deployment: nothing written (no close, kg, freight split, tag or feed category)', Number(a.rows) === 0, String(a.rows));
  return out;
}
