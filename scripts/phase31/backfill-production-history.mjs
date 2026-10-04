#!/usr/bin/env node
/**
 * Phase 31 post-cutover — historical daily production backfill (legacy producciones → target daily_production).
 *
 * The cutover load used legacy producciones only for the mortality history (population_events, P-a). The egg
 * counts were not loaded, so report_flock_day (Producción → Histórico) shows mortality / birds but no eggs. This
 * script loads them, from the FINAL snapshot only, through the frozen RPC register_daily_production (no mortality,
 * no population change), with lineage in phase26_migration.lineage under its own batch, so a rerun never duplicates.
 *
 * Mapping (owner-reviewed, legacy semantics: "huevos totales = sanos + cachados"; legacy postura = totales / aves):
 *   eggs_total  = huevos_totales_mediodia + huevos_totales_tarde
 *   eggs_broken = huevos_cachados_mediodia + huevos_cachados_tarde
 *   eggs_dirty  = 0 (no legacy field)
 *   flock       = the flock occupying (galpon, fecha), exactly the cutover attribution (owner overrides included)
 *   mortandad   = NOT loaded here (already population_events of the cutover batch)
 *
 * Commands (all need --config <the production cutover config>):
 *   plan     LOCAL only: read the restored legacy copy (must be the final snapshot: producciones count = manifest),
 *            build the rows, write <out>/production-history-plan.json (+ sha256). No target access.
 *   check    target READ ONLY: flocks ACTIVE, periods OPEN, lineage of this batch, overlapping daily_production.
 *   apply    target WRITE, one transaction: requires PHASE31_BACKFILL_CONFIRM=<batch> and --plan-sha <sha256>.
 *   verify   target READ ONLY: reconciliation, population unchanged.
 * Usage: node scripts/phase31/backfill-production-history.mjs <command> --config <json> --out <dir> [--plan-sha <hex>]
 * Connection: CUTOVER_TARGET_DB_URL (libpq variables, never argv / logs). Prints no secret, email or token.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const BATCH = 'P31-20261004T1900-PRODHIST1';
const SOURCE_SYSTEM = 'legacy_supabase';
const EXPECTED_POPULATION = { 'G01-2501': 266, 'G02-2509': 2530, 'G03-2501': 1962, 'G04-2607': 3880 };
const [command, ...rest] = process.argv.slice(2);
const opt = {}; for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
const die = (code, msg, detail) => {
  console.error(`\nBACKFILL FAILED [${code}]: ${msg}`);
  if (detail) console.error(String(detail).replace(/password[^\s]*/gi, 'password=***').split('\n').slice(0, 30).map((l) => `  ${l}`).join('\n'));
  process.exit(1);
};
const log = (s) => console.log(`[phase31-prodhist] ${s}`);
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Pure plan builder (unit-tested): legacy rows + flocks (cutover attribution) → mapped rows and rejects. */
export function buildProductionPlan(prods, flocks) {
  const occupies = (f, d) => f.entry <= d && (f.exit === null || d <= f.exit) && (f.exit !== null || f.legacy_estado !== 'Retirado' || f.open_confirmed);
  const rows = []; const rejects = {}; const seen = new Set();
  const rej = (k, p) => { (rejects[k] ||= []).push(p.id); };
  for (const p of prods) {
    const v = [p.tm, p.cm, p.tt, p.ct].map((x) => (x === null || x === undefined ? null : Number(x)));
    const c = flocks.filter((f) => f.galpon === p.galpon && occupies(f, p.fecha));
    if (c.length !== 1) { rej(`flock attribution = ${c.length}`, p); continue; }
    if (v.some((x) => x !== null && (!Number.isInteger(x) || x < 0))) { rej('negative or non-integer egg value', p); continue; }
    if (v.every((x) => x === null || x === 0)) { rej('no egg data (all null / 0)', p); continue; }
    const key = `${c[0].id}|${p.fecha}`;
    if (seen.has(key)) { rej('second row for the same flock and date', p); continue; }
    seen.add(key);
    rows.push({ source_id: p.id, flock_id: c[0].id, code: c[0].code, date: p.fecha,
      eggs_total: (v[0] || 0) + (v[2] || 0), eggs_broken: (v[1] || 0) + (v[3] || 0), eggs_dirty: 0,
      reason: `legacy:producciones:${p.id} ${BATCH}` });
  }
  return { rows, rejects };
}

