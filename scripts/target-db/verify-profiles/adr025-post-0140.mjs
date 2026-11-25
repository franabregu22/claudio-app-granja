/**
 * Verification profile ADR025_POST_0140 — the exact database state after target migrations 0001…0140 (erp-mejoras):
 *   0140 the Mercado Pago classification cutover (corte_clasificacion_mp() = 2026-12-01: fin_mp_pending_classification,
 *        mp_pending_classification_totals and fin_operation_list re-created — what is pending before it is closed without detail) and the
 *        cash opening by a count (cash_opening_count, register_cash_opening DEFINER, fin_account_balance_on; fin_movement_class re-created
 *        with «Saldo inicial (conteo de caja)»). Nothing written; DEFINER count 180 → 181.
 *
 * The whole 0001…0139 state is verified by ADR025_POST_0139; before evaluating it every 0140 object is taken out and the re-created
 * bodies / view are translated back to what the earlier profiles pinned. The 0140 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0139.mjs';

export const NAME = 'ADR025_POST_0140';
export const THROUGH = '0140';
const MIGRATION = '0140_corte_mp_y_saldo_inicial_caja.sql';
const NEW_MARKERS = ['corte_clasificacion_mp', 'fin_account_balance_on', 'register_cash_opening', 'cash_opening_count'];
/** re-created function → the migration whose body the earlier profiles pinned */
const OLD_BODY = { fin_operation_list: '0139_redondeo_mp_cheque_insumo.sql', fin_movement_class: '0130_gastos_revertir_pago.sql', mp_pending_classification_totals: '0095_mp_unlinked_inflows.sql' };
/** re-created view → [md5 the earlier profiles pinned, md5 0139 serves] (md5 of pg_get_viewdef) */
const VIEW_MD5 = {
  fin_mp_pending_classification: ['401d71b0046a233dee028bc8fbdedda0', 'ac99b448d4aa333c385b74d2d2ccd35e'],
};
const SP = 'search_path=public, pg_temp';

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
const isNew = (x) => NEW_MARKERS.some((k) => x.includes(k));
/** Walks the previous profile's result: drops every string / key naming a 0139 object, re-created bodies and views back to their pins. */
function back(node, swaps) {
  if (Array.isArray(node)) return node.filter((x) => !(typeof x === 'string' && isNew(x))).map((x) => back(x, swaps));
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) if (!isNew(k)) o[k] = back(v, swaps);
    return o;
  }
  if (typeof node === 'string') { let s = node; for (const [now, old] of swaps) s = s.split(now).join(old); return s; }
  return node;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0140', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0140'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('corte_clasificacion_mp', 'fin_account_balance_on', 'register_cash_opening',
          'fin_operation_list', 'fin_movement_class', 'mp_pending_classification_totals')),
    'view', (SELECT md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'fin_mp_pending_classification'),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]') FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cash_opening_count', 'cash_opening_count_id_seq')),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd ORDER BY policyname), '[]') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cash_opening_count'),
    'cutover', (SELECT CASE WHEN to_regprocedure('public.corte_clasificacion_mp()') IS NULL THEN NULL ELSE corte_clasificacion_mp()::text END),
    'rows', (SELECT CASE WHEN to_regclass('public.cash_opening_count') IS NULL THEN NULL ELSE (SELECT count(*) FROM cash_opening_count) END))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0140 ?? {};
  const swaps = [
    ...Object.entries(OLD_BODY).map(([fn, file]) => [bodyMd5(ctx.repo, MIGRATION, fn), bodyMd5(ctx.repo, file, fn)]),
    ...Object.values(VIEW_MD5).map(([old, now]) => [now, old]),
  ];
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev)), swaps), { ...ctx, deploymentCheck: false }).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0140 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const OL = 'date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer,uuid,boolean,text';
  const B = (fn) => bodyMd5(ctx.repo, MIGRATION, fn);
  const fns = [
    `fin_account_balance_on(uuid,date)|false|postgres|${SP}|falsetruefalse|${B('fin_account_balance_on')}`,
    `fin_movement_class(text,text)|false|postgres|${SP}|falsefalsefalse|${B('fin_movement_class')}`,
    `fin_operation_list(${OL})|true|postgres|${SP}|falsetruefalse|${B('fin_operation_list')}`,
    `corte_clasificacion_mp()|false|postgres|${SP}|falsetruefalse|${B('corte_clasificacion_mp')}`,
    `mp_pending_classification_totals(date,date)|false|postgres|search_path=public|falsefalsefalse|${B('mp_pending_classification_totals')}`,
    `register_cash_opening(uuid,date,numeric,text)|true|postgres|${SP}|falsetruefalse|${B('register_cash_opening')}`,
  ].sort();
  check('0140 functions: the cutover, the cash opening (DEFINER) and the account balance; fin_operation_list / fin_movement_class / mp_pending_classification_totals re-created — owners, configs, privileges and the 0140 bodies',
    eq([...(a.functions ?? [])].sort(), fns), JSON.stringify((a.functions ?? []).filter((f) => !fns.includes(f))).slice(0, 600));
  check('0140 fin_mp_pending_classification re-created (historical before the cutover)', a.view === `${VIEW_MD5.fin_mp_pending_classification[1]}:{security_invoker=true}:postgres`, String(a.view));
  check('0140 cash_opening_count: RLS on, SELECT authenticated only, one ADMIN SELECT policy; its sequence without API privilege; the cutover is 2026-12-01',
    eq(a.tables, ['cash_opening_count:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}', 'cash_opening_count_id_seq:false:{postgres=rwU/postgres}'])
      && eq(a.policies, ['cash_opening_count:cash_opening_count_admin_select:SELECT']) && a.cutover === '2026-12-01', JSON.stringify([a.tables, a.policies, a.cutover]));
  if (ctx.deploymentCheck) check('0140 deployment: no cash opening recorded yet', Number(a.rows) === 0, String(a.rows));
  return out;
}
