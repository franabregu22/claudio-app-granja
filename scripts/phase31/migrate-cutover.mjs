#!/usr/bin/env node
/**
 * PHASE 31 — CLEAN-CUTOVER RUNNER, CUTOVER MODE (D-PC-7, ADR-017). Derived from the Phase 26 rehearsal
 * runner (scripts/phase26/migrate-clean-cutover.mjs, kept unchanged as historical evidence; its rehearsal
 * mode stays the CT contract's loader).
 *
 * SOURCE  the restored FINAL legacy snapshot in the read-only container (config.source), SELECT only.
 * TARGET  the fresh target project, reached with CUTOVER_TARGET_DB_URL from the environment (never stored,
 *         never printed), through `psql` inside config.target.psql_client_container. config.target.kind:
 *           PRODUCTION_TARGET        the new Supabase project (also needs PHASE31_CUTOVER_CONFIRM = import_batch)
 *           LOCAL_CUTOVER_REHEARSAL  the guarded local stack, for rehearsals and the regression suite
 *
 * Commands:
 *   gates       evaluate the config contract (Phase 26 gate list verbatim + the Phase 31 contract); any refusal stops
 *   extract     verify the final snapshot manifest; extract masters / state; build the plan (with openings + boundary)
 *   auth-check  read-only Auth reconciliation on the target (counts / ids / providers; never hashes, tokens or emails)
 *   load        preflight (ledger = files, target unused, Auth present, boundary) then load masters, population,
 *               openings and the MP cutover boundary; idempotent; never writes auth.*
 *   validate    run scripts/phase31/validate-cutover.sql (C01–C25) and write the validation + state digest
 *
 * Usage: node scripts/phase31/migrate-cutover.mjs <command> --config <json outside the repo> --out <dir outside the repo>
 *        [--legacy-auth-ids <file of legacy auth.users ids, one per line>]   (auth-check only)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafeDestructiveTarget, assertNoProductionCredentials } from '../test-env/guard.mjs';
import { cutoverGateFailures, cutoverBusinessDate, ACCOUNTS, UUID_RE } from './cutover-config.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE_SQL = join(HERE, 'validate-cutover.sql');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'target-migrations');
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

// ── args (parsed only when run as a command; importing the module has no side effect) ──
const IS_MAIN = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
let command; let opt = {}; let CONFIG_TEXT; let CONFIG; let CONFIG_SHA;
function init() {
  const [cmd, ...rest] = process.argv.slice(2);
  command = cmd;
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (!['gates', 'extract', 'auth-check', 'load', 'validate'].includes(command)) die('USAGE', 'unknown command');
  if (!opt.config || !existsSync(opt.config)) die('USAGE', '--config file missing');
  if (!opt.out) die('USAGE', '--out directory missing');
  if (resolve(opt.config).startsWith(REPO_ROOT) || resolve(opt.out).startsWith(REPO_ROOT)) {
    // the real config holds owner-validated values and the out dir holds the plan: never inside the repository
    die('USAGE', '--config and --out must be outside the repository');
  }
  mkdirSync(opt.out, { recursive: true });
  CONFIG_TEXT = readFileSync(opt.config, 'utf8');
  try { CONFIG = JSON.parse(CONFIG_TEXT); } catch { die('CONFIG', 'config is not valid JSON'); }
  CONFIG_SHA = sha256(CONFIG_TEXT);
}

export class CutoverError extends Error { constructor(code, msg) { super(`[${code}] ${msg}`); this.code = code; } }
function die(code, msg, detail) {
  if (!IS_MAIN) throw new CutoverError(code, msg);   // imported (regression suite): never exit the importer
  console.error(`\nCUTOVER FAILED [${code}]: ${msg}`);
  if (detail) console.error(String(detail).split('\n').slice(0, 40).map((l) => `  ${l}`).join('\n'));
  process.exit(1);
}
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function log(s) { console.log(`[phase31] ${s}`); }

// ── docker / psql ───────────────────────────────────────────────────────────
function resolveDockerBin() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  return existsSync(c) ? c : 'docker';
}
const DOCKER = resolveDockerBin();
function running(name) {
  const r = spawnSync(DOCKER, ['ps', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  return (r.stdout || '').trim() === name;
}
function legacyExec(sqlText) {
  const name = CONFIG.source.legacy_copy_container;
  if (!running(name)) die('SOURCE', `legacy copy container ${name} is not running`);
  const r = spawnSync(DOCKER, ['exec', '-i', name, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres',
    '-d', CONFIG.source.legacy_copy_database || 'postgres', '-f', '-'], { encoding: 'utf8', input: sqlText, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) die('SQL', 'psql failed on the legacy copy', r.stderr);
  return (r.stdout || '').trim();
}

let TARGET;
function target() {
  if (TARGET) return TARGET;
  const raw = process.env.CUTOVER_TARGET_DB_URL;
  if (!raw) die('TARGET', 'CUTOVER_TARGET_DB_URL is not set (exported by the owner in their own shell; never stored or printed)');
  let u;
  try { u = new URL(raw); } catch { die('TARGET', 'CUTOVER_TARGET_DB_URL is not a valid URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) die('TARGET', 'CUTOVER_TARGET_DB_URL must be a postgresql:// URL');
  const t = CONFIG.target;
  const host = u.hostname;
  if (host !== t.expected_host) die('TARGET', `target host ${host} differs from config target.expected_host`);
  if ((t.forbidden_hosts || []).includes(host)) die('TARGET', `target host ${host} is a forbidden (legacy) host`);
  if (t.kind === 'LOCAL_CUTOVER_REHEARSAL') {
    assertNoProductionCredentials(process.env);
    assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
    if (!/^supabase_db/.test(t.psql_client_container)) die('TARGET', 'a local rehearsal must use the local supabase_db container as psql client');
  } else if (t.kind === 'PRODUCTION_TARGET') {
    if (process.env.PHASE31_CUTOVER_CONFIRM !== CONFIG.import_batch) die('TARGET', 'PHASE31_CUTOVER_CONFIRM must equal the config import_batch (explicit owner confirmation)');
  } else die('TARGET', 'unknown target.kind');
  if (!running(t.psql_client_container)) die('TARGET', `psql client container ${t.psql_client_container} is not running`);
  TARGET = {
    client: t.psql_client_container,
    env: {
      PGHOST: host, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username || 'postgres'), PGPASSWORD: decodeURIComponent(u.password || ''),
      PGDATABASE: (u.pathname || '/postgres').slice(1) || 'postgres',
      PGSSLMODE: u.searchParams.get('sslmode') || (t.kind === 'PRODUCTION_TARGET' ? 'require' : 'disable'),
    },
  };
  return TARGET;
}
function targetExec(sqlText, extra = []) {
  const t = target();
  // the connection travels as libpq environment variables named on the command line (values come from this
  // process's environment, never from argv), so nothing secret appears in a process list or a log
  const r = spawnSync(DOCKER, ['exec', '-i', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE',
    t.client, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra, '-f', '-'],
  { encoding: 'utf8', input: sqlText, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...t.env } });
  if (r.error) die('DOCKER', 'could not run docker', r.error.message);
  if (r.status !== 0) die('SQL', 'psql failed on the cutover target', (r.stderr || '').replace(/password[^\s]*/gi, 'password=***'));
  return (r.stdout || '').trim();
}

