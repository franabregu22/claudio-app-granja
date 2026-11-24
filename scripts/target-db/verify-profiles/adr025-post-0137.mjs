/**
 * Verification profile ADR025_POST_0137 — the exact database state after target migrations 0001…0137 (erp-mejoras):
 *   0137 the «Factura / comprobante» filter of Todas las operaciones: fin_operation_list re-created with one more argument
 *        (p_comprobante TEXT) — the old 18-argument identity dropped, the new one DEFINER, owner postgres, EXECUTE authenticated only.
 *        Nothing written; the DEFINER count is unchanged (179).
 *
 * The whole 0001…0136 state is verified by ADR025_POST_0136; before evaluating it the widened identity is translated back to the
 * 18-argument one and its body back to the 0135 one (the earlier profiles pin both). The 0137 object is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0136.mjs';

export const NAME = 'ADR025_POST_0137';
export const THROUGH = '0137';
const MIGRATION = '0137_filtro_comprobante_operaciones.sql';
const PREV_BODY = '0135_factura_a_y_debcred_mp.sql';
const OL = 'date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer,uuid,boolean';
const NOW_ID = `fin_operation_list(${OL},text)`;
const OLD_ID = `fin_operation_list(${OL})`;
const OWN = 'true|postgres|search_path=public, pg_temp|falsetruefalse';

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
/** Walks the previous profile's result: the widened identity → the 18-argument one, the 0137 body md5 → the 0135 one. */
function back(node, now, old) {
  if (Array.isArray(node)) return node.map((x) => back(x, now, old));
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k.split(NOW_ID).join(OLD_ID)] = back(v, now, old);
    return o;
  }
  if (typeof node === 'string') return node.split(NOW_ID).join(OLD_ID).split(now).join(old);
  return node;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0137', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0137'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fin_operation_list'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0137 ?? {};
  const now = bodyMd5(ctx.repo, MIGRATION, 'fin_operation_list');
  const old = bodyMd5(ctx.repo, PREV_BODY, 'fin_operation_list');
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev)), now, old), ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0137 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0137 fin_operation_list: ONE overload, the 19-argument identity (+ p_comprobante), DEFINER, owner postgres, search_path = public, pg_temp, EXECUTE authenticated only, the 0137 body',
    JSON.stringify(a.functions) === JSON.stringify([`${NOW_ID}|${OWN}|${now}`]), JSON.stringify(a.functions).slice(0, 400));
  return out;
}
