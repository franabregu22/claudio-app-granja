/**
 * Verification profile ADR025_POST_0141 — the exact database state after target migrations 0001…0141 (erp-mejoras):
 *   0141 quitar un flete asignado: unallocate_feed_freight (DEFINER, EXECUTE authenticated only) removes one feed freight allocation,
 *        audited. Nothing written; DEFINER count 181 → 182.
 *
 * The whole 0001…0140 state is verified by ADR025_POST_0140; before evaluating it the 0141 function is taken out (0141 re-creates
 * nothing). The 0141 object is checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0140.mjs';

export const NAME = 'ADR025_POST_0141';
export const THROUGH = '0141';
const MIGRATION = '0141_quitar_flete_asignado.sql';
const NEW_MARKERS = ['unallocate_feed_freight'];
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
/** Walks the previous profile's result: drops every string / key naming a 0141 object. */
function back(node) {
  if (Array.isArray(node)) return node.filter((x) => !(typeof x === 'string' && isNew(x))).map((x) => back(x));
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) if (!isNew(k)) o[k] = back(v);
    return o;
  }
  return node;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0141', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0141'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('unallocate_feed_freight')),
    'unallocations', (SELECT count(*) FROM audit_events WHERE entity_type = 'feed_freight_allocation' AND action = 'UNALLOCATE'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0141 ?? {};
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev))), { ...ctx, deploymentCheck: false }).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0141 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const fns = [`unallocate_feed_freight(uuid,uuid,text)|true|postgres|${SP}|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, 'unallocate_feed_freight')}`];
  check('0141 unallocate_feed_freight: DEFINER, owner postgres, pinned search_path, EXECUTE authenticated only, the 0141 body',
    eq(a.functions ?? [], fns), JSON.stringify(a.functions ?? []).slice(0, 400));
  if (ctx.deploymentCheck) check('0141 deployment: no freight removed yet', Number(a.unallocations) === 0, String(a.unallocations));
  return out;
}
