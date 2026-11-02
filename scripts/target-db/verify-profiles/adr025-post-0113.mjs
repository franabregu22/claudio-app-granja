/**
 * Verification profile ADR025_POST_0113 — the exact database state after target migrations 0001…0113
 * (0113, Caja → Movimientos: the read-only unified history — fin_movement_history and its internal fin_movement_class).
 *
 * The whole 0001…0112 state is verified by ADR025_POST_0112. 0113 adds two functions and nothing else: the new SECURITY DEFINER
 * identity is translated back before evaluating it and both functions are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0112.mjs';

export const NAME = 'ADR025_POST_0113';
export const THROUGH = '0113';
const MIGRATION = '0113_fin_movement_history.sql';
const NEW_DEFINERS = ['fin_movement_history(date,date,uuid,text,text,numeric,integer,integer)'];
const FUNCTIONS = [
  'fin_movement_class(text,text)|false|postgres|search_path=public, pg_temp|falsefalsefalse|b2729ccc88fddfac35caa615167b86b1',
  'fin_movement_history(date,date,uuid,text,text,numeric,integer,integer)|true|postgres|search_path=public|falsetruefalse|bb8741b9297eb25609422b499e012c87'];

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

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0113', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0113'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('fin_movement_class', 'fin_movement_history')) q))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0113 ?? {};
  // the 0112 state as POST_0112 knows it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0113 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0113 SECURITY DEFINER: exactly +1 (the ADMIN read RPC)', NEW_DEFINERS.every((d) => realDefiners.includes(d)), `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0113 functions: the RPC EXECUTE authenticated only; the classifier no API EXECUTE; bodies as in 0113', JSON.stringify(a.functions) === JSON.stringify(FUNCTIONS), JSON.stringify(a.functions));
  return out;
}