// ── SQL literal helpers (values are validated before quoting) ──────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const uuid = (v) => { if (!UUID_RE.test(v)) die('DATA', `invalid uuid ${v}`); return `'${v}'::uuid`; };
const date = (v) => { if (v === null) return 'NULL::date'; if (!DATE_RE.test(v)) die('DATA', `invalid date ${v}`); return `'${v}'::date`; };
const int = (v) => { if (!Number.isInteger(v)) die('DATA', `invalid integer ${v}`); return String(v); };
const money = (v) => { if (!/^-?[0-9]{1,13}(\.[0-9]{1,2})?$/.test(v)) die('DATA', `invalid amount ${v}`); return `${v}::numeric(15,2)`; };
const detUuid = (key) => { const h = createHash('md5').update(`phase26:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const values = (rows, fn) => rows.map(fn).join(',\n  ');

// ── gates ───────────────────────────────────────────────────────────────────
function runGates() {
  const f = cutoverGateFailures(CONFIG);
  if (f.length) die('CUTOVER_GATE', `cutover refused: ${f.length} placeholder(s), unvalidated or malformed value(s)`, f.join('\n'));
  log(`gates: config ${CONFIG.config_id} v${CONFIG.config_version} sha256=${CONFIG_SHA} target=${CONFIG.target.kind} — all gates pass`);
}

// ── extract (read-only on the legacy copy) ─────────────────────────────────
const FINGERPRINT_SQL = `SELECT json_object_agg(relname, h ORDER BY relname) FROM (
  SELECT c.relname, (xpath('/row/h/text()', query_to_xml(format(
    'select md5(coalesce(string_agg(t::text, E''\\n'' order by t::text), '''')) as h from public.%I t', c.relname), false, true, '')))[1]::text AS h
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r') x;`;
const EXTRACT_SQL = `SELECT json_build_object(
 'perfiles', (SELECT coalesce(json_agg(json_build_object('id', id, 'rol', rol::text) ORDER BY id), '[]') FROM perfiles),
 'clientes', (SELECT coalesce(json_agg(json_build_object('id', id, 'nombre', nombre, 'activo', coalesce(activo, true)) ORDER BY id), '[]') FROM clientes),
 'productos', (SELECT coalesce(json_agg(json_build_object('id', id, 'nombre', nombre, 'categoria', categoria, 'unidad', unidad, 'activo', coalesce(activo, true)) ORDER BY id), '[]') FROM productos),
 'categorias_finanzas', (SELECT coalesce(json_agg(json_build_object('id', id, 'categoria_tecnica', categoria_tecnica, 'subcategoria', subcategoria,
                          'categoria_analisis', categoria_analisis, 'activo', coalesce(activo, true)) ORDER BY id), '[]') FROM categorias_finanzas),
 'lotes', (SELECT coalesce(json_agg(json_build_object('id', id, 'galpon', galpon, 'fecha_entrada', fecha_entrada, 'fecha_salida', fecha_salida,
            'aves', aves_iniciales_postura, 'linea', linea, 'code', lote_id, 'estado', estado::text) ORDER BY id), '[]') FROM lotes),
 'mortality', (SELECT coalesce(json_agg(json_build_object('id', id, 'galpon', galpon, 'fecha', fecha, 'deaths', mortandad) ORDER BY fecha, galpon, id), '[]')
               FROM producciones WHERE coalesce(mortandad, 0) > 0),
 'production_rows', (SELECT count(*) FROM producciones),
 'counts', (SELECT json_object_agg(relname, n ORDER BY relname) FROM (SELECT c.relname,
            (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::int AS n
            FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r') y)
)::text;`;

export function buildPlan(src, cfg) {
  const roleMap = cfg.users.role_map;
  // users: ids preserved; the email is NOT planned — it is read from the restored auth.users at load time
  const users = src.perfiles.map((p) => {
    const role = roleMap[p.rol]; if (!role) die('PLAN', `unmapped legacy role ${p.rol}`);
    return { id: p.id, role };
  });
  const admins = users.filter((u) => u.role === 'ADMIN').map((u) => u.id).sort();
  if (!admins.length) die('PLAN', 'no ADMIN profile to act as migration actor');
  const actor = admins[0];
  const products = src.productos.map((p) => {
    const t = cfg.products.type_by_legacy_categoria[p.categoria]; const u = cfg.products.unit_map[p.unidad];
    if (!t || !u) die('PLAN', `unmapped product ${p.id} (${p.categoria}/${p.unidad})`);
    return { ...p, product_type: t, unit_type: u };
  });
  const ecfg = cfg.expense_categories;
  const categories = src.categorias_finanzas.map((c) => {
    const k = ecfg.class_map?.[String(c.id)];
    if (!['DIRECT', 'INDIRECT'].includes(k)) die('PLAN', `expense category ${c.id} has no DIRECT/INDIRECT class in class_map`);
    return { id: detUuid(`expense_category:${c.id}`), legacy_id: String(c.id), nombre: c.subcategoria,
      description: `${c.categoria_tecnica} / ${c.categoria_analisis}`, activo: c.activo, pnl_cost_class: k };
  });
  const extraClass = Object.keys(ecfg.class_map).filter((k) => !src.categorias_finanzas.some((c) => String(c.id) === k));
  if (extraClass.length) die('PLAN', 'class_map has categories absent from the snapshot', extraClass.join(','));
  if (new Set(categories.map((c) => c.nombre)).size !== categories.length) die('PLAN', 'expense_category nombre collision');
  const ov = cfg.flocks.owner_overrides || {};
  const flocks = src.lotes.map((l) => {
    const o = ov[l.id] || {};
    const estado = o.target_estado || cfg.flocks.estado_map[l.estado];
    if (!estado) die('PLAN', `unmapped lote estado ${l.estado} for ${l.id}`);
    return { id: l.id, galpon: o.galpon || l.galpon, shed_id: detUuid(`shed:${o.galpon || l.galpon}`), estado,
      entry_date: l.fecha_entrada, exit_date: o.exit_date !== undefined ? o.exit_date : l.fecha_salida,
      initial: Number(l.aves), genetics_line: l.linea, legacy_code: l.code, target_code: o.target_code || l.code,
      legacy_estado: l.estado, open_confirmed: estado === 'ACTIVE' };
  });
  const perShedActive = {};
  flocks.filter((f) => f.estado === 'ACTIVE').forEach((f) => { perShedActive[f.galpon] = (perShedActive[f.galpon] || 0) + 1; });
  if (Object.values(perShedActive).some((n) => n > 1)) die('PLAN', 'more than one ACTIVE flock in a shed');
  const sheds = [...new Set(flocks.map((f) => f.galpon))].sort().map((g) => ({ id: detUuid(`shed:${g}`), nombre: g }));
  // population: mortality history (P-a arithmetic), then for P-b one COUNT_ADJUSTMENT per flock on the cutover date
  const occupies = (f, day) => f.entry_date <= day && (f.exit_date === null || day <= f.exit_date)
    && (f.exit_date !== null || f.legacy_estado !== 'Retirado' || f.open_confirmed);
  const events = src.mortality.map((m) => {
    const c = flocks.filter((f) => f.galpon === m.galpon && occupies(f, m.fecha));
    if (c.length !== 1) die('PLAN', `mortality row ${m.id} (${m.galpon} ${m.fecha}) maps to ${c.length} flocks`);
    return { source_id: m.id, flock_id: c[0].id, event_date: m.fecha, deaths: Number(m.deaths), reason: `legacy:producciones:${m.id} ${cfg.import_batch}` };
  });
  const keys = new Set(events.map((e) => `${e.flock_id}|${e.event_date}`));
  if (keys.size !== events.length) die('PLAN', 'two mortality rows for the same flock and date (target allows one current MORTALITY)');
  const cutoverDate = cutoverBusinessDate(cfg.cutover_boundary.cutover_at);
  const population = {};
  const adjustments = [];
  for (const f of flocks) {
    const ev = events.filter((e) => e.flock_id === f.id);
    const total = ev.reduce((s, e) => s + e.deaths, 0);
    const arithmetic = { code: f.target_code, initial: f.initial, mortality_events: ev.length, mortality_total: total, population: f.initial - total };
    if (arithmetic.population < 0) die('ARITHMETIC', `negative population for ${f.id}`);
    const exp = cfg.population.expected[f.id];
    if (!exp || JSON.stringify(exp) !== JSON.stringify(arithmetic)) die('ARITHMETIC', `population for ${f.id} differs from the owner-accepted expectation`,
      `computed ${JSON.stringify(arithmetic)}\nexpected ${JSON.stringify(exp)}`);
    population[f.id] = { ...arithmetic };
    if (cfg.population.method === 'P-b' && f.estado === 'ACTIVE') {
      const counted = cfg.population.counts[f.id];
      if (!Number.isInteger(counted)) die('PLAN', `P-b: no physical count for active flock ${f.id}`);
      const delta = counted - arithmetic.population;
      if (delta !== 0) adjustments.push({ flock_id: f.id, event_date: cutoverDate, delta, reason: `phase31:physical-count ${cfg.import_batch}` });
      population[f.id] = { ...arithmetic, physical_count: counted, population: counted };
    }
  }
  if (cfg.population.method === 'P-b') {
    const extra = Object.keys(cfg.population.counts).filter((id) => !flocks.some((f) => f.id === id && f.estado === 'ACTIVE'));
    if (extra.length) die('PLAN', 'P-b counts for unknown or non-active flocks', extra.join(','));
  }
  const totalDeaths = events.reduce((s, e) => s + e.deaths, 0);
  if (events.length !== cfg.population.expected_totals.mortality_events || totalDeaths !== cfg.population.expected_totals.mortality_total)
    die('ARITHMETIC', `mortality totals ${events.length}/${totalDeaths} differ from config`);
  // operator assignments: explicit owner list
  const opIds = new Set(users.filter((u) => u.role === 'OPERATOR').map((u) => u.id));
  const assignments = cfg.users.operator_assignments.assignments.map((a) => {
    if (!opIds.has(a.operator_id)) die('PLAN', `assignment operator ${a.operator_id} is not a migrated OPERATOR`);
    if (!flocks.some((f) => f.id === a.flock_id && f.estado === 'ACTIVE')) die('PLAN', `assignment flock ${a.flock_id} is not an ACTIVE migrated flock`);
    return { id: detUuid(`assignment:${a.operator_id}:${a.flock_id}`), operator_id: a.operator_id, flock_id: a.flock_id };
  });
  if (new Set(assignments.map((a) => a.id)).size !== assignments.length) die('PLAN', 'duplicate operator assignment');
  // client openings: exactly one entry per migrated client
  const ob = cfg.clients.opening_balances;
  const missing = src.clientes.filter((c) => ob[c.id] === undefined).map((c) => c.id);
  const unknown = Object.keys(ob).filter((id) => !src.clientes.some((c) => c.id === id));
  if (missing.length) die('PLAN', `clients.opening_balances lacks ${missing.length} migrated client(s)`, missing.join('\n'));
  if (unknown.length) die('PLAN', `clients.opening_balances names ${unknown.length} client(s) absent from the snapshot`, unknown.join('\n'));
  const clientOpenings = src.clientes.filter((c) => Number(ob[c.id]) !== 0).map((c) => ({ cliente_id: c.id, amount: ob[c.id] }));
  const treasuryOpenings = ACCOUNTS.filter((n) => Number(cfg.treasury.opening_balances[n]) !== 0).map((n) => ({ account: n, amount: cfg.treasury.opening_balances[n] }));
  const classified = new Set([...cfg.evidence_only_sources, 'perfiles', 'clientes', 'productos', 'categorias_finanzas', 'lotes', 'cuentas_caja', 'producciones']);
  const missingSrc = Object.keys(src.counts).filter((t) => !classified.has(t));
  if (missingSrc.length || Object.keys(src.counts).length !== 26) die('SCOPE', 'source table not classified', missingSrc.join(','));
  return { actor, users, clients: src.clientes, products, categories, sheds, flocks, events, adjustments, assignments, population,
    client_openings: clientOpenings, treasury_openings: treasuryOpenings,
    cutover: { cutover_at: cfg.cutover_boundary.cutover_at, cutover_date: cutoverDate, evidence_ref: cfg.cutover_boundary.evidence_ref },
    counts: src.counts, production_rows: src.production_rows };
}

function runExtract() {
  const manifest = readFileSync(join(CONFIG.source.snapshot_dir, 'manifest.json'));
  if (sha256(manifest) !== CONFIG.source.manifest_sha256) die('SOURCE', 'final snapshot manifest hash differs from config');
  const fp = JSON.parse(legacyExec(FINGERPRINT_SQL));
  if (Object.keys(fp).length !== 26) die('SOURCE', `legacy copy holds ${Object.keys(fp).length} public tables, expected 26`);
  const src = JSON.parse(legacyExec(EXTRACT_SQL));
  const plan = buildPlan(src, CONFIG);
  writePlan(plan, fp);
}
export function writePlanFile(outDir, cfgSha, cfg, plan, fp) {  // also used by the regression suite
  const planText = JSON.stringify({ config_id: cfg.config_id, config_version: cfg.config_version, config_sha256: cfgSha,
    import_batch: cfg.import_batch, source_fingerprint: fp, plan }, null, 2);
  writeFileSync(join(outDir, 'plan.json'), planText);
  writeFileSync(join(outDir, 'plan.json.sha256'), `${sha256(planText)}  plan.json\n`);
  return sha256(planText);
}
function writePlan(plan, fp) {
  const h = writePlanFile(opt.out, CONFIG_SHA, CONFIG, plan, fp);
  log(`extract: plan.json sha256=${h} users=${plan.users.length} clients=${plan.clients.length} products=${plan.products.length} `
    + `categories=${plan.categories.length} flocks=${plan.flocks.length} events=${plan.events.length} adjustments=${plan.adjustments.length} `
    + `client_openings=${plan.client_openings.length} treasury_openings=${plan.treasury_openings.length} cutover_date=${plan.cutover.cutover_date}`);
}
function readPlan() {
  const text = readFileSync(join(opt.out, 'plan.json'), 'utf8');
  const recorded = readFileSync(join(opt.out, 'plan.json.sha256'), 'utf8').split(/\s+/)[0];
  if (sha256(text) !== recorded) die('PLAN', 'plan.json hash mismatch');
  const doc = JSON.parse(text);
  if (doc.config_sha256 !== CONFIG_SHA) die('PLAN', 'plan was built from a different config');
  return doc;
}

// ── target preflight ────────────────────────────────────────────────────────
function ledgerCheck() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => FILE_PATTERN.test(f)).sort();
  const expected = files.map((f) => `${f.match(FILE_PATTERN)[1]}|${f}|${sha256(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))}`);
  const ledger = targetExec(`SELECT version || '|' || filename || '|' || sha256 FROM migration_ledger.applied ORDER BY version;`).split('\n').filter(Boolean);
  if (ledger.join('\n') !== expected.join('\n')) die('LEDGER', `target ledger (${ledger.length}) differs from the ${files.length} migration files (version / filename / sha256)`);
  return files.length;
}
const AUTH_COUNTS_SQL = (ids, allowed, provider) => `SELECT json_build_object(
  'auth_users', (SELECT count(*) FROM auth.users),
  'planned', ${ids.length},
  'missing', (SELECT count(*) FROM (VALUES ${ids.map((i) => `(${uuid(i)})`).join(', ')}) v(id) LEFT JOIN auth.users u ON u.id = v.id WHERE u.id IS NULL),
  'bad_email', (SELECT count(*) FROM auth.users u WHERE u.id IN (${ids.map(uuid).join(', ')}) AND (u.email IS NULL OR btrim(u.email) = '' OR u.email ILIKE '%@example.invalid')),
  'without_identity', (SELECT count(*) FROM (VALUES ${ids.map((i) => `(${uuid(i)})`).join(', ')}) v(id)
                        WHERE NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = v.id AND i.provider = ${lit(provider)})),
  'unexpected_users', (SELECT count(*) FROM auth.users u WHERE u.id NOT IN (${[...ids, ...allowed].map(uuid).join(', ')})),
  'identities_by_provider', (SELECT coalesce(json_object_agg(provider, n), '{}') FROM (SELECT provider, count(*) n FROM auth.identities GROUP BY provider) x),
  'sessions', (SELECT count(*) FROM auth.sessions), 'refresh_tokens', (SELECT count(*) FROM auth.refresh_tokens),
  'auth_triggers', (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('auth.users'::regclass, 'auth.identities'::regclass) AND NOT tgisinternal),
  'example_invalid_anywhere', (SELECT count(*) FROM auth.users WHERE email ILIKE '%@example.invalid')
    + (SELECT count(*) FROM perfiles WHERE email ILIKE '%@example.invalid')
)::text;`;
function authReport(plan) {
  const ids = plan.users.map((u) => u.id);
  return JSON.parse(targetExec(AUTH_COUNTS_SQL(ids, CONFIG.auth.allowed_extra_user_ids, CONFIG.auth.required_identity_provider)));
}
function authFailures(a) {
  const f = [];
  if (a.missing > 0) f.push(`AUTH_USER_MISSING: ${a.missing} planned profile id(s) have no auth.users row (restore the Auth data first)`);
  if (a.bad_email > 0) f.push(`AUTH_EMAIL_INVALID: ${a.bad_email} planned user(s) have no real email`);
  if (a.without_identity > 0) f.push(`AUTH_IDENTITY_MISSING: ${a.without_identity} planned user(s) have no ${CONFIG.auth.required_identity_provider} identity`);
  if (a.unexpected_users > 0) f.push(`AUTH_UNEXPECTED_USER: ${a.unexpected_users} auth.users row(s) are neither planned nor allowed`);
  if (a.example_invalid_anywhere > 0) f.push('EXAMPLE_INVALID_PRESENT: a synthetic @example.invalid email exists on the target');
  if (a.auth_triggers > 0) f.push('AUTH_TRIGGER_PRESENT: a trigger exists on auth.users / auth.identities');
  return f;
}
function runAuthCheck() {
  runGates();
  const doc = readPlan();
  const a = authReport(doc.plan);
  const f = authFailures(a);
  if (a.sessions > 0 || a.refresh_tokens > 0) f.push(`AUTH_SESSIONS_PRESENT: sessions=${a.sessions} refresh_tokens=${a.refresh_tokens} (session rows must not be migrated)`);
  if (opt['legacy-auth-ids']) {
    const legacy = readFileSync(opt['legacy-auth-ids'], 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (legacy.some((i) => !UUID_RE.test(i))) f.push('LEGACY_IDS_FILE: a line is not a uuid');
    const tgt = targetExec('SELECT id FROM auth.users ORDER BY id;').split('\n').filter(Boolean);
    const a1 = [...legacy].sort().join(','); const a2 = [...tgt].sort().join(',');
    if (a1 !== a2) f.push(`AUTH_UUID_MISMATCH: legacy ${legacy.length} id(s) vs target ${tgt.length} (sorted id lists differ)`);
    else log(`auth-check: legacy and target auth.users id lists are identical (${legacy.length})`);
  }
  log(`auth-check: auth.users=${a.auth_users} planned=${a.planned} identities=${JSON.stringify(a.identities_by_provider)} sessions=${a.sessions} refresh_tokens=${a.refresh_tokens}`);
  if (f.length) die('AUTH', 'Auth reconciliation failed', f.join('\n'));
  log('auth-check: PASS');
}

// ── load ────────────────────────────────────────────────────────────────────
function runLoad() {
  const doc = readPlan(); const p = doc.plan; const B = CONFIG.import_batch; const S = CONFIG.source.source_system;
  const nFiles = ledgerCheck();
  // Auth must already be restored (D-PC-7): this runner never writes auth.*
  const a = authReport(p);
  const af = authFailures(a);
  if (af.length) die('AUTH', 'Auth preflight failed (nothing written)', af.join('\n'));
  // the target must be unused: no business fact, no foreign profile, boundary absent or equal, no test fixture
  const use = JSON.parse(targetExec(`SELECT json_build_object(
    'facts', (SELECT count(*) FROM pedidos) + (SELECT count(*) FROM collections) + (SELECT count(*) FROM purchases) + (SELECT count(*) FROM daily_production)
           + (SELECT count(*) FROM mp_source_record) + (SELECT count(*) FROM mp_webhook_delivery) + (SELECT count(*) FROM sales_session)
           + (SELECT count(*) FROM classification) + (SELECT count(*) FROM feed_manufacturing) + (SELECT count(*) FROM management_event),
    'foreign_profiles', (SELECT count(*) FROM perfiles WHERE id NOT IN (${p.users.map((u) => uuid(u.id)).join(', ')})),
    'foreign_client_ledger', (SELECT count(*) FROM client_ledger WHERE NOT (movement_type = 'OPENING_BALANCE' AND source_entity_type = 'phase31_opening')),
    'foreign_operations', (SELECT count(*) FROM financial_operation WHERE external_ref IS NULL OR external_ref NOT LIKE ${lit(`PHASE31-OPENING:${B}:%`)}),
    'boundary', (SELECT row_to_json(b) FROM (SELECT cutover_at, import_batch FROM mp_cutover_boundary) b),
    'lineage_exists', to_regclass('phase26_migration.lineage') IS NOT NULL)::text;`));
  // the lineage schema exists only after a first load: query it in a second step (a CASE would still resolve the relation)
  use.other_batch_lineage = use.lineage_exists
    ? Number(targetExec(`SELECT count(*) FROM phase26_migration.lineage WHERE import_batch <> ${lit(B)};`)) : 0;
  if (use.facts > 0) die('TARGET_IN_USE', `the target already holds ${use.facts} business fact row(s); cutover load runs only on a fresh target`);
  if (use.foreign_profiles > 0) die('TARGET_IN_USE', `${use.foreign_profiles} perfiles row(s) are not in the plan`);
  if (use.foreign_client_ledger > 0 || use.foreign_operations > 0) die('TARGET_IN_USE', 'client ledger / treasury rows other than this batch\'s openings exist');
  if (use.other_batch_lineage > 0) die('TARGET_IN_USE', 'lineage from another import batch exists (rehearsal residue?)');
  if (use.boundary) {
    if (use.boundary.import_batch !== B) die('BOUNDARY', `mp_cutover_boundary already holds a boundary of batch ${use.boundary.import_batch}`);
    const same = targetExec(`SELECT cutover_at = ${lit(p.cutover.cutover_at)}::timestamptz FROM mp_cutover_boundary;`);
    if (same !== 't') die('BOUNDARY', 'mp_cutover_boundary already holds a different cutover_at for this batch');
  }
  const dateOk = targetExec(`SELECT (${lit(p.cutover.cutover_at)}::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = ${date(p.cutover.cutover_date)};`);
  if (dateOk !== 't') die('BOUNDARY', 'cutover business date differs between the plan and the database timezone conversion');

  const lineage = [];
  const lin = (entity, sid, tentity, tkey) => lineage.push(`(${lit(S)}, ${lit(entity)}, ${lit(sid)}, ${lit(B)}, ${lit(tentity)}, ${lit(tkey)})`);
  p.users.forEach((u) => lin('perfiles', u.id, 'perfiles', u.id));
  p.clients.forEach((c) => lin('clientes', c.id, 'clients', c.id));
  p.products.forEach((x) => lin('productos', x.id, 'products', x.id));
  p.categories.forEach((c) => lin('categorias_finanzas', c.legacy_id, 'expense_category', c.id));
  p.flocks.forEach((f) => { lin('lotes', f.id, 'flocks', f.id); lin('lotes', `${f.id}#shed`, 'sheds', f.shed_id); });
  p.assignments.forEach((x) => lin('config:operator_assignment', `${x.operator_id}:${x.flock_id}`, 'operator_assignments', x.id));
  p.events.forEach((e) => lin('producciones', e.source_id, 'population_events', `${e.flock_id}|${e.event_date}|MORTALITY`));
  p.adjustments.forEach((e) => lin('config:physical_count', e.flock_id, 'population_events', `${e.flock_id}|${e.event_date}|COUNT_ADJUSTMENT`));
  p.client_openings.forEach((o) => lin('config:client_opening', o.cliente_id, 'client_ledger', `OPENING_BALANCE|${o.cliente_id}`));
  p.treasury_openings.forEach((o) => lin('config:treasury_opening', o.account, 'financial_operation', `PHASE31-OPENING:${B}:${o.account}`));
  lin('config:mp_cutover_boundary', B, 'mp_cutover_boundary', 'singleton');

  const PLAN_SHA = sha256(readFileSync(join(opt.out, 'plan.json'), 'utf8'));
  const eventMonths = [...new Set([...p.events.map((e) => e.event_date), p.cutover.cutover_date].map((d) => `${d.slice(0, 7)}-01`))].sort();
  const expected = [
    ['population', p.population],
    ['counts', { users: p.users.length, admins: p.users.filter((u) => u.role === 'ADMIN').length,
      operators: p.users.filter((u) => u.role === 'OPERATOR').length, clients: p.clients.length, products: p.products.length,
      categories: p.categories.length, sheds: p.sheds.length, flocks: p.flocks.length, active_flocks: p.flocks.filter((f) => f.estado === 'ACTIVE').length,
      assignments: p.assignments.length, events: p.events.length + p.adjustments.length, mortality_events: p.events.length,
      adjustments: p.adjustments.length, lineage: lineage.length,
      allowed_extra_auth_users: CONFIG.auth.allowed_extra_user_ids.length }],
    ['product_types', Object.fromEntries(p.products.map((x) => [x.id, x.product_type]))],
    ['import_batch', B],
    ['category_classes', { policy: CONFIG.expense_categories.class_policy, rehearsal_class: null,
      by_id: Object.fromEntries(p.categories.map((c) => [c.id, c.pnl_cost_class])) }],
    ['plan', { config_sha256: CONFIG_SHA, plan_sha256: PLAN_SHA }],
    ['client_openings', Object.fromEntries(p.client_openings.map((o) => [o.cliente_id, o.amount]))],
    ['treasury_openings', Object.fromEntries(p.treasury_openings.map((o) => [o.account, o.amount]))],
    ['cutover', p.cutover],
  ];
  const expectedRows = values(expected, ([k, v]) => `(${lit(k)}, ${lit(JSON.stringify(v))}::jsonb)`);
  const divergence = (table, cols, rows, fn) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM (VALUES\n  ${values(rows, fn)}) v(${cols.join(', ')})
  LEFT JOIN ${table} t ON t.id = v.id WHERE t.id IS NULL OR (${cols.slice(1).map((c) => `t.${c}`).join(', ')}) IS DISTINCT FROM (${cols.slice(1).map((c) => `v.${c}`).join(', ')}))
  THEN RAISE EXCEPTION 'DIVERGENCE in ${table}'; END IF; END $$;`;
  const userRows = values(p.users, (u) => `(${uuid(u.id)}, ${lit(u.role)}::rol_type)`);

  const masters = `BEGIN;
DO $$ BEGIN IF to_regnamespace('phase26_migration') IS NULL THEN
  CREATE SCHEMA phase26_migration;
  REVOKE ALL ON SCHEMA phase26_migration FROM PUBLIC, anon, authenticated, service_role;
  CREATE TABLE phase26_migration.lineage (source_system text NOT NULL, source_entity text NOT NULL, source_id text NOT NULL,
    import_batch text NOT NULL, target_entity text NOT NULL, target_key text NOT NULL,
    PRIMARY KEY (source_system, source_entity, source_id, import_batch), UNIQUE (import_batch, target_entity, target_key));
  CREATE TABLE phase26_migration.expected (key text PRIMARY KEY, value jsonb NOT NULL);
  CREATE TABLE phase26_migration.run_log (command text NOT NULL, import_batch text NOT NULL, config_sha256 text NOT NULL,
    plan_sha256 text NOT NULL, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (command, import_batch, config_sha256, plan_sha256));
END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM (VALUES ${eventMonths.map((m) => `(${date(m)})`).join(', ')}) v(m)
  LEFT JOIN management_period mp ON mp.periodo_fecha = v.m WHERE mp.status IS DISTINCT FROM 'OPEN') THEN
  RAISE EXCEPTION 'PERIOD_NOT_OPEN: an event / cutover month has no OPEN management_period'; END IF; END $$;

-- users: profiles for the RESTORED auth users; email from auth.users (never synthetic, never planned)
INSERT INTO perfiles (id, email, rol_type, activo)
SELECT v.id, u.email, v.rol, true FROM (VALUES
  ${userRows}) v(id, rol) JOIN auth.users u ON u.id = v.id
ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM (VALUES
  ${userRows}) v(id, rol) LEFT JOIN perfiles p ON p.id = v.id LEFT JOIN auth.users u ON u.id = v.id
  WHERE p.id IS NULL OR u.id IS NULL OR p.email IS DISTINCT FROM u.email OR p.rol_type IS DISTINCT FROM v.rol OR NOT p.activo)
  THEN RAISE EXCEPTION 'DIVERGENCE in perfiles (profile / auth.users correspondence)'; END IF; END $$;

INSERT INTO clients (id, nombre, activo) VALUES
  ${values(p.clients, (c) => `(${uuid(c.id)}, ${lit(c.nombre)}, ${c.activo ? 'true' : 'false'})`)}
ON CONFLICT (id) DO NOTHING;
${divergence('clients', ['id', 'nombre', 'activo'], p.clients, (c) => `(${uuid(c.id)}, ${lit(c.nombre)}::text, ${c.activo ? 'true' : 'false'})`)}
INSERT INTO products (id, nombre, product_type, unit_type, activo) VALUES
  ${values(p.products, (x) => `(${uuid(x.id)}, ${lit(x.nombre)}, ${lit(x.product_type)}::product_type, ${lit(x.unit_type)}::unit_type, ${x.activo ? 'true' : 'false'})`)}
ON CONFLICT (id) DO NOTHING;
${divergence('products', ['id', 'nombre', 'product_type', 'unit_type', 'activo'], p.products,
    (x) => `(${uuid(x.id)}, ${lit(x.nombre)}::varchar, ${lit(x.product_type)}::product_type, ${lit(x.unit_type)}::unit_type, ${x.activo ? 'true' : 'false'})`)}
INSERT INTO expense_category (id, nombre, description, activo, pnl_cost_class) VALUES
  ${values(p.categories, (c) => `(${uuid(c.id)}, ${lit(c.nombre)}, ${lit(c.description)}, ${c.activo ? 'true' : 'false'}, ${lit(c.pnl_cost_class)}::expense_cost_class)`)}
ON CONFLICT (id) DO NOTHING;
${divergence('expense_category', ['id', 'nombre', 'description', 'activo', 'pnl_cost_class'], p.categories,
    (c) => `(${uuid(c.id)}, ${lit(c.nombre)}::varchar, ${lit(c.description)}::text, ${c.activo ? 'true' : 'false'}, ${lit(c.pnl_cost_class)}::expense_cost_class)`)}
INSERT INTO sheds (id, nombre) VALUES
  ${values(p.sheds, (s) => `(${uuid(s.id)}, ${lit(s.nombre)})`)}
ON CONFLICT (id) DO NOTHING;
${divergence('sheds', ['id', 'nombre'], p.sheds, (s) => `(${uuid(s.id)}, ${lit(s.nombre)}::varchar)`)}
INSERT INTO flocks (id, shed_id, estado, genetics_line, entry_date, initial_population, exit_date, created_by) VALUES
  ${values(p.flocks, (f) => `(${uuid(f.id)}, ${uuid(f.shed_id)}, ${lit(f.estado)}::flock_estado, ${lit(f.genetics_line)}, ${date(f.entry_date)}, ${int(f.initial)}, ${date(f.exit_date)}, ${uuid(p.actor)})`)}
ON CONFLICT (id) DO NOTHING;
${divergence('flocks', ['id', 'shed_id', 'estado', 'genetics_line', 'entry_date', 'initial_population', 'exit_date'], p.flocks,
    (f) => `(${uuid(f.id)}, ${uuid(f.shed_id)}, ${lit(f.estado)}::flock_estado, ${lit(f.genetics_line)}::varchar, ${date(f.entry_date)}, ${int(f.initial)}::bigint, ${date(f.exit_date)})`)}
${p.assignments.length ? `INSERT INTO operator_assignments (id, operator_id, flock_id, activo, assigned_by) VALUES
  ${values(p.assignments, (x) => `(${uuid(x.id)}, ${uuid(x.operator_id)}, ${uuid(x.flock_id)}, true, ${uuid(p.actor)})`)}
ON CONFLICT (id) DO NOTHING;
${divergence('operator_assignments', ['id', 'operator_id', 'flock_id', 'activo'], p.assignments, (x) => `(${uuid(x.id)}, ${uuid(x.operator_id)}, ${uuid(x.flock_id)}, true)`)}` : ''}
INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
SELECT v.entity_type, v.entity_id, 'MIGRATION_LOAD', jsonb_build_object('import_batch', ${lit(B)}, 'source_entity', v.source_entity, 'source_id', v.source_id),
       ${lit(`phase31 cutover ${B}`)}, ${uuid(p.actor)}
  FROM (VALUES
  ${[...p.users.map((u) => `('perfiles', ${lit(u.id)}, 'perfiles', ${lit(u.id)})`),
     ...p.clients.map((c) => `('clients', ${lit(c.id)}, 'clientes', ${lit(c.id)})`),
     ...p.products.map((x) => `('products', ${lit(x.id)}, 'productos', ${lit(x.id)})`),
     ...p.categories.map((c) => `('expense_category', ${lit(c.id)}, 'categorias_finanzas', ${lit(c.legacy_id)})`),
     ...p.flocks.map((f) => `('flocks', ${lit(f.id)}, 'lotes', ${lit(f.id)})`)].join(',\n  ')}) v(entity_type, entity_id, source_entity, source_id)
 WHERE NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_type = v.entity_type AND a.entity_id = v.entity_id AND a.action = 'MIGRATION_LOAD');
INSERT INTO phase26_migration.lineage (source_system, source_entity, source_id, import_batch, target_entity, target_key) VALUES
  ${lineage.join(',\n  ')}
ON CONFLICT DO NOTHING;
DO $$ BEGIN IF (SELECT count(*) FROM (VALUES
  ${lineage.join(',\n  ')}) v(source_system, source_entity, source_id, import_batch, target_entity, target_key)
  JOIN phase26_migration.lineage l USING (source_system, source_entity, source_id, import_batch, target_entity, target_key)) <> ${int(lineage.length)}
  OR (SELECT count(*) FROM phase26_migration.lineage WHERE import_batch = ${lit(B)}) <> ${int(lineage.length)} THEN
  RAISE EXCEPTION 'DIVERGENCE in phase26_migration.lineage'; END IF; END $$;
INSERT INTO phase26_migration.expected (key, value) VALUES
  ${expectedRows}
ON CONFLICT (key) DO NOTHING;
DO $$ BEGIN IF (SELECT count(*) FROM phase26_migration.expected) <> ${int(expected.length)} OR EXISTS (SELECT 1 FROM (VALUES
  ${expectedRows}) v(key, value)
  LEFT JOIN phase26_migration.expected e ON e.key = v.key WHERE e.value IS DISTINCT FROM v.value) THEN
  RAISE EXCEPTION 'stored expectations differ from this plan'; END IF; END $$;
INSERT INTO phase26_migration.run_log (command, import_batch, config_sha256, plan_sha256)
VALUES ('load-masters', ${lit(B)}, ${lit(CONFIG_SHA)}, ${lit(PLAN_SHA)}) ON CONFLICT DO NOTHING;
COMMIT;`;
  targetExec(masters);
  log('load: masters (profiles of the restored Auth users), flocks, assignments, audit attribution and lineage committed (idempotent)');

  // population: mortality history and P-b physical-count adjustments through the frozen RPCs, as the ADMIN actor
  const existing = JSON.parse(targetExec(`SELECT coalesce(json_agg(json_build_object('k', flock_id || '|' || event_date || '|' || event_type, 'delta', delta, 'reason', reason)
    ORDER BY flock_id, event_date), '[]') FROM population_events WHERE event_type IN ('MORTALITY', 'COUNT_ADJUSTMENT') AND is_current;`));
  const have = new Map(existing.map((e) => [e.k, e]));
  const planned = [...p.events.map((e) => ({ k: `${e.flock_id}|${e.event_date}|MORTALITY`, delta: -e.deaths, e, rpc: 'register_mortality', n: e.deaths })),
    ...p.adjustments.map((e) => ({ k: `${e.flock_id}|${e.event_date}|COUNT_ADJUSTMENT`, delta: e.delta, e, rpc: 'register_count_adjustment', n: e.delta }))];
  const plannedKeys = new Set(planned.map((x) => x.k));
  const extra = existing.filter((e) => !plannedKeys.has(e.k));
  if (extra.length) die('IDEMPOTENCY', `${extra.length} current population event(s) not in the plan`);
  const todo = [];
  for (const x of planned) {
    const h = have.get(x.k);
    if (!h) { todo.push(x); continue; }
    if (Number(h.delta) !== x.delta || h.reason !== x.e.reason) die('IDEMPOTENCY', `existing population event differs for ${x.k}`);
  }
  if (todo.length) {
    const claims = JSON.stringify({ sub: p.actor, role: 'authenticated' }).replace(/'/g, "''");
    targetExec(`BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '${claims}';
${todo.map((x) => `SELECT ${x.rpc}(${uuid(x.e.flock_id)}, ${date(x.e.event_date)}, ${int(x.n)}, ${lit(x.e.reason)});`).join('\n')}
COMMIT;`);
  }
  targetExec(`INSERT INTO phase26_migration.run_log (command, import_batch, config_sha256, plan_sha256)
VALUES ('load-population', ${lit(B)}, ${lit(CONFIG_SHA)}, ${lit(PLAN_SHA)}) ON CONFLICT DO NOTHING;`);
  log(`load: population events written ${todo.length}, already present ${planned.length - todo.length}`);

  // openings (owner-validated, dated on the cutover business date) + the MP cutover boundary (ADR-017), one transaction
  const D = p.cutover.cutover_date;
  const openings = `BEGIN;
${p.client_openings.length ? `INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
SELECT v.id, 'OPENING_BALANCE', v.amt, ${date(D)}, c.nombre, 'phase31_opening', v.id::text, ${lit(`phase31 opening ${B}`)}, ${uuid(p.actor)}
  FROM (VALUES ${values(p.client_openings, (o) => `(${uuid(o.cliente_id)}, ${money(o.amount)})`)}) v(id, amt) JOIN clients c ON c.id = v.id
 WHERE NOT EXISTS (SELECT 1 FROM client_ledger l WHERE l.source_entity_type = 'phase31_opening' AND l.source_entity_id = v.id::text);` : ''}
DO $$ BEGIN IF (SELECT count(*) FROM client_ledger WHERE source_entity_type = 'phase31_opening') <> ${int(p.client_openings.length)}
  ${p.client_openings.length ? `OR EXISTS (SELECT 1 FROM (VALUES ${values(p.client_openings, (o) => `(${uuid(o.cliente_id)}, ${money(o.amount)})`)}) v(id, amt)
     LEFT JOIN client_ledger l ON l.source_entity_type = 'phase31_opening' AND l.source_entity_id = v.id::text
     WHERE l.id IS NULL OR l.signed_amount <> v.amt OR l.effective_date <> ${date(D)} OR l.movement_type <> 'OPENING_BALANCE')` : ''}
  THEN RAISE EXCEPTION 'DIVERGENCE in client openings'; END IF; END $$;
${p.treasury_openings.map((o) => `WITH op AS (
  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', ${date(D)}, ${lit(`PHASE31-OPENING:${B}:${o.account}`)}, 'phase31_opening', ${lit(o.account)}, ${lit(`phase31 opening ${B}`)}, ${uuid(p.actor)})
  ON CONFLICT (external_ref) DO NOTHING RETURNING id)
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
SELECT op.id, a.id, ${money(o.amount)}, ${date(D)}, ${uuid(p.actor)} FROM op JOIN financial_account a ON a.nombre = ${lit(o.account)};`).join('\n')}
DO $$ BEGIN IF (SELECT count(*) FROM financial_operation WHERE external_ref LIKE ${lit(`PHASE31-OPENING:${B}:%`)}) <> ${int(p.treasury_openings.length)}
  ${p.treasury_openings.length ? `OR EXISTS (SELECT 1 FROM (VALUES ${values(p.treasury_openings, (o) => `(${lit(o.account)}, ${money(o.amount)})`)}) v(acc, amt)
     LEFT JOIN financial_operation fo ON fo.external_ref = ${lit(`PHASE31-OPENING:${B}:`)} || v.acc
     LEFT JOIN financial_posting fp ON fp.financial_operation_id = fo.id
     LEFT JOIN financial_account a ON a.id = fp.financial_account_id
     WHERE fo.id IS NULL OR a.nombre IS DISTINCT FROM v.acc OR fp.signed_amount IS DISTINCT FROM v.amt OR fo.operation_type <> 'ADJUSTMENT'
        OR (SELECT count(*) FROM financial_posting x WHERE x.financial_operation_id = fo.id) <> 1)` : ''}
  THEN RAISE EXCEPTION 'DIVERGENCE in treasury openings'; END IF; END $$;
INSERT INTO mp_cutover_boundary (cutover_at, import_batch, evidence_ref)
VALUES (${lit(p.cutover.cutover_at)}::timestamptz, ${lit(B)}, ${lit(p.cutover.evidence_ref)}) ON CONFLICT (singleton) DO NOTHING;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM mp_cutover_boundary WHERE cutover_at = ${lit(p.cutover.cutover_at)}::timestamptz AND import_batch = ${lit(B)}) THEN
  RAISE EXCEPTION 'DIVERGENCE in mp_cutover_boundary'; END IF; END $$;
INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
SELECT 'mp_cutover_boundary', 'singleton', 'PHASE31_BOUNDARY',
       jsonb_build_object('cutover_at', ${lit(p.cutover.cutover_at)}, 'import_batch', ${lit(B)}, 'evidence_ref', ${lit(p.cutover.evidence_ref)}),
       ${lit(`phase31 cutover ${B}`)}, ${uuid(p.actor)}
 WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE entity_type = 'mp_cutover_boundary' AND action = 'PHASE31_BOUNDARY');
INSERT INTO phase26_migration.run_log (command, import_batch, config_sha256, plan_sha256)
VALUES ('load-openings', ${lit(B)}, ${lit(CONFIG_SHA)}, ${lit(PLAN_SHA)}) ON CONFLICT DO NOTHING;
COMMIT;`;
  targetExec(openings);
  log(`load: ${p.client_openings.length} client opening(s), ${p.treasury_openings.length} treasury opening(s), MP cutover boundary ${p.cutover.cutover_at} (ledger ${nFiles} files)`);
}

// ── validate ────────────────────────────────────────────────────────────────
function runValidate() {
  const nFiles = ledgerCheck();
  const out = targetExec(readFileSync(VALIDATE_SQL, 'utf8'), ['-F', '|', '-v', `expected_migrations=${nFiles}`]);
  writeFileSync(join(opt.out, 'validation.txt'), `${out}\n`);
  const checks = out.split('\n').filter((l) => l.startsWith('CHECK|'));
  const failed = checks.filter((l) => l.split('|')[2] !== 'PASS');
  const digestLines = out.split('\n').filter((l) => l.startsWith('DIGEST|')).sort();
  writeFileSync(join(opt.out, 'state-digest.txt'), `${digestLines.join('\n')}\n`);
  log(`validate: ${checks.length} checks, ${failed.length} failed; state digest ${sha256(digestLines.join('\n'))}`);
  if (!checks.length) die('VALIDATE', 'no checks emitted');
  if (failed.length) die('VALIDATE', 'validation failed', failed.join('\n'));
}

// ── dispatch ────────────────────────────────────────────────────────────────
if (IS_MAIN) {
  init();
  runGates();
  if (command === 'extract') runExtract();
  if (command === 'auth-check') runAuthCheck();
  if (command === 'load') runLoad();
  if (command === 'validate') runValidate();
}
