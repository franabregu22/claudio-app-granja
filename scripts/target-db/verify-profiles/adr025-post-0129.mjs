/**
 * Verification profile ADR025_POST_0129 — the exact database state after target migrations 0001…0129 (alimento-balanceado-v1):
 *   0129 production without operator↔flock assignments: register_daily_production, rectify_daily_production, register_mortality,
 *        register_count_adjustment re-created (same identities) without the FLOCK_NOT_ASSIGNED check; the four operator SELECT
 *        policies (flocks, daily_production, population_events, flock_feed_assignment) role-only.
 *
 * The whole 0001…0128 state is verified by ADR025_POST_0128 (it pins none of the 0129 objects). The 0129 objects are checked here
 * exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0128.mjs';

export const NAME = 'ADR025_POST_0129';
export const THROUGH = '0129';
const MIGRATION = '0129_produccion_sin_asignaciones.sql';
const FUNCS = {
  register_daily_production: 'register_daily_production(uuid,date,integer,integer,integer,text)',
  rectify_daily_production: 'rectify_daily_production(uuid,integer,integer,integer,text)',
  register_mortality: 'register_mortality(uuid,date,bigint,text)',
  register_count_adjustment: 'register_count_adjustment(uuid,date,bigint,text)',
};
const POLICIES = ['daily_production:daily_production_operator_select', 'flock_feed_assignment:flock_feed_assignment_operator_select',
  'flocks:flocks_operator_assigned', 'population_events:population_events_operator_select'];

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
function bodyMd5(repo, fn) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', MIGRATION), 'utf8').replace(/\r/g, '');
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\bAS \$function\$([\s\S]*?)\$function\$;/g;
  let m; let last = 'missing';
  while ((m = re.exec(text))) if (m[1] === fn) last = createHash('md5').update(m[2]).digest('hex');
  return last;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0129', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0129'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.proname), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('register_daily_production', 'rectify_daily_production', 'register_mortality', 'register_count_adjustment')),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '')
        || '|' || coalesce(with_check, '') ORDER BY tablename, policyname), '[]')
        FROM pg_policies WHERE schemaname = 'public' AND (tablename || ':' || policyname) IN (${POLICIES.map((p) => `'${p}'`).join(', ')})),
    'readers', (SELECT coalesce(json_agg(p.proname ORDER BY p.proname), '[]') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%operator_assignments%'),
    'policy_readers', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
        AND (coalesce(qual, '') LIKE '%operator_assignments%' OR coalesce(with_check, '') LIKE '%operator_assignments%')))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0129 ?? {};
  const out = prev.evaluate(s.prev, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0129 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const want = Object.keys(FUNCS).sort().map((f) => `${FUNCS[f]}|true|postgres|falsetruefalse|${bodyMd5(ctx.repo, f)}`);
  check('0129 the four production RPCs: one overload each, definer, owner postgres, EXECUTE authenticated only, bodies as in 0129 (no assignment check)',
    JSON.stringify(a.functions) === JSON.stringify(want), JSON.stringify(a.functions));
  const role = "(current_app_role() = 'OPERATOR'::text)";
  check('0129 the four operator SELECT policies: role-only (every flock), PUBLIC, no WITH CHECK',
    JSON.stringify(a.policies) === JSON.stringify(POLICIES.map((p) => `${p}|SELECT|public|${role}|`)), JSON.stringify(a.policies));
  check('0129 only close_flock still touches operator_assignments (history); no policy reads it',
    JSON.stringify(a.readers) === JSON.stringify(['close_flock']) && Number(a.policy_readers) === 0, `${JSON.stringify(a.readers)} / ${a.policy_readers}`);
  return out;
}
