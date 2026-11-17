/**
 * Verification profile ADR025_POST_0131 — the exact database state after target migrations 0001…0131 (erp-mejoras):
 *   0131 Producción: tables flock_day_note and bird_count (RLS, SELECT for ADMIN / OPERATOR, no direct write); RPCs (DEFINER,
 *        EXECUTE authenticated only) register_production_day, edit_production_day, list_production_day_edits, list_production_days, register_bird_count,
 *        void_bird_count, list_bird_counts; column daily_production.recorded_time (TIME(0), nullable). No existing object is re-created.
 *
 * The whole 0001…0130 state is verified by ADR025_POST_0130; before evaluating it the new objects are taken out. The 0131 objects
 * are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0130.mjs';

export const NAME = 'ADR025_POST_0131';
export const THROUGH = '0131';
const MIGRATION = '0131_produccion_edicion_y_conteos.sql';
const NEW_MARKERS = ['flock_day_note', 'bird_count', 'register_production_day', 'edit_production_day', 'list_production_day_edits', 'list_production_days'];
const RPCS = {
  edit_production_day: 'edit_production_day(uuid,date,integer,integer,bigint,text,time without time zone,text)',
  list_bird_counts: 'list_bird_counts(uuid)',
  list_production_day_edits: 'list_production_day_edits(date,date)',
  list_production_days: 'list_production_days(date,date)',
  register_bird_count: 'register_bird_count(uuid,date,bigint,text)',
  register_production_day: 'register_production_day(uuid,date,integer,integer,bigint,text,time without time zone)',
  void_bird_count: 'void_bird_count(bigint,text)',
};

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
/** Walks the previous profile's result: drops every string / key naming a 0131 object. */
function back(node) {
  if (Array.isArray(node)) return node.filter((x) => !(typeof x === 'string' && NEW_MARKERS.some((k) => x.includes(k)))).map(back);
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) if (!NEW_MARKERS.some((m) => k.includes(m))) o[k] = back(v);
    return o;
  }
  return node;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0131', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0131'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.proname), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${Object.keys(RPCS).map((f) => `'${f}'`).join(', ')})),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
        FROM pg_class c WHERE c.oid IN (to_regclass('public.flock_day_note'), to_regclass('public.bird_count'))),
    'sequence', (SELECT coalesce(c.relacl::text, 'NULL') FROM pg_class c WHERE c.oid = to_regclass('public.bird_count_id_seq')),
    'policies', (SELECT coalesce(json_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') ORDER BY tablename, policyname), '[]')
        FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('flock_day_note', 'bird_count')),
    'time_col', (SELECT data_type || ':' || coalesce(datetime_precision::text, '') || ':' || is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'daily_production' AND column_name = 'recorded_time'),
    'triggers', (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN ('flock_day_note', 'bird_count')),
    'counts', CASE WHEN to_regclass('public.bird_count') IS NULL THEN NULL ELSE json_build_object(
        'bird_count', (SELECT count(*) FROM bird_count),
        'bird_count_linked', (SELECT count(*) FROM bird_count b JOIN population_events pe ON pe.id = b.population_event_id
                               WHERE pe.event_type = 'COUNT_ADJUSTMENT' AND pe.is_current AND b.counted - b.computed = pe.delta AND b.voided_at IS NULL),
        'count_events', (SELECT count(*) FROM population_events WHERE event_type = 'COUNT_ADJUSTMENT' AND is_current),
        'notes', (SELECT count(*) FROM flock_day_note),
        'notes_expected', (SELECT count(DISTINCT (flock_id, event_date)) FROM population_events WHERE event_type = 'MORTALITY' AND version_seq = 0
                             AND coalesce(btrim(reason), '') <> '' AND reason NOT LIKE 'legacy:%'),
        'day_edits', (SELECT count(*) FROM audit_events WHERE entity_type IN ('flock_day', 'bird_count'))) END)
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0131 ?? {};
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev))), ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check('0131 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  const want = Object.entries(RPCS).map(([fn, sig]) => `${sig}|true|postgres|search_path=public, pg_temp|falsetruefalse|${bodyMd5(ctx.repo, MIGRATION, fn)}`);
  check('0131 functions: seven RPCs DEFINER, EXECUTE authenticated only, bodies as in 0131',
    eq(a.functions, want), JSON.stringify((a.functions ?? []).filter((f) => !want.includes(f))).slice(0, 500));
  check('0131 tables: RLS on, SELECT for authenticated only; the sequence without API privilege',
    eq(a.tables, ['bird_count:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}', 'flock_day_note:true:{postgres=arwdDxtm/postgres,authenticated=r/postgres}'])
      && a.sequence === '{postgres=rwU/postgres}', JSON.stringify([a.tables, a.sequence]));
  const rol = "(current_app_role() = ANY (ARRAY['ADMIN'::text, 'OPERATOR'::text]))";
  check('0131 policies: one SELECT policy each, ADMIN and OPERATOR',
    eq(a.policies, [`bird_count:bird_count_select:SELECT:${rol}`, `flock_day_note:flock_day_note_select:SELECT:${rol}`]), JSON.stringify(a.policies));
  check('0131 no triggers on the new tables', Number(a.triggers) === 0, String(a.triggers));
  check('0131 daily_production.recorded_time: time without time zone (0), nullable', a.time_col === 'time without time zone:0:YES', String(a.time_col));
  const c = a.counts ?? {};
  check('0131 every current count adjustment is a count of birds with the same difference', c.bird_count_linked === c.count_events && c.bird_count >= c.count_events,
    JSON.stringify(c));
  if (ctx.deploymentCheck) {
    check('0131 deployment: counts = the backfilled adjustments; notes = the mortality notes; no edit yet',
      c.bird_count === c.count_events && c.notes === c.notes_expected && Number(c.day_edits) === 0, JSON.stringify(c));
  }
  return out;
}
