/**
 * Verification profile ADR025_POST_0111 — the exact database state after target migrations 0001…0111
 * (0111, Lote 4: Factura A receiver / issuer CUIT markers on WhatsApp drafts; a casual purchase paid with Mercado Pago recognised at
 * confirmation and its movement linked later — purchase_mp_link / purchase_mp_settlement, register_casual_purchase_mp_pending,
 * settle_purchase_mp (ADR-021 §2.3(c), route PURCHASE_MP_LINK), fin_purchase_mp_link, fin_mp_report_activity re-created, the
 * amended purchase_casual_settlement_check, the non-blocking monthly-close warning; wa_confirm / wa_correct / wa.dispatch /
 * wa.validate_payload wrapped again).
 *
 * The whole 0001…0110 state is verified by ADR025_POST_0110. Its expectations that change with 0111 are translated back before
 * evaluating it (and checked here exactly instead): the three new SECURITY DEFINER identities (D), the grants of the new view /
 * tables (K), the fin_mp_report_activity definition (P / X ADR-024), the wa_confirm / wa_correct entry points (0102 / 0104 / 0106),
 * the wa function inventory (0102 / 0104 / 0106), the purchase_casual_settlement_check body (0106 / 0107) and the 0106 data check
 * "no casual purchase is neither paid nor pending" (a purchase paid with Mercado Pago awaiting its movement is settled by its link).
 * A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0110.mjs';

export const NAME = 'ADR025_POST_0111';
export const THROUGH = '0111';
const MIGRATION = '0111_wa_invoice_receiver_mp_link.sql';
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const NEW_DEFINERS = ['management_period_mp_link_warning()',
  'register_casual_purchase_mp_pending(date,numeric,numeric,uuid,character varying,purchase_nature,character varying,uuid,character varying,jsonb,jsonb,jsonb,text,jsonb,text)',
  'settle_purchase_mp(uuid,text,character varying,text)'];
const NEW_RELATIONS = ['fin_purchase_mp_link', 'purchase_mp_link', 'purchase_mp_settlement'];
// before 0111 → after 0111 (the 0110 values, exactly as POST_0110 expects them)
const ACTIVITY = ['cf60b21e7f34a86db23e21d3e61d1a02', '5ea661403a157dae343d022d774abe38'];
const ENTRY = [
  ['wa_confirm(bigint,uuid,integer)|true|postgres|search_path=public, pg_temp|falsetruefalse|9f41db8a1aad59110557ded781d8febd',
   'wa_confirm(bigint,uuid,integer)|true|postgres|search_path=public, pg_temp|falsetruefalse|b11d8c590b3c0c9c7e5287af095e6d80'],
  ['wa_correct(bigint,uuid,integer,jsonb)|true|postgres|search_path=public, pg_temp|falsetruefalse|b489668d5affcf9a6cd2b057bb7c934d',
   'wa_correct(bigint,uuid,integer,jsonb)|true|postgres|search_path=public, pg_temp|falsetruefalse|6b5dd85ae431454af5756464954781a0'],
  ['purchase_casual_settlement_check()|true|postgres|search_path=public, pg_temp|falsefalsefalse|2093295fb896b40476e18708fd586783',
   'purchase_casual_settlement_check()|true|postgres|search_path=public, pg_temp|falsefalsefalse|d999bfa078858c9e5a9e038a8700a346']];
const WA_FUNCTIONS = ['32|7|0|postgres|92e2429c61d82712c44d4fe6627ba904', '36|9|0|postgres|2b03b4589977bcb96bd2631fe4edc0e2'];
const NEW_WA_DEFINERS = ['wa.confirm_0106(bigint,uuid,integer)', 'wa.correct_0106(bigint,uuid,integer,jsonb)'];
// 0111 exactly
const FN_NAMES = ['register_casual_purchase_mp_pending', 'settle_purchase_mp', 'management_period_mp_link_warning', 'purchase_casual_settlement_check'];
const WA_FN = ['validate_payload', 'validate_payload_0106', 'dispatch', 'dispatch_0106', 'confirm_0106', 'correct_0106'];
const FUNCTIONS = [
  'management_period_mp_link_warning()|true|postgres|search_path=public, pg_temp|falsefalsefalse|646a70586edb881abbeb8969f7025e48',
  'purchase_casual_settlement_check()|true|postgres|search_path=public, pg_temp|falsefalsefalse|d999bfa078858c9e5a9e038a8700a346',
  'register_casual_purchase_mp_pending(date,numeric,numeric,uuid,character varying,purchase_nature,character varying,uuid,character varying,jsonb,jsonb,jsonb,text,jsonb,text)|true|postgres|search_path=public|falsetruefalse|d921527140e6f5b091c4ab92848ee46c',
  'settle_purchase_mp(uuid,text,character varying,text)|true|postgres|search_path=public|falsetruefalse|224197836b6de114a1af3a81a226748b'];
const WA_FUNCTIONS_0111 = [
  'wa.confirm_0106(bigint,uuid,integer)|true|postgres|search_path=public, pg_temp|falsefalsefalse|9f41db8a1aad59110557ded781d8febd',
  'wa.correct_0106(bigint,uuid,integer,jsonb)|true|postgres|search_path=public, pg_temp|falsefalsefalse|b489668d5affcf9a6cd2b057bb7c934d',
  'wa.dispatch(wa.draft,text)|false|postgres|search_path=public, pg_temp|falsefalsefalse|e423d89e60d077c6f97ea1d658499fe3',
  'wa.dispatch_0106(wa.draft,text)|false|postgres|search_path=public, pg_temp|falsefalsefalse|4066c9c3e85afca84ad76a1b5e4d1793',
  'wa.validate_payload(text,jsonb)|false|postgres|search_path=public, pg_temp|falsefalsefalse|64ef5fab3be92aa8e543e1d3ef82f0c0',
  'wa.validate_payload_0106(text,jsonb)|false|postgres|search_path=public, pg_temp|falsefalsefalse|c66773c7eed84f99d2a2656dbf0c2108'];
const ENTRY_0111 = [
  'wa_confirm(bigint,uuid,integer)|true|postgres|search_path=public, pg_temp|falsetruefalse|b11d8c590b3c0c9c7e5287af095e6d80',
  'wa_correct(bigint,uuid,integer,jsonb)|true|postgres|search_path=public, pg_temp|falsetruefalse|6b5dd85ae431454af5756464954781a0'];
const TABLES = [
  'purchase_mp_link:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}',
  'purchase_mp_settlement:truefalse:{postgres=arwdDxtm/postgres,authenticated=r/postgres}'];
const POLICIES = [
  'purchase_mp_link:purchase_mp_link_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5',
  'purchase_mp_settlement:purchase_mp_settlement_admin_select:SELECT:public:abd3a72daa4033be6b6864a7b2948bd5'];
const TRIGGERS = [
  'management_period:trg_expense_pending_close_guard:expense_pending_close_guard():O',
  'management_period:trg_management_period_close_guard:management_period_close_guard():O',
  'management_period:trg_management_period_mp_link_warning:management_period_mp_link_warning():O',
  'purchase_mp_link:trg_purchase_mp_link_immutable:fin_evidence_immutable_guard():O',
  'purchase_mp_settlement:trg_purchase_mp_settlement_immutable:fin_evidence_immutable_guard():O',
  'purchases:trg_expense_pending_purchase:expense_pending_integrity():O',
  'purchases:trg_purchases_casual_settlement:purchase_casual_settlement_check():O',
  'purchases:trg_purchases_category_selectable:expense_category_selectable_guard():O'];
const VIEWS = [
  'fin_mp_report_activity:5ea661403a157dae343d022d774abe38:{security_invoker=false}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}',
  'fin_purchase_mp_link:f9cef55521a9f3d81026965ed8fa436c:{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}'];
const COLUMNS = [
  'fin_purchase_mp_link:purchase_root_id,purchase_id,economic_date,amount_total,concept,counterparty_name,category_name,fiscal_document_id,origin,origin_code,created_at,status,source_id,movement_date,financial_operation_id,linked_at,age_days,candidates',
  'purchase_mp_link:purchase_root_id,mp_account_id,origin,origin_ref,idempotency_key,reason,created_by,created_at',
  'purchase_mp_settlement:id,purchase_root_id,purchase_id,source_id,mp_financial_movement_id,financial_operation_id,economic_date,movement_date,amount,idempotency_key,reason,result,created_by,created_at'];
const ROUTE = "CHECK (((route)::text = ANY ((ARRAY['CASUAL_PURCHASE'::character varying, 'EXPENSE'::character varying, 'SUPPLIER_PAYMENT'::character varying, 'OWNER_WITHDRAWAL'::character varying, 'OWN_TRANSFER'::character varying, 'PURCHASE_MP_LINK'::character varying])::text[])))";
const SEQUENCES = [
  'purchase_mp_settlement_id_seq:{postgres=rwU/postgres}'];

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
const FN_ROW = (schema, names) => `(SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
    || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
    || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
    FROM pg_proc p WHERE p.pronamespace = '${schema}'::regnamespace AND p.proname IN (${names.map(lit).join(', ')})) q)`;

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0111', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0111'),
    'functions', ${FN_ROW('public', FN_NAMES)},
    'wa_functions', ${FN_ROW('wa', WA_FN)},
    'entry', ${FN_ROW('public', ['wa_confirm', 'wa_correct'])},
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN ('purchase_mp_link', 'purchase_mp_settlement')),
    'sequences', (SELECT coalesce(json_agg(c.relname || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S' AND c.relname LIKE 'purchase_mp_%'),
    'policies', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || md5(coalesce(qual, '')) AS t
                   FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('purchase_mp_link', 'purchase_mp_settlement')) q),
    'column_writes', (SELECT count(*) FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name IN ('purchase_mp_link', 'purchase_mp_settlement')
                        AND grantee IN ('anon', 'authenticated', 'service_role') AND privilege_type <> 'SELECT'),
    'triggers', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT tgrelid::regclass::text || ':' || tgname || ':' || tgfoid::regprocedure::text || ':' || tgenabled::text AS t FROM pg_trigger
                   WHERE NOT tgisinternal AND tgrelid IN ('public.purchase_mp_link'::regclass, 'public.purchase_mp_settlement'::regclass, 'public.management_period'::regclass, 'public.purchases'::regclass)) q),
    'views', (SELECT coalesce(json_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('fin_purchase_mp_link', 'fin_mp_report_activity')),
    'columns', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT table_name || ':' || string_agg(column_name, ',' ORDER BY ordinal_position) AS t
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('fin_purchase_mp_link', 'purchase_mp_link', 'purchase_mp_settlement') GROUP BY table_name) q),
    'route', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_mpor_route'),
    'mp_pending_unpaid', (SELECT count(*) FROM purchases p WHERE p.is_current AND p.supplier_id IS NULL AND p.paid_operation_id IS NULL
                           AND EXISTS (SELECT 1 FROM purchase_mp_link l WHERE l.purchase_root_id = purchase_chain_root(p.id))
                           AND NOT EXISTS (SELECT 1 FROM expense_payable e WHERE e.purchase_root_id = purchase_chain_root(p.id))),
    'links', (SELECT count(*) FROM purchase_mp_link), 'settlements', (SELECT count(*) FROM purchase_mp_settlement),
    'link_audits', (SELECT count(*) FROM audit_events WHERE action IN ('CREATE_MP_PENDING_PURCHASE', 'SETTLE_MP', 'CLOSE_WITH_MP_LINK_PENDING')),
    'mp_link_routes', (SELECT count(*) FROM mp_pending_outflow_resolution WHERE route = 'PURCHASE_MP_LINK'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0111 ?? {};
  // the 0110 state as POST_0110 knows it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const tg = find(inner, 'table_grants');
  if (tg) tg.table_grants = tg.table_grants.filter((g) => !NEW_RELATIONS.includes(g.split(':')[0]));
  each(inner, (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (v === ACTIVITY[1]) o[k] = ACTIVITY[0];
        else if (v.includes(`fin_mp_report_activity:${ACTIVITY[1]}:`)) o[k] = v.replace(`fin_mp_report_activity:${ACTIVITY[1]}:`, `fin_mp_report_activity:${ACTIVITY[0]}:`);
        else if (v === WA_FUNCTIONS[1]) o[k] = WA_FUNCTIONS[0];
        else for (const [before, now] of ENTRY) if (v === now) o[k] = before;
      } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        let arr = v.map((x) => { for (const [before, now] of ENTRY) if (x === now) return before; return x; });
        if (k === 'wa_definers') arr = arr.filter((x) => !NEW_WA_DEFINERS.includes(x));
        o[k] = arr;
      }
    }
  });
  // 0106 data check: a purchase paid with Mercado Pago awaiting its movement is settled by its link (ADR-019 as amended)
  const d106 = find(inner, 'a0106')?.a0106;
  if (d106 && d106.unsettled != null) d106.unsettled = Number(d106.unsettled) - Number(a.mp_pending_unpaid ?? 0);
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  const realGrants = find(s.prev, 'table_grants')?.table_grants ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check('0111 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0111 SECURITY DEFINER: exactly +3 (register_casual_purchase_mp_pending, settle_purchase_mp, management_period_mp_link_warning)',
    NEW_DEFINERS.every((d) => realDefiners.includes(d)), `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0111 functions: the two ADMIN RPCs DEFINER (EXECUTE authenticated only), the close warning and the settlement check DEFINER with no API EXECUTE; bodies as in 0111',
    eq(a.functions, FUNCTIONS), JSON.stringify(a.functions));
  check('0111 WhatsApp: wa_confirm / wa_correct wrappers (DEFINER, EXECUTE authenticated only) and wa.validate_payload / wa.dispatch wrappers + the moved 0106 bodies (no API EXECUTE); as in 0111',
    eq(a.entry, ENTRY_0111) && eq(a.wa_functions, WA_FUNCTIONS_0111), JSON.stringify([a.entry, a.wa_functions]));
  check('0111 tables purchase_mp_link / purchase_mp_settlement: RLS on, SELECT for authenticated only, no column write, one ADMIN SELECT policy each; sequence without API privilege',
    eq(a.tables, TABLES) && eq(a.policies, POLICIES) && Number(a.column_writes) === 0 && eq(a.sequences, SEQUENCES), JSON.stringify([a.tables, a.policies, a.column_writes, a.sequences]));
  check('0111 triggers: both link tables immutable; purchases settlement check (deferred); management_period close guard + the non-blocking MP link warning',
    eq(a.triggers, TRIGGERS), JSON.stringify(a.triggers));
  check('0111 views fin_purchase_mp_link (new, security_invoker) and fin_mp_report_activity (re-created, owner rights + ADMIN filter): definitions, owner, SELECT authenticated only',
    eq(a.views, VIEWS), JSON.stringify(a.views));
  check('0111 columns of fin_purchase_mp_link / purchase_mp_link / purchase_mp_settlement', eq(a.columns, COLUMNS), JSON.stringify(a.columns));
  check('0111 ADR-021 §2.3(c): the resolution route PURCHASE_MP_LINK is accepted', a.route === ROUTE, String(a.route));
  // the grant inventory of the earlier profiles lists the fin_% relations; the two tables' ACL is checked above
  check('0111 grants of the new view fin_purchase_mp_link: SELECT for authenticated only',
    eq(realGrants.filter((g) => NEW_RELATIONS.includes(g.split(':')[0])), ['fin_purchase_mp_link:authenticated:SELECT']),
    realGrants.filter((g) => NEW_RELATIONS.includes(g.split(':')[0])).join(' '));
  if (ctx.deploymentCheck) check('0111 deployment: no MP-pending purchase, no link, no PURCHASE_MP_LINK resolution, no link audit right after the migration',
    [a.links, a.settlements, a.mp_link_routes, a.link_audits].every((x) => Number(x) === 0), `${a.links}|${a.settlements}|${a.mp_link_routes}|${a.link_audits}`);
  return out;
}
