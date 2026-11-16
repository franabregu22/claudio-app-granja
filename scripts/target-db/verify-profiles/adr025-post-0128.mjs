/**
 * Verification profile ADR025_POST_0128 — the exact database state after target migrations 0001…0128 (alimento-balanceado-v1):
 *   0128 one ingredient per recipe SECTION: feed_formula_line UNIQUE (formula_version_id, ingredient_id, section) replaces
 *        (formula_version_id, ingredient_id); publish_feed_formula_version re-created (same identity) with the duplicate check by section.
 *
 * The whole 0001…0127 state is verified by ADR025_POST_0127; before evaluating it the re-created function's body is translated back to
 * its 0125 body (what that profile pins). The 0128 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0127.mjs';

export const NAME = 'ADR025_POST_0128';
export const THROUGH = '0128';
const MIGRATION = '0128_alimento_ingrediente_por_seccion.sql';
const PUBLISH = 'publish_feed_formula_version(uuid,date,jsonb,text,text)';

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
function findAll(o, key, out = []) {
  if (!o || typeof o !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(o, key)) out.push(o);
  for (const v of Object.values(o)) findAll(v, key, out);
  return out;
}
function bodyMd5(repo, file, fn) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', file), 'utf8').replace(/\r/g, '');
  const re = /CREATE (?:OR REPLACE )?FUNCTION (\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g;
  let m; let last = 'missing';
  while ((m = re.exec(text))) if (m[1] === fn) last = createHash('md5').update(m[2]).digest('hex');
  return last;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0128', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0128'),
    'publish', (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', ''))
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'publish_feed_formula_version'),
    'unique', (SELECT coalesce(json_agg(c.conname || ':' || pg_get_constraintdef(c.oid) ORDER BY c.conname), '[]') FROM pg_constraint c
        WHERE c.conrelid = 'public.feed_formula_line'::regclass AND c.contype = 'u'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0128 ?? {};
  const inner = JSON.parse(JSON.stringify(s.prev));
  const now = bodyMd5(ctx.repo, MIGRATION, 'publish_feed_formula_version');
  const old = bodyMd5(ctx.repo, '0125_alimento_recetas_fabricaciones_cierre.sql', 'publish_feed_formula_version');
  for (const h of findAll(inner, 'functions')) {
    if (Array.isArray(h.functions)) h.functions = h.functions.map((f) => (typeof f === 'string' && f.startsWith(`${PUBLISH}|`) && f.endsWith(now) ? f.slice(0, -32) + old : f));
  }
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0128 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0128 publish_feed_formula_version: one overload, definer, EXECUTE authenticated only, body as in 0128 (duplicates per section)',
    a.publish === `${PUBLISH}|true|falsetruefalse|${now}`, String(a.publish));
  check('0128 feed_formula_line: unique per (version, ingredient, section); the per-(version, ingredient) one is gone',
    JSON.stringify(a.unique) === JSON.stringify(['feed_formula_line_version_ingredient_section_key:UNIQUE (formula_version_id, ingredient_id, section)']), JSON.stringify(a.unique));
  return out;
}
