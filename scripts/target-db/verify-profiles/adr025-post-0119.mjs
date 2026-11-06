/**
 * Verification profile ADR025_POST_0119 — the exact database state after target migrations 0001…0119
 * (0119: Caja → Todas las operaciones — fin_operation_list, pay_purchase_invoice, fin_operation_timeline).
 *
 * The whole 0001…0118 state is verified by ADR025_POST_0118. 0119 adds three SECURITY DEFINER functions and changes no existing
 * object: their definer identities are translated back before evaluating it; the functions are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0118.mjs';

export const NAME = 'ADR025_POST_0119';
export const THROUGH = '0119';
const MIGRATION = '0119_todas_las_operaciones.sql';
const NEW_DEFINERS = [
  'fin_operation_list(date,date,text,uuid,boolean,text,text,numeric,text,text,integer,integer)', 'fin_operation_timeline(text)',
  'pay_purchase_invoice(uuid,numeric,date,payment_method,uuid,character varying,text)'];
const FUNCTIONS = [
  'fin_operation_list(date,date,text,uuid,boolean,text,text,numeric,text,text,integer,integer)|true|postgres|search_path=public, pg_temp|falsetruefalse|@',
  'fin_operation_timeline(text)|true|postgres|search_path=public, pg_temp|falsetruefalse|@',
  'pay_purchase_invoice(uuid,numeric,date,payment_method,uuid,character varying,text)|true|postgres|search_path=public, pg_temp|falsetruefalse|@'];

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
  'a0119', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0119'),
    'functions', (SELECT coalesce(json_agg(t ORDER BY t), '[]') FROM (SELECT p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
        || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' || md5(replace(p.prosrc, E'\\r', '')) AS t
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('fin_operation_list', 'fin_operation_timeline', 'pay_purchase_invoice')) q),
    'invoice_payments', (SELECT count(*) FROM audit_events WHERE action = 'PAY_INVOICE'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0119 ?? {};
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
  check('0119 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0119 SECURITY DEFINER: exactly +3 (the list, its history, the invoice payment from the row)', NEW_DEFINERS.every((d) => realDefiners.includes(d)),
    `missing=[${NEW_DEFINERS.filter((d) => !realDefiners.includes(d)).join(' ')}]`);
  check('0119 functions: EXECUTE authenticated only', eq(shape(a.functions), FUNCTIONS), JSON.stringify(a.functions));
  check('0119 functions: bodies as in 0119 (md5 of the migration text)', eq(a.functions, fileBodies(ctx.repo)), JSON.stringify(a.functions));
  if (ctx.deploymentCheck) check('0119 deployment: no invoice paid from its row right after the migration', Number(a.invoice_payments) === 0, String(a.invoice_payments));
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
