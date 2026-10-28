/**
 * Verification profile ADR025_POST_0106 — the exact database state after target migrations 0001…0106
 * (0106, ADR-026 pending expenses: expense_payable / expense_payable_payment (RLS, ADMIN SELECT, immutable); the casual-purchase
 * rule "paid OR pending" (chk_purchases_supplier_unpaid + the deferred constraint trigger trg_purchases_casual_settlement) in place
 * of chk_purchases_casual_paid; register_pending_expense / pay_pending_expense (DEFINER, ADMIN); fin_expense_payables /
 * fin_expense_payable_payments; WhatsApp PENDING_EXPENSE drafts (wa_propose / wa_correct / wa_confirm wrapped again, the 0103
 * bodies moved to wa.*_0103; wa.validate_payload / wa.dispatch wrapped).
 *
 * The whole 0001…0105 state is verified by ADR025_POST_0105. Removed from it before evaluating, and checked here exactly instead:
 * the two new SECURITY DEFINER identities (D), the grants of the two new fin_% views (K), the purchases CHECK list of the ADR-019
 * model (S: translated back to its 0088 value; the 0106 list is checked below), the public.wa_* entry points and the wa function
 * set (0103 checks: bodies changed by the 0106 wrappers). A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0105.mjs';

export const NAME = 'ADR025_POST_0106';
export const THROUGH = '0106';
const MIGRATION = '0106_pending_expenses.sql';
const NEW_DEFINERS = ['pay_pending_expense(uuid,numeric,date,uuid,payment_method,character varying,text)',
  'register_pending_expense(date,numeric,numeric,uuid,character varying,purchase_nature,character varying,date,character varying,jsonb,jsonb,jsonb,text,text)'];
const NEW_VIEWS = ['fin_expense_payable_payments', 'fin_expense_payables'];
const CHECKS_0088 = '"purchases":"chk_purchases_casual_paid,chk_purchases_counterparty"';
const CHECKS_0106 = '"purchases":"chk_purchases_counterparty"';   // the S query lists only the 0088 names: chk_purchases_casual_paid is gone
const ENTRY_POINTS = ["wa_cancel(bigint,uuid,integer)|true|postgres|search_path=public, pg_temp|falsetruefalse|36b00d25cbd361972c93dd3263245d5e","wa_confirm(bigint,uuid,integer)|true|postgres|search_path=public, pg_temp|falsetruefalse|9f41db8a1aad59110557ded781d8febd","wa_context(bigint)|true|postgres|search_path=public, pg_temp|falsetruefalse|6a63e948aa988fd6d9e50c2b01e6833d","wa_correct(bigint,uuid,integer,jsonb)|true|postgres|search_path=public, pg_temp|falsetruefalse|b489668d5affcf9a6cd2b057bb7c934d","wa_expire()|true|postgres|search_path=public, pg_temp|falsetruefalse|b6418417e9847010f9b55a2e0f0dcb25","wa_ingest(text,text)|true|postgres|search_path=public, pg_temp|falsetruefalse|8fb4ebbf3f2ca3b469010da5dc7ec3d9","wa_link_mp(bigint,uuid,integer,text)|true|postgres|search_path=public, pg_temp|falsetruefalse|3565711316fe4bc8b3ff1d17dd214b82","wa_media_reader()|true|postgres|search_path=public, pg_temp|falsetruefalse|18f422c5ae4d16d7911ecd900855d034","wa_media_writer()|true|postgres|search_path=public, pg_temp|falsetruefalse|845fb893586fb47efb8bb77b9052d005","wa_propose(bigint,text,jsonb)|true|postgres|search_path=public, pg_temp|falsetruefalse|97fc02c6d69b5ee68a0f83f9e91e6c2d","wa_store_media(bigint,text,text,bigint)|true|postgres|search_path=public, pg_temp|falsetruefalse|c39707f788d2d1faf1bafddd6b8eab3d"];
const WA_FUNCTIONS = "32|7|0|postgres|92e2429c61d82712c44d4fe6627ba904";
const WA_DEFINERS = ["wa.confirm_0102(bigint,uuid,integer)","wa.confirm_0103(bigint,uuid,integer)","wa.correct_0102(bigint,uuid,integer,jsonb)","wa.correct_0103(bigint,uuid,integer,jsonb)","wa.ingest_0102(text,text)","wa.propose_0102(bigint,text,jsonb)","wa.propose_0103(bigint,text,jsonb)"];
const FUNCTIONS = ["expense_payable_paid(uuid)|false|postgres|search_path=public|falsetruefalse|a2fa26264079605a7d84467b38256ce0","pay_pending_expense(uuid,numeric,date,uuid,payment_method,character varying,text)|true|postgres|search_path=public|falsetruefalse|19762d1a48082a295fc515963b2ce474","purchase_casual_settlement_check()|false|postgres|search_path=public|falsefalsefalse|2093295fb896b40476e18708fd586783","register_pending_expense(date,numeric,numeric,uuid,character varying,purchase_nature,character varying,date,character varying,jsonb,jsonb,jsonb,text,text)|true|postgres|search_path=public|falsetruefalse|2608e45eb4897e5a0818eb08fe524aaf"];
const VIEWS = ["fin_expense_payable_payments:b86123dff7d1942f07c029856da5198d:{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}","fin_expense_payables:8719e2f8011974601ad25833d77e5bb3:{security_invoker=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}"];
const TABLES = ["expense_payable:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}","expense_payable_payment:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}"];
const POLICIES = ["expense_payable:expense_payable_admin_select:SELECT:(current_app_role() = 'ADMIN'::text)","expense_payable_payment:expense_payable_payment_admin_select:SELECT:(current_app_role() = 'ADMIN'::text)"];
const TRIGGERS = ["trg_expense_payable_immutable:expense_payable:O:27:falsefalse:fin_evidence_immutable_guard","trg_expense_payable_payment_immutable:expense_payable_payment:O:27:falsefalse:fin_evidence_immutable_guard","trg_purchases_casual_settlement:purchases:O:21:truetrue:purchase_casual_settlement_check"];
const PURCHASE_CHECKS = "chk_purchases_counterparty=CHECK (((counterparty_name IS NULL) OR ((supplier_id IS NULL) AND ((counterparty_name)::text = btrim((counterparty_name)::text)) AND ((counterparty_name)::text <> ''::text)))) ; chk_purchases_supplier_unpaid=CHECK (((supplier_id IS NULL) OR (paid_operation_id IS NULL)))";
const DRAFT_TYPES = "CHECK ((type = ANY (ARRAY['CASUAL_EXPENSE'::text, 'CASUAL_WITH_INVOICE'::text, 'SUPPLIER_CREDIT_PURCHASE'::text, 'SUPPLIER_PURCHASE_WITH_INVOICE'::text, 'VAT_ONLY_DOCUMENT'::text, 'PENDING_EXPENSE'::text])))";

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const fnRow = `p.oid::regprocedure::text || '|' || prosecdef || '|' || pg_get_userbyid(proowner) || '|' || coalesce(array_to_string(proconfig, ','), '') || '|'
  || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE')
  || '|' || md5(replace(prosrc, E'\\r', ''))`;

export function innerJson(sql) {
  const m = /^SELECT ([\s\S]*)::text;$/.exec(sql.trim());
  if (!m) throw new Error(`profile ${NAME}: unexpected query shape of the previous profile`);
  return m[1];
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0106', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0106'),
    'entry_points', (SELECT coalesce(json_agg(${fnRow} ORDER BY p.oid::regprocedure::text), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\\_%'),
    'wa_functions', (SELECT count(*) || '|' || count(*) FILTER (WHERE prosecdef) || '|'
                       || count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))
                       || '|' || coalesce(string_agg(DISTINCT pg_get_userbyid(proowner), ','), '') || '|'
                       || coalesce(md5(string_agg(p.oid::regprocedure::text || ':' || prosecdef || ':' || coalesce(array_to_string(proconfig, ','), '') || ':' || md5(replace(prosrc, E'\\r', '')), ',' ORDER BY p.oid::regprocedure::text)), '')
                      FROM pg_proc p WHERE pronamespace = to_regnamespace('wa')),
    'wa_definers', (SELECT coalesce(json_agg(p.oid::regprocedure::text ORDER BY 1), '[]') FROM pg_proc p WHERE pronamespace = to_regnamespace('wa') AND prosecdef),
    'functions', (SELECT coalesce(json_agg(${fnRow} ORDER BY p.oid::regprocedure::text), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace
                    AND proname IN ('register_pending_expense', 'pay_pending_expense', 'expense_payable_paid', 'purchase_casual_settlement_check')),
    'views', (SELECT coalesce(json_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
               FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${NEW_VIEWS.map(lit).join(', ')})),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('expense_payable', 'expense_payable_payment')),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') ORDER BY tablename), '[]')
                  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('expense_payable', 'expense_payable_payment')),
    'triggers', (SELECT coalesce(json_agg(tgname || ':' || tgrelid::regclass || ':' || tgenabled::text || ':' || tgtype || ':' || tgdeferrable || tginitdeferred || ':' || tgfoid::regproc ORDER BY tgname), '[]')
                  FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_expense_payable_immutable', 'trg_expense_payable_payment_immutable', 'trg_purchases_casual_settlement')),
    'purchase_checks', (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' ; ' ORDER BY conname) FROM pg_constraint
                         WHERE conrelid = 'public.purchases'::regclass AND contype = 'c' AND conname LIKE 'chk_purchases_%'),
    'draft_types', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'wa.draft'::regclass AND conname = 'draft_type_check'),
    'unsettled', (SELECT count(*) FROM purchases p WHERE p.supplier_id IS NULL AND p.paid_operation_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM expense_payable e WHERE e.purchase_root_id = purchase_chain_root(p.id))),
    'activity', (SELECT 'payables=' || (SELECT count(*) FROM expense_payable) || '|payments=' || (SELECT count(*) FROM expense_payable_payment)))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0106 ?? {};
  // the 0105 state as the earlier profiles knew it: without the 0106 definers / views, the ADR-019 CHECK list of 0088
  const inner = JSON.parse(JSON.stringify(s.prev).split(CHECKS_0106).join(CHECKS_0088));
  const base = inner.prev.prev.prev.prev;
  base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  base.table_grants = base.table_grants.filter((g) => !NEW_VIEWS.includes(g.split(':')[0]));
  const replaced = ['A ledger ', '0103 entry points:', '0103 wa functions:'];
  const out = prev.evaluate(inner, ctx).filter((c) => !replaced.some((r) => c.label.startsWith(r)));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = s.prev.prev.prev.prev.prev;
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0106 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0106 SECURITY DEFINER: exactly +2 (register_pending_expense, pay_pending_expense)', NEW_DEFINERS.every((d) => real.definers.includes(d)),
    `missing=[${NEW_DEFINERS.filter((d) => !real.definers.includes(d)).join(' ')}]`);
  check('0106 grants of the new fin_% views: SELECT for authenticated only',
    JSON.stringify(real.table_grants.filter((g) => NEW_VIEWS.includes(g.split(':')[0]))) === JSON.stringify(NEW_VIEWS.map((x) => `${x}:authenticated:SELECT`)),
    real.table_grants.filter((g) => NEW_VIEWS.includes(g.split(':')[0])).join(' '));
  check('0106 entry points: the 11 public.wa_*, DEFINER, owner postgres, search_path = public, pg_temp, EXECUTE authenticated only; wa_propose / wa_correct / wa_confirm as in 0106',
    JSON.stringify(a.entry_points) === JSON.stringify(ENTRY_POINTS), JSON.stringify(a.entry_points));
  check('0106 wa functions: 32, no API EXECUTE, owner postgres; DEFINER only the moved 0102 / 0103 entry-point bodies',
    a.wa_functions === WA_FUNCTIONS && JSON.stringify(a.wa_definers) === JSON.stringify(WA_DEFINERS), `${a.wa_functions} ${JSON.stringify(a.wa_definers)}`);
  check('0106 functions: register / pay DEFINER (EXECUTE authenticated only); helpers INVOKER; bodies as in 0106',
    JSON.stringify(a.functions) === JSON.stringify(FUNCTIONS), JSON.stringify(a.functions));
  check('0106 tables expense_payable / expense_payable_payment: RLS on, SELECT for authenticated only; one ADMIN SELECT policy each',
    JSON.stringify(a.tables) === JSON.stringify(TABLES) && JSON.stringify(a.policies) === JSON.stringify(POLICIES), JSON.stringify([a.tables, a.policies]));
  check('0106 views fin_expense_payables / fin_expense_payable_payments: security_invoker, owner postgres, SELECT authenticated only, as in 0106',
    JSON.stringify(a.views) === JSON.stringify(VIEWS), JSON.stringify(a.views));
  check('0106 triggers: both obligation tables immutable; the casual "paid OR pending" rule deferred to commit',
    JSON.stringify(a.triggers) === JSON.stringify(TRIGGERS), JSON.stringify(a.triggers));
  check('0106 purchases CHECKs: counterparty + "a supplier purchase has no payment operation" (chk_purchases_casual_paid replaced)',
    a.purchase_checks === PURCHASE_CHECKS, String(a.purchase_checks));
  check('0106 wa.draft types include PENDING_EXPENSE', a.draft_types === DRAFT_TYPES, String(a.draft_types));
  check('0106 no casual purchase is neither paid nor pending', String(a.unsettled) === '0', String(a.unsettled));
  if (ctx.deploymentCheck) check('DEPLOYMENT CHECK 0106: no pending expense and no payment yet', a.activity === 'payables=0|payments=0', String(a.activity));
  return out;
}
