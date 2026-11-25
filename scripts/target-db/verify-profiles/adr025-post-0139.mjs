/**
 * Verification profile ADR025_POST_0139 — the exact database state after target migrations 0001…0139 (erp-mejoras):
 *   0139 the Mercado Pago link with rounding: purchase_mp_settlement.rounding (|x| <= 1), settle_purchase_mp re-created (same identity, up to
 *        $1 apart, pays what the movement paid), fin_purchase_mp_link re-created (candidates up to $1 apart, with their difference),
 *        pnl_line_item re-created (the rounding is part of its expense); fin_operation_list re-created (same identity: «eCheq Nº · <expense>»
 *        for a cheque debit); the trigger expense_category_feed_rename (invoker, no API EXECUTE). Nothing written; DEFINER count 180.
 *
 * The whole 0001…0138 state is verified by ADR025_POST_0138; before evaluating it every 0139 object is taken out and the re-created
 * bodies / views are translated back to what the earlier profiles pinned. The 0139 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0138.mjs';

export const NAME = 'ADR025_POST_0139';
export const THROUGH = '0139';
const MIGRATION = '0139_redondeo_mp_cheque_insumo.sql';
const NEW_MARKERS = ['expense_category_feed_rename', 'chk_purchase_mp_settlement_rounding', 'purchase_mp_settlement.rounding'];
/** re-created function → the migration whose body the earlier profiles pinned */
const OLD_BODY = { settle_purchase_mp: '0111_wa_invoice_receiver_mp_link.sql', fin_operation_list: '0137_filtro_comprobante_operaciones.sql' };
/** re-created view → [md5 the earlier profiles pinned, md5 0139 serves] (md5 of pg_get_viewdef) */
const VIEW_MD5 = {
  pnl_line_item: ['8db5c8c43a46a6ae98c2b00c6d24c074', 'c44a0ec01e8f340c83fa113a30f7ab68'],
  fin_purchase_mp_link: ['f9cef55521a9f3d81026965ed8fa436c', '6d32542d2d26747527fcf41ee751b557'],
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
  'a0139', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0139'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('settle_purchase_mp', 'fin_operation_list', 'expense_category_feed_rename')),
    'views', (SELECT coalesce(json_object_agg(c.relname, md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner)), '{}')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('pnl_line_item', 'fin_purchase_mp_link')),
    'column', (SELECT format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || pg_get_expr(d.adbin, d.adrelid) FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass('public.purchase_mp_settlement') AND a.attname = 'rounding' AND NOT a.attisdropped),
    'check', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_purchase_mp_settlement_rounding'),
    'trigger', (SELECT tgname || ':' || tgenabled::text || ':' || tgrelid::regclass::text FROM pg_trigger WHERE tgname = 'trg_expense_category_feed_rename'),
    'rows', (SELECT CASE WHEN to_regclass('public.purchase_mp_settlement') IS NULL THEN NULL ELSE (SELECT count(*) FROM purchase_mp_settlement WHERE rounding <> 0) END))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0139 ?? {};
  const swaps = [
    ...Object.entries(OLD_BODY).map(([fn, file]) => [bodyMd5(ctx.repo, MIGRATION, fn), bodyMd5(ctx.repo, file, fn)]),
    ...Object.values(VIEW_MD5).map(([old, now]) => [now, old]),
    // the 0111 column list of purchase_mp_settlement (0139 appends rounding)
    ['purchase_mp_settlement:id,purchase_root_id,purchase_id,source_id,mp_financial_movement_id,financial_operation_id,economic_date,movement_date,amount,idempotency_key,reason,result,created_by,created_at,rounding',
      'purchase_mp_settlement:id,purchase_root_id,purchase_id,source_id,mp_financial_movement_id,financial_operation_id,economic_date,movement_date,amount,idempotency_key,reason,result,created_by,created_at'],
  ];
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev)), swaps), { ...ctx, deploymentCheck: false }).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0139 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const OL = 'date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer,uuid,boolean,text';
  const fns = [
    `expense_category_feed_rename()|false|postgres|${SP}|falsefalsefalse|${bodyMd5(ctx.repo, MIGRATION, 'expense_category_feed_rename')}`,
    `fin_operation_list(${OL})|true|postgres|${SP}|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, 'fin_operation_list')}`,
    `settle_purchase_mp(uuid,text,character varying,text)|true|postgres|search_path=public|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, 'settle_purchase_mp')}`,
  ];
  check('0139 functions: settle_purchase_mp and fin_operation_list re-created (DEFINER, same identity, EXECUTE authenticated only, the 0139 bodies); expense_category_feed_rename invoker without API EXECUTE',
    eq(a.functions, fns), JSON.stringify(a.functions).slice(0, 500));
  check('0139 views pnl_line_item and fin_purchase_mp_link re-created as in 0139 (security_invoker, owner postgres)',
    a.views?.pnl_line_item === `${VIEW_MD5.pnl_line_item[1]}:{security_invoker=true}:postgres` && a.views?.fin_purchase_mp_link === `${VIEW_MD5.fin_purchase_mp_link[1]}:{security_invoker=true}:postgres`,
    JSON.stringify(a.views));
  check('0139 purchase_mp_settlement.rounding numeric(15,2) NOT NULL DEFAULT 0, |rounding| <= 1.00; the rename trigger on expense_category',
    a.column === 'numeric(15,2):true:0' && a.check === 'CHECK ((abs(rounding) <= 1.00))' && a.trigger === 'trg_expense_category_feed_rename:O:expense_category',
    `${a.column} · ${a.check} · ${a.trigger}`);
  if (ctx.deploymentCheck) check('0139 deployment: no rounding recorded yet', Number(a.rows) === 0, String(a.rows));
  return out;
}
