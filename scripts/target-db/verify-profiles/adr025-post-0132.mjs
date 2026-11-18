/**
 * Verification profile ADR025_POST_0132 — the exact database state after target migrations 0001…0132 (erp-mejoras):
 *   0132 fin_operation_list re-created with the same identity (0127 body + the classified Mercado Pago outflow's provisional and
 *        release left out of Todas las operaciones). No other object changes.
 *
 * The whole 0001…0131 state is verified by ADR025_POST_0131; before evaluating it the re-created body is translated back to the one
 * the previous profiles pinned (0127). The 0132 body is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0131.mjs';

export const NAME = 'ADR025_POST_0132';
export const THROUGH = '0132';
const MIGRATION = '0132_operaciones_sin_par_mp.sql';
const SIG = 'fin_operation_list(date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer,uuid,boolean)';
/** re-created function → the migration whose body the previous profiles pinned */
const OLD_BODY = { fin_operation_list: '0127_gastos_etiquetas.sql' };

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
/** Walks the previous profile's result: translates the re-created body back. */
function back(node, repo, nuevos) {
  if (Array.isArray(node)) return node.map((x) => back(x, repo, nuevos));
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k] = back(v, repo, nuevos);
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
  'a0132', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0132'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fin_operation_list'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0132 ?? {};
  const nuevos = Object.fromEntries(Object.keys(OLD_BODY).map((fn) => [fn, bodyMd5(ctx.repo, MIGRATION, fn)]));
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev)), ctx.repo, nuevos), ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check('0132 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0132 fin_operation_list: one signature, DEFINER, owner postgres, EXECUTE authenticated only, body as in 0132',
    eq(a.functions, [`${SIG}|true|postgres|search_path=public, pg_temp|falsetruefalse|${nuevos.fin_operation_list}`]), JSON.stringify(a.functions).slice(0, 400));
  return out;
}