function loadConfig() {
  if (!opt.config || !existsSync(opt.config)) die('USAGE', '--config <production cutover config> is required');
  if (!opt.out) die('USAGE', '--out <dir outside the repository> is required');
  const c = JSON.parse(readFileSync(opt.config, 'utf8'));
  if (c.target?.kind !== 'PRODUCTION_TARGET' || !c.source?.snapshot_id) die('CONFIG', 'not a production cutover config with a final snapshot');
  return c;
}

function legacy(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'granja-legacy-copy', 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-X', '-A', '-t', '-c', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die('LEGACY_COPY', 'psql failed on the local legacy copy', r.stderr);
  return r.stdout.trim();
}

function plan(cfg) {
  const counts = readFileSync(join(cfg.source.snapshot_dir, 'source-counts.tsv'), 'utf8');
  const expected = Number((counts.split(/\r?\n/).find((l) => l.startsWith('producciones\t')) || '').split('\t')[1]);
  const manifestSha = sha(readFileSync(join(cfg.source.snapshot_dir, 'manifest.json')));
  if (manifestSha !== cfg.source.manifest_sha256) die('SNAPSHOT', 'manifest sha256 differs from the config final snapshot');
  const have = Number(legacy('SELECT count(*) FROM producciones'));
  if (!expected || have !== expected) die('SNAPSHOT', `local legacy copy producciones=${have} differs from the final snapshot ${expected}`);
  const lotes = JSON.parse(legacy(`SELECT json_agg(json_build_object('id', id, 'galpon', galpon, 'fecha_entrada', fecha_entrada, 'fecha_salida', fecha_salida, 'estado', estado, 'code', lote_id)) FROM lotes`));
  const prods = JSON.parse(legacy(`SELECT json_agg(json_build_object('id', id, 'fecha', fecha, 'galpon', galpon, 'tm', huevos_totales_mediodia, 'cm', huevos_cachados_mediodia,
    'tt', huevos_totales_tarde, 'ct', huevos_cachados_tarde) ORDER BY fecha, galpon, id) FROM producciones`));
  const ov = cfg.flocks.owner_overrides || {};
  const flocks = lotes.map((l) => { const o = ov[l.id] || {}; const estado = o.target_estado || cfg.flocks.estado_map[l.estado];
    return { id: l.id, galpon: o.galpon || l.galpon, entry: l.fecha_entrada, exit: o.exit_date !== undefined ? o.exit_date : l.fecha_salida,
      code: o.target_code || l.code, legacy_estado: l.estado, open_confirmed: estado === 'ACTIVE' }; });
  const { rows, rejects } = buildProductionPlan(prods, flocks);
  const per = {};
  for (const r of rows) { const x = (per[r.code] ||= { rows: 0, from: r.date, to: r.date, eggs_total: 0, eggs_broken: 0 });
    x.rows++; if (r.date < x.from) x.from = r.date; if (r.date > x.to) x.to = r.date; x.eggs_total += r.eggs_total; x.eggs_broken += r.eggs_broken; }
  const body = { batch: BATCH, snapshot_id: cfg.source.snapshot_id, manifest_sha256: manifestSha, source: prods.length, mapped: rows.length,
    rejects: Object.fromEntries(Object.entries(rejects).map(([k, v]) => [k, v.length])), reject_ids: rejects, per_flock: per,
    months: [...new Set(rows.map((r) => `${r.date.slice(0, 7)}-01`))].sort(), rows };
  mkdirSync(opt.out, { recursive: true });
  const text = `${JSON.stringify(body, null, 1)}\n`;
  writeFileSync(join(opt.out, 'production-history-plan.json'), text);
  const planSha = sha(text);
  writeFileSync(join(opt.out, 'production-history-plan.sha256'), `${planSha}\n`);
  log(`plan: snapshot ${cfg.source.snapshot_id} source=${body.source} mapped=${body.mapped} rejected=${body.source - body.mapped} ${JSON.stringify(body.rejects)}`);
  for (const [k, x] of Object.entries(per)) log(`plan: ${k} rows=${x.rows} ${x.from}..${x.to} eggs_total=${x.eggs_total} eggs_broken=${x.eggs_broken}`);
  log(`plan: months=${body.months.join(',')} sha256=${planSha}`);
}

