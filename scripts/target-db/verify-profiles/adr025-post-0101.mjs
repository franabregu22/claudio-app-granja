/**
 * Verification profile ADR025_POST_0101 — the exact database state after target migrations 0001…0101
 * (0101, ADR-025: unclassified expenses — expense_pending_classification / expense_pending_resolution immutable, RLS ADMIN SELECT,
 * SELECT for authenticated only; register_unclassified_expense + classify_pending_expense SECURITY DEFINER, EXECUTE authenticated
 * only; expense_pending_integrity (deferred constraint triggers) and expense_pending_close_guard DEFINER with no API EXECUTE;
 * expense_pending_check INVOKER with no API EXECUTE; fin_expense_pending_classification security_invoker; pnl_line_item bucket
 * GASTOS_SIN_CLASIFICAR and pnl_summary column gastos_sin_clasificar).
 *
 * The whole 0001…0100 state is verified by ADR018_POST_0100 itself (same query, same checks, unchanged). Only the two checks
 * that 0101 moves by construction are replaced: A (ledger length / last version → 0101) and D (the SECURITY DEFINER set: the
 * four 0101 identities are checked here and removed before the 0100 exact-set check); the K grant set (relations fin_%) likewise
 * receives the 0101 view fin_expense_pending_classification, checked here and removed before the 0100 exact grant check.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr018-post-0100.mjs';

export const NAME = 'ADR025_POST_0101';
export const THROUGH = '0101';
const MIGRATION = '0101_unclassified_expenses.sql';
const REGISTER = 'register_unclassified_expense(date,numeric,character varying,uuid,payment_method,character varying,character varying,character varying,jsonb,text)';
const CLASSIFY = 'classify_pending_expense(bigint,uuid,purchase_nature,character varying,character varying,text)';
const GRANTS_0101 = ['fin_expense_pending_classification:authenticated:SELECT'];
export const DEFINERS_0101 = [CLASSIFY, 'expense_pending_close_guard()', 'expense_pending_integrity()', REGISTER];
// identity | DEFINER | owner | proconfig | EXECUTE anon / authenticated / service_role | body md5
const FUNCTIONS = [
  `${CLASSIFY}|true|postgres|search_path=public|falsetruefalse|d474c04e7e57c36afd70e554ad826ccc`,
  'expense_pending_check(bigint)|false|postgres|search_path=public|falsefalsefalse|2de08be6849b085604b4c5edf379e59e',
  'expense_pending_close_guard()|true|postgres|search_path=public|falsefalsefalse|bc699c239b9c2811c80e2c6bc5030961',
  'expense_pending_integrity()|true|postgres|search_path=public|falsefalsefalse|41281a506ed47d1f329d99dbdc11920e',
  `${REGISTER}|true|postgres|search_path=public|falsetruefalse|3734abde8bdfc0a2664632a977f01783`,
];
const TRIGGERS = [
  'trg_expense_pending_close_guard:management_period:O:19:falsefalse:expense_pending_close_guard',
  'trg_expense_pending_immutable:expense_pending_classification:O:27:falsefalse:fin_evidence_immutable_guard',
  'trg_expense_pending_operation:financial_operation:O:5:truetrue:expense_pending_integrity',
  'trg_expense_pending_posting:financial_posting:O:5:truetrue:expense_pending_integrity',
  'trg_expense_pending_purchase:purchases:O:5:truetrue:expense_pending_integrity',
  'trg_expense_pending_resolution_immutable:expense_pending_resolution:O:27:falsefalse:fin_evidence_immutable_guard',
  'trg_expense_pending_resolution_row:expense_pending_resolution:O:5:truetrue:expense_pending_integrity',
  'trg_expense_pending_row:expense_pending_classification:O:5:truetrue:expense_pending_integrity',
];
const ACL_READ = '{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const TABLES = [
  `expense_pending_classification:true:expense_pending_admin_select:SELECT:${ACL_READ}`,
  `expense_pending_resolution:true:expense_pending_resolution_admin_select:SELECT:${ACL_READ}`,
];
const SEQUENCES = ['expense_pending_classification_id_seq:{postgres=rwU/postgres}', 'expense_pending_resolution_id_seq:{postgres=rwU/postgres}'];
const VIEWS = [
  `fin_expense_pending_classification:b6fbf0225dd78142d647ccbd0e66cfc6:{security_invoker=true}:postgres:${ACL_READ}`,
  `pnl_line_item:940fd8c46fea5c78bc9f3c6984d61d53:{security_invoker=true}:postgres:${ACL_READ}`,
  `pnl_summary:baef19e93b2dedefa079614fed4bb79c:{security_invoker=true}:postgres:${ACL_READ}`,
];
const PNL_COLUMNS = 'period,ventas_netas_devengadas,costos_directos,costos_indirectos,resultado_operativo,otros_ingresos_financieros,resultado_antes_de_reinversion,reinversion,resultado_post_reinversion,retiros,disponible_post_retiros,reservas_internas,post_reservas,inversiones,resultado_post_inversiones,diferencia_caja,gastos_sin_clasificar';

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');
/** The json_build_object(...) expression of a profile query `SELECT json_build_object(...)::text;`. */
export function innerJson(sql) {
  const m = /^SELECT ([\s\S]*)::text;$/.exec(sql.trim());
  if (!m) throw new Error(`profile ${NAME}: unexpected query shape of the previous profile`);
  return m[1];
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0101', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0101'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || prosecdef || '|' || pg_get_userbyid(proowner) || '|' || coalesce(array_to_string(proconfig, ','), '') || '|'
                     || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || '|' || md5(replace(prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
                   FROM pg_proc p WHERE pronamespace = 'public'::regnamespace
                    AND proname IN ('register_unclassified_expense', 'classify_pending_expense', 'expense_pending_check', 'expense_pending_integrity', 'expense_pending_close_guard')),
    'triggers', (SELECT coalesce(json_agg(tgname || ':' || tgrelid::regclass || ':' || tgenabled::text || ':' || tgtype || ':' || tgdeferrable || tginitdeferred || ':' || tgfoid::regproc ORDER BY tgname), '[]')
                  FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE '%expense\\_pending%' OR tgfoid::regproc::text LIKE 'expense\\_pending%')),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':'
                   || coalesce((SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = c.relname), '')
                   || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'expense\\_pending\\_%'),
    'sequences', (SELECT coalesce(json_agg(c.relname || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                   FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S' AND c.relname LIKE 'expense\\_pending\\_%'),
    'views', (SELECT coalesce(json_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner)
                   || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
               FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('fin_expense_pending_classification', 'pnl_line_item', 'pnl_summary')),
    'pnl_columns', (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pnl_summary'),
    'pnl_bucket', (SELECT pg_get_viewdef('public.pnl_line_item'::regclass) LIKE '%GASTOS_SIN_CLASIFICAR%'),
    'pending_rows', (SELECT count(*) FROM expense_pending_classification) || ':' || (SELECT count(*) FROM expense_pending_resolution))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const p = s.prev;
  const a = s.a0101 ?? {};
  const out = prev.evaluate({ ...p, definers: p.definers.filter((d) => !DEFINERS_0101.includes(d)), table_grants: p.table_grants.filter((g) => !g.startsWith('fin_expense_pending_classification:')) }, ctx)
    .filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: p.ledger_count === ctx.expectedLedger && p.ledger_max === THROUGH, detail: `${p.ledger_count} / ${p.ledger_max}` });
  check('0101 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0101 SECURITY DEFINER: exactly +4 (the two RPCs and the two guard functions; the rest of D is the 0100 set)',
    DEFINERS_0101.every((d) => p.definers.includes(d)), `missing=[${DEFINERS_0101.filter((d) => !p.definers.includes(d)).join(' ')}]`);
  check('0101 grants on fin_expense_pending_classification: SELECT for authenticated only', JSON.stringify(p.table_grants.filter((g) => g.startsWith('fin_expense_pending_classification:'))) === JSON.stringify(GRANTS_0101),
    p.table_grants.filter((g) => g.startsWith('fin_expense_pending_classification:')).join(' '));
  check('0101 functions: owner postgres, search_path=public; RPCs EXECUTE authenticated only; guards / check no API EXECUTE; check INVOKER; bodies as in 0101',
    JSON.stringify(a.functions) === JSON.stringify(FUNCTIONS), JSON.stringify(a.functions));
  check('0101 triggers: two immutability guards, the close guard on management_period, five deferred integrity constraint triggers',
    JSON.stringify(a.triggers) === JSON.stringify(TRIGGERS), JSON.stringify(a.triggers));
  check('0101 tables: RLS, one ADMIN SELECT policy each, SELECT for authenticated only (no write for any API role, nothing for anon / service_role)',
    JSON.stringify(a.tables) === JSON.stringify(TABLES), JSON.stringify(a.tables));
  check('0101 sequences: no API privilege', JSON.stringify(a.sequences) === JSON.stringify(SEQUENCES), JSON.stringify(a.sequences));
  check('0101 views: fin_expense_pending_classification, pnl_line_item, pnl_summary security_invoker, owner postgres, SELECT for authenticated only; definitions as in 0101',
    JSON.stringify(a.views) === JSON.stringify(VIEWS), JSON.stringify(a.views));
  check('0101 P&L: pnl_line_item has the GASTOS_SIN_CLASIFICAR bucket; pnl_summary keeps every column and appends gastos_sin_clasificar',
    a.pnl_bucket === true && a.pnl_columns === PNL_COLUMNS, `bucket=${a.pnl_bucket} columns=${a.pnl_columns}`);
  if (ctx.deploymentCheck) check('DEPLOYMENT CHECK 0101: no unclassified expense and no resolution yet', a.pending_rows === '0:0', String(a.pending_rows));
  return out;
}
