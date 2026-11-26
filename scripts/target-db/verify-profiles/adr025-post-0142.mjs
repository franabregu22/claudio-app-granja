/**
 * Verification profile ADR025_POST_0142 — the exact database state after target migrations 0001…0142 (erp-mejoras):
 *   0142 anular un gasto que espera su movimiento de Mercado Pago: annul_expense re-created (an expense paid with Mercado Pago whose
 *        movement is not linked can be annulled), fin_purchase_mp_link and fin_operation_list re-created (an annulled expense waits for
 *        nothing), fin_annulled_mp_settlement_guard (invoker, no API EXECUTE) + trg_pms_annulled_guard on purchase_mp_settlement.
 *        Nothing written; DEFINER count unchanged (182).
 *
 * The whole 0001…0141 state is verified by ADR025_POST_0141; before evaluating it the 0142 objects are taken out and the re-created
 * bodies / view are translated back to what the earlier profiles pinned. The 0142 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0141.mjs';

export const NAME = 'ADR025_POST_0142';
export const THROUGH = '0142';
const MIGRATION = '0142_anular_gasto_esperando_mp.sql';
const NEW_MARKERS = ['fin_annulled_mp_settlement_guard', 'trg_pms_annulled_guard'];
/** re-created function → the migration whose body the earlier profiles pinned */
const OLD_BODY = { annul_expense: '0124_gastos_anular_y_editar.sql', fin_operation_list: '0140_corte_mp_y_saldo_inicial_caja.sql' };
/** re-created view → [md5 the earlier profiles pinned, md5 0142 serves] (md5 of pg_get_viewdef) */
const VIEW_MD5 = {
  fin_purchase_mp_link: ['6d32542d2d26747527fcf41ee751b557', '4d9f80a89bb97a687206945595c3086f'],
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
  'a0142', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0142'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('annul_expense', 'fin_operation_list', 'fin_annulled_mp_settlement_guard')),
    'view', (SELECT md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'fin_purchase_mp_link'),
    'trigger', (SELECT coalesce(json_agg(t.tgname || ':' || t.tgrelid::regclass::text || ':' || t.tgenabled::text || ':' || t.tgfoid::regprocedure::text ORDER BY t.tgname), '[]')
        FROM pg_trigger t WHERE t.tgname = 'trg_pms_annulled_guard'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0142 ?? {};
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
  check('0142 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const OL = 'date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer,uuid,boolean,text';
  const B = (fn) => bodyMd5(ctx.repo, MIGRATION, fn);
  const fns = [
    `annul_expense(uuid,text,character varying,date)|true|postgres|${SP}|falsetruefalse|${B('annul_expense')}`,
    `fin_annulled_mp_settlement_guard()|false|postgres|${SP}|falsefalsefalse|${B('fin_annulled_mp_settlement_guard')}`,
    `fin_operation_list(${OL})|true|postgres|${SP}|falsetruefalse|${B('fin_operation_list')}`,
  ].sort();
  check('0142 functions: annul_expense and fin_operation_list re-created (DEFINER, EXECUTE authenticated only, the 0142 bodies); the settlement guard invoker without API EXECUTE',
    eq([...(a.functions ?? [])].sort(), fns), JSON.stringify((a.functions ?? []).filter((f) => !fns.includes(f))).slice(0, 600));
  check('0142 fin_purchase_mp_link re-created (an annulled expense waits for nothing)', a.view === `${VIEW_MD5.fin_purchase_mp_link[1]}:{security_invoker=true}:postgres`, String(a.view));
  check('0142 trg_pms_annulled_guard on purchase_mp_settlement, enabled', eq(a.trigger, ['trg_pms_annulled_guard:purchase_mp_settlement:O:fin_annulled_mp_settlement_guard()']), JSON.stringify(a.trigger));
  return out;
}