// ── target (same guards as the cutover runner: host, project ref, forbidden refs) ──
let TENV;
function targetEnv(cfg) {
  if (TENV) return TENV;
  const raw = process.env.CUTOVER_TARGET_DB_URL; if (!raw) die('TARGET', 'CUTOVER_TARGET_DB_URL is not set');
  let u; try { u = new URL(raw); } catch { die('TARGET', 'CUTOVER_TARGET_DB_URL is not a valid URL'); }
  const t = cfg.target; const host = u.hostname; const user = decodeURIComponent(u.username || '');
  if (host !== t.expected_host) die('TARGET', `target host ${host} differs from config target.expected_host`);
  if ((t.forbidden_hosts || []).includes(host)) die('TARGET', 'forbidden (legacy) host');
  const ref = (host.match(/^db\.([a-z0-9]{20})\.supabase\.co$/) || [])[1] || (user.match(/^postgres\.([a-z0-9]{20})$/) || [])[1] || null;
  if (ref !== t.expected_ref) die('TARGET', `connection project ref ${ref ?? 'UNKNOWN'} differs from config target.expected_ref`);
  if ((t.forbidden_refs || []).includes(ref)) die('TARGET', 'the connection is a LEGACY project ref: refusing');
  TENV = { client: t.psql_client_container, env: { PGHOST: host, PGPORT: u.port || '5432', PGUSER: user || 'postgres', PGPASSWORD: decodeURIComponent(u.password || ''),
    PGDATABASE: (u.pathname || '/postgres').slice(1) || 'postgres', PGSSLMODE: 'require' } };
  return TENV;
}
function tq(cfg, sqlText) {
  const t = targetEnv(cfg);
  const r = spawnSync('docker', ['exec', '-i', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE',
    t.client, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...t.env } });
  if (r.status !== 0) die('SQL', 'psql failed on the target', r.stderr);
  return (r.stdout || '').trim();
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readPlan() {
  const p = join(opt.out, 'production-history-plan.json');
  if (!existsSync(p)) die('PLAN', 'run plan first');
  const text = readFileSync(p, 'utf8'); const body = JSON.parse(text);
  if (body.batch !== BATCH) die('PLAN', 'plan batch differs');
  for (const r of body.rows) if (!UUID_RE.test(r.source_id) || !UUID_RE.test(r.flock_id) || !DATE_RE.test(r.date)
    || ![r.eggs_total, r.eggs_broken, r.eggs_dirty].every((n) => Number.isInteger(n) && n >= 0)) die('PLAN', `malformed plan row ${r.source_id}`);
  return { body, planSha: sha(text) };
}

function state(cfg, body) {
  const vals = body.rows.map((r) => `(${lit(r.flock_id)}::uuid, ${lit(r.date)}::date, ${lit(r.source_id)})`).join(',\n');
  return JSON.parse(tq(cfg, `BEGIN READ ONLY;
WITH v(flock_id, d, sid) AS (VALUES ${vals})
SELECT json_build_object(
  'flocks_not_active', (SELECT count(DISTINCT v.flock_id) FROM v LEFT JOIN flocks f ON f.id = v.flock_id WHERE f.estado IS DISTINCT FROM 'ACTIVE'),
  'months_not_open', (SELECT coalesce(json_agg(m ORDER BY m), '[]') FROM (SELECT DISTINCT date_trunc('month', d)::date m FROM v) mm
                       LEFT JOIN management_period mp ON mp.periodo_fecha = mm.m WHERE mp.status IS DISTINCT FROM 'OPEN'),
  'lineage_batch', (SELECT count(*) FROM phase26_migration.lineage WHERE import_batch = ${lit(BATCH)}),
  'lineage_ids', (SELECT coalesce(json_agg(v.sid), '[]') FROM v JOIN phase26_migration.lineage l ON l.source_system = ${lit(SOURCE_SYSTEM)} AND l.source_entity = 'producciones'
                     AND l.source_id = v.sid AND l.import_batch = ${lit(BATCH)}),
  'lineage_done', (SELECT count(*) FROM v JOIN phase26_migration.lineage l ON l.source_system = ${lit(SOURCE_SYSTEM)} AND l.source_entity = 'producciones'
                     AND l.source_id = v.sid AND l.import_batch = ${lit(BATCH)}),
  'overlap_without_lineage', (SELECT count(*) FROM v JOIN daily_production dp ON dp.flock_id = v.flock_id AND dp.production_date = v.d AND dp.is_current
                     WHERE NOT EXISTS (SELECT 1 FROM phase26_migration.lineage l WHERE l.import_batch = ${lit(BATCH)} AND l.target_entity = 'daily_production' AND l.target_key = dp.id::text)),
  'daily_production_total', (SELECT count(*) FROM daily_production WHERE is_current),
  'mortality_events', (SELECT count(*) FROM population_events WHERE event_type = 'MORTALITY' AND is_current),
  'mortality_total', (SELECT coalesce(sum(-delta), 0) FROM population_events WHERE event_type = 'MORTALITY' AND is_current),
  'population_events', (SELECT count(*) FROM population_events),
  'populations', (SELECT json_object_agg(f.id, f.initial_population + coalesce((SELECT sum(delta) FROM population_events pe WHERE pe.flock_id = f.id AND pe.is_current), 0)) FROM flocks f),
  'actor', (SELECT id FROM perfiles WHERE rol_type = 'ADMIN' AND activo ORDER BY id LIMIT 1)
)::text;
COMMIT;`).split('\n').filter(Boolean).pop());
}

