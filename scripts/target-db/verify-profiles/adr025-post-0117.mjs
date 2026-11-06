/**
 * Verification profile ADR025_POST_0117 — the exact database state after target migrations 0001…0117
 * (0117: Gastos — register_paid_supplier_purchase (a supplier expense recorded already paid: purchase + one payment + its
 * allocation), rectify_purchase_details (audited new version of one current purchase), the view fin_purchase_audit and the trigger
 * trg_purchases_allocation_cover with its function purchase_allocation_cover_check).
 *
 * The whole 0001…0116 state is verified by ADR025_POST_0116. 0117 adds three SECURITY DEFINER functions, one view and one trigger
 * and changes no existing object: the new definer identities and the new view in the ADR-018 table lists are translated back before
 * evaluating it; everything 0117 created is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0116.mjs';

export const NAME = 'ADR025_POST_0117';
export const THROUGH = '0117';
const MIGRATION = '0117_expense_paid_supplier_rectify.sql';
const NEW_DEFINERS = [
  'purchase_allocation_cover_check()',
  'rectify_purchase_details(uuid,character varying,uuid,purchase_nature,date,uuid,character varying,numeric,numeric,text,jsonb)',
  'register_paid_supplier_purchase(uuid,date,numeric,uuid,character varying,purchase_nature,character varying,date,payment_method,uuid,character varying,jsonb,jsonb,text)'];
const NEW_RELATIONS = ['fin_purchase_audit'];
const FN_NAMES = ['register_paid_supplier_purchase', 'rectify_purchase_details', 'purchase_allocation_cover_check'];
const FUNCTIONS = [
  'purchase_allocation_cover_check()|true|postgres|search_path=public, pg_temp|falsefalsefalse|@',
  'rectify_purchase_details(uuid,character varying,uuid,purchase_nature,date,uuid,character varying,numeric,numeric,text,jsonb)|true|postgres|search_path=public, pg_temp|falsetruefalse|@',
  'register_paid_supplier_purchase(uuid,date,numeric,uuid,character varying,purchase_nature,character varying,date,payment_method,uuid,character varying,jsonb,jsonb,text)|true|postgres|search_path=public, pg_temp|falsetruefalse|@'];
const VIEW = 'fin_purchase_audit:v:{security_invoker=true}:{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const VIEW_COLUMNS = 'audit_id,purchase_root_id,purchase_id,action,before_values,after_values,reason,performed_by,performed_at';
const TRIGGER = 'trg_purchases_allocation_cover:purchases:O:purchase_allocation_cover_check:AFTER INSERT ROW';

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

/** Every object holding `key`. */
function findAll(o, key, out = []) {
  if (!o || typeof o !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(o, key)) out.push(o);
  for (const v of Object.values(o)) findAll(v, key, out);
  return out;
}

export function buildSql(repo) {
  const IN = (xs) => xs.map((n) => `'${n}'`).join(', ');
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0117', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0117'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${IN(FN_NAMES)})) q),
    'view', (SELECT c.relname || ':' || c.relkind::text || ':' || coalesce(c.reloptions::text, 'NULL') || ':' || coalesce(c.relacl::text, 'NULL')
               FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'fin_purchase_audit'),
    'view_md5', (SELECT md5(pg_get_viewdef('public.fin_purchase_audit'::regclass)) WHERE to_regclass('public.fin_purchase_audit') IS NOT NULL),
    'view_columns', (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fin_purchase_audit'),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tg.tgname || ':' || tg.tgrelid::regclass::text || ':' || tg.tgenabled::text || ':' || p.proname || ':'
        || CASE WHEN tg.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END || ' ' || concat_ws(' OR ', CASE WHEN tg.tgtype & 4 = 4 THEN 'INSERT' END, CASE WHEN tg.tgtype & 16 = 16 THEN 'UPDATE' END, CASE WHEN tg.tgtype & 8 = 8 THEN 'DELETE' END)
        || ' ' || CASE WHEN tg.tgtype & 1 = 1 THEN 'ROW' ELSE 'STATEMENT' END AS t
        FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid WHERE NOT tg.tgisinternal AND p.proname = 'purchase_allocation_cover_check') q),
    'rectify_audits', (SELECT count(*) FROM audit_events WHERE action = 'RECTIFY_DETAILS'),
    'paid_keys', (SELECT count(*) FROM financial_operation WHERE external_ref LIKE 'GASTO-PAGADO:%'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0117 ?? {};
  // the 0116 state as POST_0116 knows it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const tg = find(inner, 'table_grants');
  if (tg) tg.table_grants = tg.table_grants.filter((g) => !NEW_RELATIONS.includes(g.split(':')[0]));
  const ft = find(inner, 'fin_tables');
  if (ft) ft.fin_tables = ft.fin_tables.filter((t) => !NEW_RELATIONS.includes(t));
  // the 0111 trigger pin lists every trigger of purchases: the new one is checked below
  for (const holder of findAll(inner, 'triggers')) {
    if (Array.isArray(holder.triggers)) holder.triggers = holder.triggers.filter((t) => typeof t !== 'string' || !t.includes(':trg_purchases_allocation_cover:'));
  }
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const shape = (xs) => (xs ?? []).map((f) => f.replace(/\|[0-9a-f]{32}$/, '|@'));
  check('0117 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0117 SECURITY DEFINER: exactly +3 (paid supplier expense, rectification, the allocation-cover trigger function)', NEW_DEFINERS.every((d) => realDefiners.includes(d)),
    `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0117 functions: the two RPCs EXECUTE authenticated only, the trigger function no API EXECUTE', eq(shape(a.functions), FUNCTIONS), JSON.stringify(a.functions));
  check('0117 functions: bodies as in 0117 (md5 of the migration text)', eq(a.functions, fileBodies(ctx.repo)), JSON.stringify(a.functions));
  check('0117 view fin_purchase_audit: security_invoker, SELECT for authenticated only, its columns', a.view === VIEW && a.view_columns === VIEW_COLUMNS && /^[0-9a-f]{32}$/.test(String(a.view_md5)),
    `${a.view} · ${a.view_columns}`);
  check('0117 trigger trg_purchases_allocation_cover: enabled, AFTER INSERT on purchases, per row', eq(a.triggers, [TRIGGER]), JSON.stringify(a.triggers));
  if (ctx.deploymentCheck) check('0117 deployment: no rectification and no paid supplier expense right after the migration',
    Number(a.rectify_audits) === 0 && Number(a.paid_keys) === 0, `${a.rectify_audits}|${a.paid_keys}`);
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
