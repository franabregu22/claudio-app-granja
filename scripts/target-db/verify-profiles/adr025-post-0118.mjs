/**
 * Verification profile ADR025_POST_0118 — the exact database state after target migrations 0001…0118
 * (0118: reschedule_issued_instrument — the audited payment-date correction of an own cheque / eCheq before its debit).
 *
 * The whole 0001…0117 state is verified by ADR025_POST_0117. 0118 adds one SECURITY DEFINER function and changes no existing
 * object: its definer identity is translated back before evaluating it; the function is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0117.mjs';

export const NAME = 'ADR025_POST_0118';
export const THROUGH = '0118';
const MIGRATION = '0118_issued_instrument_payment_date.sql';
const NEW_DEFINERS = ['reschedule_issued_instrument(uuid,date,text)'];
const FUNCTIONS = ['reschedule_issued_instrument(uuid,date,text)|true|postgres|search_path=public, pg_temp|falsetruefalse|@'];

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
  'a0118', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0118'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'reschedule_issued_instrument') q),
    'reschedules', (SELECT count(*) FROM audit_events WHERE action = 'RESCHEDULE_PAYMENT_DATE'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0118 ?? {};
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = find(inner, 'definers');
  if (base) base.definers = base.definers.filter((d) => !NEW_DEFINERS.includes(d));
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  const realDefiners = find(s.prev, 'definers')?.definers ?? [];
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const shape = (xs) => (xs ?? []).map((f) => f.replace(/\|[0-9a-f]{32}$/, '|@'));
  check('0118 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0118 SECURITY DEFINER: exactly +1 (the payment-date correction)', NEW_DEFINERS.every((d) => realDefiners.includes(d)),
    `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0118 function: EXECUTE authenticated only', eq(shape(a.functions), FUNCTIONS), JSON.stringify(a.functions));
  check('0118 function: body as in 0118 (md5 of the migration text)', eq(a.functions, fileBodies(ctx.repo)), JSON.stringify(a.functions));
  if (ctx.deploymentCheck) check('0118 deployment: no payment-date correction right after the migration', Number(a.reschedules) === 0, String(a.reschedules));
  return out;
}

function fileBodies(repo) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', MIGRATION), 'utf8').replace(/\r/g, '');
  const bodies = new Map();
  const re = /CREATE (?:OR REPLACE )?FUNCTION (\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g;
  let m;
  while ((m = re.exec(text))) bodies.set(m[1], createHash('md5').update(m[2]).digest('hex'));
  return FUNCTIONS.map((f) => f.replace('|@', `|${bodies.get(f.split('(')[0]) ?? 'missing'}`));
}
