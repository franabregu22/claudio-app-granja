/**
 * Verification profile ADR025_POST_0130 — the exact database state after target migrations 0001…0130 (alimento-balanceado-v1):
 *   0130 reverse the payment of an expense without supplier: table expense_payment_reversal, RPC reverse_expense_payment (DEFINER),
 *        trigger trg_epsl_reversal_guard (expense_payable_link_reversal_guard) on expense_payable_supplier_link; re-created with the same
 *        identity: expense_payable_paid (0106 body + reversal filter), fin_movement_class (0114 body + «Reversión de pago»),
 *        fin_cash_flow (0122 body: the reversal is an EGRESO of the same expense).
 *
 * The whole 0001…0129 state is verified by ADR025_POST_0129; before evaluating it the new objects are taken out and the three
 * re-created bodies are translated back to what the previous profiles pinned. The 0130 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0129.mjs';

export const NAME = 'ADR025_POST_0130';
export const THROUGH = '0130';
const MIGRATION = '0130_gastos_revertir_pago.sql';
const RPC = 'reverse_expense_payment(uuid,bigint,text,character varying)';
const NEW_MARKERS = ['expense_payment_reversal', 'trg_epsl_reversal_guard', 'expense_payable_link_reversal_guard', 'reverse_expense_payment('];
/** re-created function → the migration whose body the previous profiles pinned */
const OLD_BODY = { expense_payable_paid: '0106_pending_expenses.sql', fin_movement_class: '0114_fin_statement_charges.sql', fin_cash_flow: '0122_caja_flujo_de_caja.sql' };

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
/** The md5 of a function body as pg_proc.prosrc stores it (the last definition of that name in the file). */
function bodyMd5(repo, file, fn) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', file), 'utf8').replace(/\r/g, '');
  const re = /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g;
  let m; let last = 'missing';
  while ((m = re.exec(text))) if (m[1] === fn) last = createHash('md5').update(m[2]).digest('hex');
  return last;
}
/** Walks the previous profile's result: drops every string naming a 0130 object, translates re-created bodies back. */
function back(node, repo, nuevos) {
  if (Array.isArray(node)) {
    return node.filter((x) => !(typeof x === 'string' && NEW_MARKERS.some((k) => x.includes(k)))).map((x) => back(x, repo, nuevos));
  }
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) {
      if (NEW_MARKERS.some((m) => k.includes(m))) continue;
      o[k] = back(v, repo, nuevos);
    }
    return o;
  }
  if (typeof node === 'string') {
    for (const [fn, md5] of Object.entries(nuevos)) {
      if (node.includes(md5) && node.includes(`${fn}(`)) return node.replace(md5, bodyMd5(repo, OLD_BODY[fn], fn));
      if (node === md5) return bodyMd5(repo, OLD_BODY[fn], fn);
    }
  }
  return node;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0130', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0130'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.proname), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('reverse_expense_payment', 'expense_payable_link_reversal_guard', 'expense_payable_paid', 'fin_movement_class', 'fin_cash_flow')),
    'table', (SELECT c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') FROM pg_class c WHERE c.oid = to_regclass('public.expense_payment_reversal')),
    'sequence', (SELECT coalesce(c.relacl::text, 'NULL') FROM pg_class c WHERE c.oid = to_regclass('public.expense_payment_reversal_id_seq')),
    'policies', (SELECT coalesce(json_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') ORDER BY policyname), '[]') FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'expense_payment_reversal'),
    'triggers', (SELECT coalesce(json_agg(c.relname || ':' || t.tgname || ':' || t.tgfoid::regprocedure::text ORDER BY c.relname, t.tgname), '[]')
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal
         AND (c.relname = 'expense_payment_reversal' OR t.tgname = 'trg_epsl_reversal_guard')),
    'rows', (SELECT CASE WHEN to_regclass('public.expense_payment_reversal') IS NULL THEN NULL ELSE (SELECT count(*) FROM expense_payment_reversal) END))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0130 ?? {};
  const nuevos = Object.fromEntries(Object.keys(OLD_BODY).map((fn) => [fn, bodyMd5(ctx.repo, MIGRATION, fn)]));
  const inner = back(JSON.parse(JSON.stringify(s.prev)), ctx.repo, nuevos);
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check('0130 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const want = [
    `expense_payable_link_reversal_guard()|false|postgres|search_path=public|falsefalsefalse|${bodyMd5(ctx.repo, MIGRATION, 'expense_payable_link_reversal_guard')}`,
    `expense_payable_paid(uuid)|false|postgres|search_path=public|falsetruefalse|${nuevos.expense_payable_paid}`,
    `fin_cash_flow(date,date,text)|true|postgres|search_path=public, pg_temp|falsetruefalse|${nuevos.fin_cash_flow}`,
    `fin_movement_class(text,text)|false|postgres|search_path=public, pg_temp|falsefalsefalse|${nuevos.fin_movement_class}`,
    `${RPC}|true|postgres|search_path=public, pg_temp|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, 'reverse_expense_payment')}`,
  ];
  check('0130 functions: the RPC DEFINER (EXECUTE authenticated only), the guard no API EXECUTE, the three re-created ones keep their identity / rights; bodies as in 0130',
    eq(a.functions, want), JSON.stringify((a.functions ?? []).filter((f) => !want.includes(f))).slice(0, 500));
  check('0130 expense_payment_reversal: RLS on, SELECT for authenticated only, one ADMIN SELECT policy, the sequence without API privilege',
    a.table === 'true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}' && a.sequence === '{postgres=rwU/postgres}'
      && eq(a.policies, [`expense_payment_reversal_admin_select:SELECT:(current_app_role() = 'ADMIN'::text)`]),
    JSON.stringify([a.table, a.sequence, a.policies]));
  check('0130 triggers: the reversal row immutable; a payable with a reversed payment never linked to a supplier',
    eq(a.triggers, ['expense_payable_supplier_link:trg_epsl_reversal_guard:expense_payable_link_reversal_guard()',
      'expense_payment_reversal:trg_expense_payment_reversal_immutable:fin_evidence_immutable_guard()']), JSON.stringify(a.triggers));
  if (ctx.deploymentCheck) check('0130 deployment: nothing reversed yet', Number(a.rows) === 0, String(a.rows));
  return out;
}
