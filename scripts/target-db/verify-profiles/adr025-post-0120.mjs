/**
 * Verification profile ADR025_POST_0120 — the exact database state after target migrations 0001…0120
 * (0120: fin_operation_list re-created with a wider signature — category, subcategory, nature, supplier, Por revisar, the filtered amount
 * and the Mercado Pago expenses still to link).
 *
 * The whole 0001…0119 state is verified by ADR025_POST_0119. 0120 drops the 0119 fin_operation_list and creates the new one (the
 * SECURITY DEFINER set keeps its size): the new identity and its row are translated back to what POST_0119 pinned (the 0119 signature
 * and the md5 of its 0119 body) before evaluating it; the new function is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0119.mjs';

export const NAME = 'ADR025_POST_0120';
export const THROUGH = '0120';
const MIGRATION = '0120_todas_las_operaciones_detalle.sql';
const OLD_SIG = 'fin_operation_list(date,date,text,uuid,boolean,text,text,numeric,text,text,integer,integer)';
const NEW_SIG = 'fin_operation_list(date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer)';
const SHAPE = (sig) => `${sig}|true|postgres|search_path=public, pg_temp|falsetruefalse|@`;

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
/** md5 of the body of `fn` as written in a migration file (the server stores the body verbatim). */
function bodyMd5(repo, file, fn) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', file), 'utf8').replace(/\r/g, '');
  const re = /CREATE (?:OR REPLACE )?FUNCTION (\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g;
  let m;
  while ((m = re.exec(text))) if (m[1] === fn) return createHash('md5').update(m[2]).digest('hex');
  return 'missing';
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0120', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0120'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fin_operation_list') q))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0120 ?? {};
  // the 0119 state as POST_0119 knows it: the list with its 0119 signature and body
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.map((d) => (d === NEW_SIG ? OLD_SIG : d)).sort();
  const old = SHAPE(OLD_SIG).replace('|@', `|${bodyMd5(ctx.repo, '0119_todas_las_operaciones.sql', 'fin_operation_list')}`);
  if (inner.a0119 && Array.isArray(inner.a0119.functions)) {
    inner.a0119.functions = inner.a0119.functions.map((f) => (f.startsWith(`${NEW_SIG}|`) ? old : f)).sort();
  }
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const fns = a.functions ?? [];
  check('0120 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0120 SECURITY DEFINER: the 0119 list replaced by the new one (no other change)', realDefiners.includes(NEW_SIG) && !realDefiners.includes(OLD_SIG),
    `${realDefiners.includes(NEW_SIG)}|${realDefiners.includes(OLD_SIG)}`);
  check('0120 fin_operation_list: one overload, EXECUTE authenticated only, body as in 0120',
    eq(fns, [SHAPE(NEW_SIG).replace('|@', `|${bodyMd5(ctx.repo, MIGRATION, 'fin_operation_list')}`)]), JSON.stringify(fns));
  return out;
}
