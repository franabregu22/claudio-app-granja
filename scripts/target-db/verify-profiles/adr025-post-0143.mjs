/**
 * Verification profile ADR025_POST_0143 — the exact database state after target migrations 0001…0143 (erp-mejoras):
 *   0143 facturar los cobros de Mercado Pago: views mp_cobro, report_mp_facturar_dia, report_mp_facturar_mes (security_invoker, SELECT
 *        authenticated only), pnl_line_item re-created (the IVA of an issued Factura B leaves VENTAS_NETAS), attach_fiscal_document_file
 *        (DEFINER, EXECUTE authenticated only). Nothing written; DEFINER count 182 → 183.
 *
 * The whole 0001…0142 state is verified by ADR025_POST_0142; before evaluating it the 0143 objects are taken out and the re-created
 * view is translated back to what the earlier profiles pinned. The 0143 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0142.mjs';

export const NAME = 'ADR025_POST_0143';
export const THROUGH = '0143';
const MIGRATION = '0143_facturar_cobros_mp.sql';
const NEW_MARKERS = ['mp_cobro', 'report_mp_facturar_dia', 'report_mp_facturar_mes', 'attach_fiscal_document_file'];
const OLD_BODY = {};
/** re-created view → [md5 the earlier profiles pinned, md5 0143 serves] (md5 of pg_get_viewdef) */
const VIEW_MD5 = {
  pnl_line_item: ['c44a0ec01e8f340c83fa113a30f7ab68', 'ec0b18b2efc8298de6f6277add49cfb6'],
};
const NEW_VIEWS = {
  mp_cobro: '9579c66ebe330cc6280665386b0f2973', report_mp_facturar_dia: '471ae393f6eef2fe3ef168ec732208ac', report_mp_facturar_mes: '0aa40db28ac5fa483107d3b267e44378',
};
const SP = 'search_path=public, pg_temp';
const ACL = '{postgres=arwdDxtm/postgres,authenticated=r/postgres}';

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
  'a0143', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0143'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('attach_fiscal_document_file')),
    'views', (SELECT json_object_agg(c.relname, md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL'))
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('pnl_line_item', 'mp_cobro', 'report_mp_facturar_dia', 'report_mp_facturar_mes')))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0143 ?? {};
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
  check('0143 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const fns = [`attach_fiscal_document_file(uuid,jsonb)|true|postgres|${SP}|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, 'attach_fiscal_document_file')}`];
  check('0143 attach_fiscal_document_file: DEFINER, owner postgres, pinned search_path, EXECUTE authenticated only, the 0143 body', eq(a.functions ?? [], fns), JSON.stringify(a.functions ?? []).slice(0, 400));
  const v = a.views ?? {};
  check('0143 views: mp_cobro, report_mp_facturar_dia / _mes (security_invoker, owner postgres, SELECT authenticated only); pnl_line_item re-created',
    Object.entries(NEW_VIEWS).every(([k, md5]) => v[k] === `${md5}:{security_invoker=true}:postgres:${ACL}`) && String(v.pnl_line_item ?? '').startsWith(`${VIEW_MD5.pnl_line_item[1]}:{security_invoker=true}:postgres:`),
    JSON.stringify(v).slice(0, 600));
  return out;
}
