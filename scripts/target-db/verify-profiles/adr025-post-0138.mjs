/**
 * Verification profile ADR025_POST_0138 — the exact database state after target migrations 0001…0138 (erp-mejoras):
 *   0138 one invoice with several ingredients: table feed_purchase_part (RLS, SELECT for ADMIN through authenticated), the entry point
 *        set_feed_purchase_parts (DEFINER, EXECUTE authenticated only), the helper feed_share (invoker), and report_feed_purchase
 *        re-created (one row per part; two columns added at the end). Nothing written; DEFINER count 179 → 180.
 *
 * The whole 0001…0137 state is verified by ADR025_POST_0137; before evaluating it every 0138 object is taken out (the earlier profiles
 * pin the DEFINER identity list, the table grants and the function sets) and the re-created view's md5 is translated back to the one
 * 0126 pinned. The 0138 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0137.mjs';

export const NAME = 'ADR025_POST_0138';
export const THROUGH = '0138';
const MIGRATION = '0138_compra_insumos_varios.sql';
const NEW_MARKERS = ['feed_purchase_part', 'feed_share('];
// report_feed_purchase: what 0126 pinned → what 0138 serves (md5 of pg_get_viewdef)
const VIEW_OLD = 'cd57680fbccef6e9cdcafea4caec4aff';
const VIEW_NOW = 'd0d9b2c291baf991727f9970a80b73ac';
const ACL = '{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
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
/** Walks the previous profile's result: drops every string / key naming a 0138 object, the view md5 back to the 0126 one. */
function back(node) {
  if (Array.isArray(node)) return node.filter((x) => !(typeof x === 'string' && isNew(x))).map(back);
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) if (!isNew(k)) o[k] = back(v);
    return o;
  }
  if (typeof node === 'string') return node.split(VIEW_NOW).join(VIEW_OLD);
  return node;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0138', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0138'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('set_feed_purchase_parts', 'feed_share')),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]') FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('feed_purchase_part', 'feed_purchase_part_id_seq')),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd ORDER BY policyname), '[]') FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'feed_purchase_part'),
    'view', (SELECT md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'report_feed_purchase'),
    'view_columns', (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) FROM pg_attribute a
        WHERE a.attrelid = to_regclass('public.report_feed_purchase') AND a.attnum > 0 AND NOT a.attisdropped),
    'rows', (SELECT CASE WHEN to_regclass('public.feed_purchase_part') IS NULL THEN NULL ELSE (SELECT count(*) FROM feed_purchase_part) END))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0138 ?? {};
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev))), { ...ctx, deploymentCheck: false }).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0138 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const fns = [
    `feed_share(numeric,numeric,numeric,numeric)|false|postgres|${SP}|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, 'feed_share')}`,
    `set_feed_purchase_parts(uuid,jsonb,boolean)|true|postgres|${SP}|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, 'set_feed_purchase_parts')}`,
  ];
  check('0138 set_feed_purchase_parts(uuid,jsonb,boolean) DEFINER and feed_share(numeric ×4) invoker: one overload each, owner postgres, search_path = public, pg_temp, EXECUTE authenticated only, the 0138 bodies',
    eq(a.functions, fns), JSON.stringify(a.functions).slice(0, 400));
  check('0138 feed_purchase_part: RLS on, SELECT for authenticated only, one SELECT policy (ADMIN); its sequence without API privilege',
    eq(a.tables, [`feed_purchase_part:true:${ACL}`, 'feed_purchase_part_id_seq:false:{postgres=rwU/postgres}'])
      && eq(a.policies, ['feed_purchase_part:feed_purchase_part_admin_select:SELECT']), JSON.stringify([a.tables, a.policies]));
  check('0138 report_feed_purchase re-created: one row per part, security_invoker, owner postgres, SELECT authenticated only; part_position and purchase_quantity_kg added at the end',
    a.view === `${VIEW_NOW}:{security_invoker=true}:postgres:${ACL}` && String(a.view_columns).endsWith(',part_position:smallint,purchase_quantity_kg:numeric(15,3)'),
    `${a.view} · ${String(a.view_columns).slice(-80)}`);
  if (ctx.deploymentCheck) check('0138 deployment: nothing written (no invoice split yet)', Number(a.rows) === 0, String(a.rows));
  return out;
}