function checkPopulation(body, s) {
  const code = Object.fromEntries(body.rows.map((r) => [r.flock_id, r.code]));
  const cfgFlocks = { '1167d99b-00db-4eee-8256-597e0678bee1': 'G01-2501', 'd65d3851-b8af-49a0-81b4-05ecdc25112a': 'G02-2509',
    '86496c5d-5c9f-44f3-8b8d-51138257534b': 'G03-2501', '909f2e1f-9d11-406b-a5e2-889c33b4b0a3': 'G04-2607', ...code };
  const bad = Object.entries(cfgFlocks).filter(([id, c]) => Number(s.populations[id]) !== EXPECTED_POPULATION[c]);
  return bad.map(([id, c]) => `${c}=${s.populations[id]} (expected ${EXPECTED_POPULATION[c]})`);
}

function check(cfg) {
  const { body, planSha } = readPlan(); const s = state(cfg, body);
  log(`check: plan ${planSha} rows=${body.rows.length}`);
  log(`check: flocks_not_active=${s.flocks_not_active} months_not_open=${JSON.stringify(s.months_not_open)} lineage_batch=${s.lineage_batch} lineage_done=${s.lineage_done} overlap_without_lineage=${s.overlap_without_lineage}`);
  log(`check: daily_production(current)=${s.daily_production_total} mortality events=${s.mortality_events} deaths=${s.mortality_total} population_events=${s.population_events} actor=${s.actor ? 'ADMIN present' : 'NONE'}`);
  const popBad = checkPopulation(body, s);
  const f = [];
  if (s.flocks_not_active) f.push('a planned flock is not ACTIVE (register_daily_production requires ACTIVE)');
  if (s.months_not_open.length) f.push(`management periods not OPEN: ${s.months_not_open.join(',')}`);
  if (s.overlap_without_lineage) f.push(`${s.overlap_without_lineage} planned (flock, date) already have a current daily_production not created by this batch`);
  if (!s.actor) f.push('no active ADMIN profile (migration actor)');
  if (popBad.length) f.push(`opening populations differ: ${popBad.join(' ')}`);
  if (f.length) die('CHECK', 'the target is not ready for the backfill', f.join('\n'));
  log(`check: PASS — to write: ${body.rows.length - s.lineage_done}, already done (lineage): ${s.lineage_done}`);
  return { body, planSha, s };
}

function apply(cfg) {
  if (process.env.PHASE31_BACKFILL_CONFIRM !== BATCH) die('CONFIRM', `set PHASE31_BACKFILL_CONFIRM=${BATCH}`);
  const { body, planSha, s } = check(cfg);
  if (opt['plan-sha'] !== planSha) die('CONFIRM', '--plan-sha must equal the reviewed plan sha256');
  const done = new Set(s.lineage_ids);
  const todo = body.rows.filter((r) => !done.has(r.source_id));          // idempotent: rows with lineage are skipped
  if (todo.length === 0) { log('apply: nothing to write (every plan row already has lineage)'); verify(cfg); return; }
  const claims = JSON.stringify({ sub: s.actor, role: 'authenticated' }).replace(/'/g, "''");
  const vals = todo.map((r) => `(${lit(r.source_id)}, ${lit(r.flock_id)}::uuid, ${lit(r.date)}::date)`).join(',\n  ');
  // one transaction: the frozen RPC as the ADMIN actor (authenticated role), then lineage as the session owner keyed
  // by the (flock, date) current row just created (check guaranteed no foreign current row on those keys), then the
  // population state is asserted unchanged before COMMIT
  tq(cfg, `BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '${claims}';
${todo.map((r) => `SELECT register_daily_production(${lit(r.flock_id)}::uuid, ${lit(r.date)}::date, ${r.eggs_total}, ${r.eggs_broken}, ${r.eggs_dirty}, ${lit(r.reason)});`).join('\n')}
RESET ROLE;
INSERT INTO phase26_migration.lineage (source_system, source_entity, source_id, import_batch, target_entity, target_key)
SELECT ${lit(SOURCE_SYSTEM)}, 'producciones', v.sid, ${lit(BATCH)}, 'daily_production', dp.id::text
  FROM (VALUES
  ${vals}) v(sid, flock_id, d)
  JOIN daily_production dp ON dp.flock_id = v.flock_id AND dp.production_date = v.d AND dp.is_current;
DO $$ BEGIN
  IF (SELECT count(*) FROM population_events) <> ${Number(s.population_events)} THEN RAISE EXCEPTION 'POPULATION_EVENTS_CHANGED'; END IF;
  IF (SELECT count(*) FROM phase26_migration.lineage WHERE import_batch = ${lit(BATCH)}) <> ${body.rows.length} THEN RAISE EXCEPTION 'LINEAGE_COUNT'; END IF;
END $$;
INSERT INTO phase26_migration.run_log (command, import_batch, config_sha256, plan_sha256) VALUES ('backfill-production-history', ${lit(BATCH)}, ${lit(sha(readFileSync(opt.config)))}, ${lit(planSha)}) ON CONFLICT DO NOTHING;
COMMIT;`);
  log(`apply: committed (rows planned ${body.rows.length}; previously done ${s.lineage_done})`);
  verify(cfg);
}

function verify(cfg) {
  const { body } = readPlan();
  const r = JSON.parse(tq(cfg, `BEGIN READ ONLY;
SELECT json_build_object(
  'lineage', (SELECT count(*) FROM phase26_migration.lineage WHERE import_batch = ${lit(BATCH)} AND target_entity = 'daily_production'),
  'matched', (SELECT count(*) FROM phase26_migration.lineage l JOIN daily_production dp ON dp.id::text = l.target_key AND dp.is_current WHERE l.import_batch = ${lit(BATCH)}),
  'eggs_total', (SELECT coalesce(sum(dp.eggs_total), 0) FROM phase26_migration.lineage l JOIN daily_production dp ON dp.id::text = l.target_key WHERE l.import_batch = ${lit(BATCH)}),
  'eggs_broken', (SELECT coalesce(sum(dp.eggs_broken), 0) FROM phase26_migration.lineage l JOIN daily_production dp ON dp.id::text = l.target_key WHERE l.import_batch = ${lit(BATCH)})
)::text;
COMMIT;`).split('\n').filter(Boolean).pop());
  const s = state(cfg, body);
  const want = body.rows.reduce((a, x) => ({ t: a.t + x.eggs_total, b: a.b + x.eggs_broken }), { t: 0, b: 0 });
  const f = [];
  if (r.lineage !== body.rows.length || r.matched !== body.rows.length) f.push(`lineage ${r.lineage} / matched ${r.matched} vs plan ${body.rows.length}`);
  if (Number(r.eggs_total) !== want.t || Number(r.eggs_broken) !== want.b) f.push(`eggs ${r.eggs_total}/${r.eggs_broken} vs plan ${want.t}/${want.b}`);
  if (s.mortality_events !== 190 || Number(s.mortality_total) !== 288) f.push(`mortality ${s.mortality_events}/${s.mortality_total} (expected 190/288)`);
  f.push(...checkPopulation(body, s).map((x) => `population ${x}`));
  log(`verify: lineage=${r.lineage} matched=${r.matched} eggs_total=${r.eggs_total} eggs_broken=${r.eggs_broken} mortality=${s.mortality_events}/${s.mortality_total}`);
  if (f.length) die('VERIFY', 'reconciliation failed', f.join('\n'));
  log('verify: PASS');
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  if (!['plan', 'check', 'apply', 'verify'].includes(command)) die('USAGE', 'command must be plan | check | apply | verify');
  const cfg = loadConfig();
  ({ plan, check, apply, verify })[command](cfg);
}
