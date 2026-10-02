#!/usr/bin/env node
/**
 * PHASE 31 Step 2 — provision / verify the FRESH target Supabase project (empty, no traffic).
 *
 *   preflight  fail closed unless the database is a fresh project that is NOT legacy
 *   apply      target-migrations 0001…NNNN, same semantics as scripts/target-db/apply.mjs (one transaction per file with
 *              its ledger row, advisory lock, sha256 immutability, no transaction control in files)
 *   verify     ledger = files; definers / anon / enums / tables / views; RLS; Storage buckets + policies; cron; Vault entry
 *              NAMES; no Auth user, no business fact, no MP boundary (ADR-017: not set before the cutover)
 *   smoke      HTTP, read-only / unauthenticated probes: Auth settings (signup disabled, providers), mp-webhook and
 *              mp-worker refuse unauthenticated calls, Storage buckets not public; cron run history
 *
 * Connection: CUTOVER_TARGET_DB_URL (exported by the owner in their own shell; passed to psql as libpq environment
 * variables, never in argv, a file or a log). Smoke also reads TARGET_API_URL and TARGET_ANON_KEY (public values).
 *
 * Usage:
 *   node scripts/phase31/provision-target.mjs <preflight|apply|verify|smoke> --kind PRODUCTION_TARGET|LOCAL_PROVISION_REHEARSAL
 *        --expected-host <db host> --forbidden-hosts <legacy db host[,…]> --client <psql client container>
 *        [--confirm <expected host>]   (PRODUCTION_TARGET apply only: explicit owner confirmation)
 * Never prints a secret value, an email, a hash or a token.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'target-migrations');
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const TXN_CONTROL = /\b(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE\s+SAVEPOINT|END\s*;)/i;
const EXPECTED = { enums: 33, tables: 62, views: 16, storage_policies: 6 };   // through 0072
// APPLICATION SECURITY DEFINER inventory: exact identities (scripts/phase31/app-definers.json, 69 through 0072).
const APP_DEFINERS = JSON.parse(readFileSync(join(REPO, 'scripts', 'phase31', 'app-definers.json'), 'utf8')).identities;
// The ONLY allowed hosted-platform SECURITY DEFINER in public (Supabase "automatic RLS"): accepted only when every
// characteristic matches. Our migrations never create, alter or revoke it (owner decision, Phase 31 Step 2).
const PLATFORM_DEFINER = { identity: 'rls_auto_enable()', owner: 'postgres', returns: 'event_trigger',
  event_trigger: 'ensure_rls', event: 'ddl_command_end' };
const LEGACY_MARKERS = ['clientes', 'movimientos_caja', 'mercadopago_raw', 'mercadopago_movements', 'cuentas_caja', 'pagos', 'lotes', 'producciones'];
const VAULT_NAMES = ['mp_worker_url', 'mp_worker_invoke_secret'];

const [command, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
const die = (code, msg, detail) => {
  console.error(`\nPROVISION FAILED [${code}]: ${msg}`);
  if (detail) console.error(String(detail).replace(/password[^\s]*/gi, 'password=***').split('\n').slice(0, 30).map((l) => `  ${l}`).join('\n'));
  process.exit(1);
};
const log = (s) => console.log(`[phase31-provision] ${s}`);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
if (!['preflight', 'apply', 'verify', 'smoke', 'vault-set'].includes(command)) die('USAGE', 'command must be preflight | apply | verify | smoke | vault-set');
if (!['PRODUCTION_TARGET', 'LOCAL_PROVISION_REHEARSAL'].includes(opt.kind)) die('USAGE', '--kind PRODUCTION_TARGET | LOCAL_PROVISION_REHEARSAL');
if (!opt['expected-host'] || !opt.client) die('USAGE', '--expected-host and --client are required');
const forbidden = (opt['forbidden-hosts'] || '').split(',').map((s) => s.trim()).filter(Boolean);
if (opt.kind === 'PRODUCTION_TARGET' && forbidden.length === 0) die('USAGE', 'PRODUCTION_TARGET requires --forbidden-hosts <legacy db host>');

// ── connection ──────────────────────────────────────────────────────────────
const raw = process.env.CUTOVER_TARGET_DB_URL;
if (!raw) die('TARGET', 'CUTOVER_TARGET_DB_URL is not set (export it in your own shell; never paste it anywhere)');
let u;
try { u = new URL(raw); } catch { die('TARGET', 'CUTOVER_TARGET_DB_URL is not a valid URL'); }
const host = u.hostname;
if (host !== opt['expected-host']) die('TARGET', `connection host ${host} differs from --expected-host`);
if (forbidden.includes(host)) die('TARGET', `connection host ${host} is a forbidden (legacy) host`);
const loopback = ['127.0.0.1', 'localhost'].includes(host);
// Supabase poolers share one host across projects: the project is identified by its ref, carried either in the host
// (db.<ref>.supabase.co) or in the pooler user name (postgres.<ref>). PRODUCTION_TARGET requires both refs.
const user = decodeURIComponent(u.username || '');
const refOf = () => (host.match(/^db\.([a-z0-9]{20})\.supabase\.co$/) || [])[1] || (user.match(/^postgres\.([a-z0-9]{20})$/) || [])[1] || null;
if (opt.kind === 'PRODUCTION_TARGET') {
  const ref = refOf();
  const forbiddenRefs = (opt['forbidden-refs'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!/^[a-z0-9]{20}$/.test(opt['expected-ref'] || '') || forbiddenRefs.length === 0) die('USAGE', 'PRODUCTION_TARGET requires --expected-ref <new ref> and --forbidden-refs <legacy ref>');
  if (ref !== opt['expected-ref']) die('TARGET', `connection project ref ${ref ?? 'UNKNOWN'} differs from --expected-ref`);
  if (forbiddenRefs.includes(ref) || forbiddenRefs.includes(opt['expected-ref'])) die('TARGET', 'the connection is the LEGACY project ref: refusing');
}
if (opt.kind === 'PRODUCTION_TARGET' && loopback) die('TARGET', 'PRODUCTION_TARGET cannot be a loopback host');
if (opt.kind === 'LOCAL_PROVISION_REHEARSAL' && !loopback) die('TARGET', 'LOCAL_PROVISION_REHEARSAL must be a loopback host');
const PGENV = {
  PGHOST: host, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username || 'postgres'), PGPASSWORD: decodeURIComponent(u.password || ''),
  PGDATABASE: (u.pathname || '/postgres').slice(1) || 'postgres', PGSSLMODE: u.searchParams.get('sslmode') || (loopback ? 'disable' : 'require'),
};
function psql(sqlText, extra = []) {
  const r = spawnSync('docker', ['exec', '-i', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE',
    opt.client, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra, '-f', '-'],
  { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...PGENV } });
  if (r.error) die('DOCKER', 'could not run docker', r.error.message);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const q = (sqlText) => { const r = psql(sqlText); if (!r.ok) die('SQL', 'query failed on the target', r.err); return r.out; };

// ── migration files (validated before touching the database) ───────────────
function migrationFiles() {
  const all = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const bad = all.filter((f) => !FILE_PATTERN.test(f));
  if (bad.length) die('BAD_FILENAME', 'migration file names must match NNNN_lowercase_words.sql', bad.join('\n'));
  const versions = all.map((f) => f.slice(0, 4));
  if (new Set(versions).size !== versions.length) die('DUPLICATE_VERSION', 'two migrations share a version');
  return all.sort((a, b) => a.localeCompare(b, 'en')).map((f) => {
    const body = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const top = body.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
    if (TXN_CONTROL.test(top)) die('TXN_CONTROL', `${f} contains transaction control`);
    return { file: f, version: f.slice(0, 4), body, sha: sha256(body) };
  });
}
const ledgerRows = () => {
  if (q(`SELECT to_regclass('migration_ledger.applied') IS NOT NULL;`) !== 't') return [];
  return q(`SELECT version || '|' || filename || '|' || sha256 FROM migration_ledger.applied ORDER BY version;`).split('\n').filter(Boolean);
};

// ── timezone contract: the database is UTC; business dates are converted explicitly to Buenos Aires ──
function timezoneFailures() {
  const tz = JSON.parse(q(`SELECT json_build_object(
    'session', current_setting('TimeZone'),
    'database_default', (SELECT coalesce(string_agg(cfg, ','), '') FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) cfg
                          WHERE cfg ILIKE 'timezone=%' AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))),
    'cron', (SELECT setting FROM pg_settings WHERE name = 'cron.timezone'))::text;`));
  const f = [];
  if (tz.session !== 'UTC') f.push(`DATABASE_TIMEZONE: SHOW timezone = ${tz.session} (expected UTC; not changed by this tool)`);
  if (tz.database_default && !/^timezone=UTC$/i.test(tz.database_default)) f.push(`DATABASE_TIMEZONE: a database/role default sets ${tz.database_default}`);
  return { tz, f };
}

// ── preflight ───────────────────────────────────────────────────────────────
function preflight() {
  const files = migrationFiles();
  const info = JSON.parse(q(`SELECT json_build_object(
    'server_version', current_setting('server_version'),
    'legacy_tables', (SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]') FROM information_schema.tables
                      WHERE table_schema = 'public' AND table_name IN (${LEGACY_MARKERS.map((t) => `'${t}'`).join(', ')})),
    'public_tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'),
    'auth_users', (SELECT count(*) FROM auth.users),
    'storage_objects', (SELECT count(*) FROM storage.objects),
    'ext_available', (SELECT coalesce(json_agg(name ORDER BY name), '[]') FROM pg_available_extensions WHERE name IN ('pg_cron', 'pg_net', 'supabase_vault', 'pgcrypto')),
    'vault_installed', (SELECT count(*) FROM pg_extension WHERE extname = 'supabase_vault')
  )::text;`));
  const f = [];
  if (info.legacy_tables.length) f.push(`LEGACY_PROJECT_SUSPECTED: legacy tables present (${info.legacy_tables.join(', ')})`);
  if (info.auth_users > 0) f.push(`NOT_FRESH: auth.users holds ${info.auth_users} row(s)`);
  if (info.storage_objects > 0) f.push(`NOT_FRESH: storage.objects holds ${info.storage_objects} object(s)`);
  for (const e of ['pg_cron', 'pg_net', 'supabase_vault']) if (!info.ext_available.includes(e)) f.push(`EXTENSION_UNAVAILABLE: ${e}`);
  if (info.vault_installed !== 1) f.push('VAULT_NOT_INSTALLED: supabase_vault must be installed by the platform');
  const tzr = timezoneFailures();
  f.push(...tzr.f);
  const ledger = ledgerRows();
  const expectedLines = files.map((m) => `${m.version}|${m.file}|${m.sha}`);
  if (ledger.length === 0) {
    if (info.public_tables > 0) f.push(`NOT_FRESH: ${info.public_tables} public table(s) exist without a target migration ledger`);
  } else if (ledger.some((l, i) => l !== expectedLines[i])) {
    f.push('LEDGER_CONFLICT: the existing ledger is not a prefix of the repository migrations (version / filename / sha256)');
  }
  log(`preflight: host=${host} server=${info.server_version} public_tables=${info.public_tables} ledger=${ledger.length}/${files.length} `
    + `auth_users=${info.auth_users} storage_objects=${info.storage_objects} extensions=${info.ext_available.join(',')} `
    + `timezone=${tzr.tz.session} cron.timezone=${tzr.tz.cron ?? 'n/a'}`);
  if (f.length) die('PREFLIGHT', 'the target is not a fresh, non-legacy project', f.join('\n'));
  log('preflight: PASS (fresh, not legacy, extensions available, ledger empty or a consistent prefix)');
}

// ── apply ───────────────────────────────────────────────────────────────────
function apply() {
  if (opt.kind === 'PRODUCTION_TARGET' && opt.confirm !== host) die('CONFIRM', '--confirm <expected host> is required for PRODUCTION_TARGET apply');
  preflight();
  const files = migrationFiles();
  q(`CREATE SCHEMA IF NOT EXISTS migration_ledger;
CREATE TABLE IF NOT EXISTS migration_ledger.applied (version TEXT PRIMARY KEY, filename TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  let ran = 0;
  for (const m of files) {
    const cur = new Map(ledgerRows().map((l) => { const [v, , s] = l.split('|'); return [v, s]; }));
    if (cur.has(m.version)) {
      if (cur.get(m.version) !== m.sha) die('CHECKSUM_CHANGED', `migration ${m.version} changed after it was applied`);
      continue;
    }
    const r = psql(`
SELECT pg_advisory_xact_lock(hashtext('target_v1_migration_runner'));
DO $runner$ BEGIN
  IF EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '${m.version}') THEN
    RAISE EXCEPTION 'ALREADY_APPLIED: % was applied concurrently', '${m.version}';
  END IF;
END $runner$;

${m.body}

INSERT INTO migration_ledger.applied (version, filename, sha256) VALUES ('${m.version}', '${m.file}', '${m.sha}');
`, ['-1']);
    if (!r.ok) die('APPLY', `migration ${m.file} failed; its SQL and its ledger row were rolled back together`, r.err);
    log(`+ ${m.file}`);
    ran += 1;
  }
  log(`apply: ${ran} new migration(s); ledger holds ${q('SELECT count(*) FROM migration_ledger.applied;')}`);
}

// ── verify ──────────────────────────────────────────────────────────────────
function verify() {
  const files = migrationFiles();
  const expectedLines = files.map((m) => `${m.version}|${m.file}|${m.sha}`);
  const ledger = ledgerRows();
  const s = JSON.parse(q(`SELECT json_build_object(
    'definer_list', (SELECT coalesce(json_agg(json_build_object(
        'identity', p.oid::regprocedure::text, 'owner', pg_get_userbyid(p.proowner), 'returns', pg_get_function_result(p.oid),
        'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'event_triggers', (SELECT coalesce(json_agg(evtname || ':' || evtevent ORDER BY evtname), '[]') FROM pg_event_trigger WHERE evtfoid = p.oid))
        ORDER BY p.oid::regprocedure::text), '[]')
      FROM pg_proc p WHERE p.prosecdef AND p.pronamespace = 'public'::regnamespace),
    'enums', (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'),
    'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'),
    'views', (SELECT count(*) FROM information_schema.views WHERE table_schema = 'public'),
    'tables_without_rls', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity),
    'anon_table_privileges', (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_schema = 'public'),
    'buckets', (SELECT coalesce(json_agg(id || ':' || public || ':' || file_size_limit || ':' || array_to_string(allowed_mime_types, ',') ORDER BY id), '[]') FROM storage.buckets),
    'storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage'),
    'cron_job', (SELECT coalesce(json_agg(jobname || ':' || active ORDER BY jobname), '[]') FROM cron.job WHERE jobname = 'mp_worker_every_minute'),
    'vault_names', (SELECT coalesce(json_agg(name ORDER BY name), '[]') FROM vault.secrets WHERE name IN (${VAULT_NAMES.map((n) => `'${n}'`).join(', ')})),
    'auth_users', (SELECT count(*) FROM auth.users),
    'business_facts', (SELECT count(*) FROM pedidos) + (SELECT count(*) FROM collections) + (SELECT count(*) FROM purchases)
      + (SELECT count(*) FROM perfiles) + (SELECT count(*) FROM client_ledger) + (SELECT count(*) FROM financial_operation)
      + (SELECT count(*) FROM mp_source_record) + (SELECT count(*) FROM mp_webhook_delivery) + (SELECT count(*) FROM sales_session_closing),
    'mp_boundary', (SELECT count(*) FROM mp_cutover_boundary),
    'seeds', json_build_object('clients', (SELECT count(*) FROM clients), 'accounts', (SELECT count(*) FROM financial_account),
      'system_products', (SELECT count(*) FROM products WHERE is_system), 'products', (SELECT count(*) FROM products),
      'expense_categories', (SELECT count(*) FROM expense_category), 'periods', (SELECT count(*) FROM management_period))
  )::text;`));
  const f = [];
  if (ledger.join('\n') !== expectedLines.join('\n')) f.push(`LEDGER: ${ledger.length} row(s) vs ${files.length} file(s) (version / filename / sha256)`);
  for (const [k, v] of Object.entries(EXPECTED)) if (s[k] !== v) f.push(`${k}=${s[k]} (expected ${v})`);
  // SECURITY DEFINER contract: application (exact list, 0 anon) vs the single allowed hosted-platform object
  const byId = new Map(s.definer_list.map((d) => [d.identity, d]));
  const app = s.definer_list.filter((d) => APP_DEFINERS.includes(d.identity));
  const appMissing = APP_DEFINERS.filter((i) => !byId.has(i));
  const appAnon = app.filter((d) => d.anon).map((d) => d.identity);
  const extra = s.definer_list.filter((d) => !APP_DEFINERS.includes(d.identity));
  const platform = [];
  for (const d of extra) {
    const pd = PLATFORM_DEFINER;
    const exact = d.identity === pd.identity && d.owner === pd.owner && d.returns === pd.returns
      && JSON.stringify(d.event_triggers) === JSON.stringify([`${pd.event_trigger}:${pd.event}`]);
    if (exact) platform.push(d);
    else if (/^rls_auto_enable\(/.test(d.identity)) f.push(`PLATFORM_DEFINER_MISMATCH: ${d.identity} owner=${d.owner} returns=${d.returns} event_triggers=${JSON.stringify(d.event_triggers)} (approved: ${JSON.stringify(pd)})`);
    else f.push(`UNEXPECTED_DEFINER: public.${d.identity} owner=${d.owner} returns=${d.returns} anon=${d.anon}`);
  }
  if (appMissing.length) f.push(`APP_DEFINER_MISSING: ${appMissing.join(', ')}`);
  if (app.length !== APP_DEFINERS.length) f.push(`app_definers=${app.length} (expected ${APP_DEFINERS.length})`);
  if (appAnon.length) f.push(`APP_ANON_DEFINER: ${appAnon.join(', ')} (application definers must never be executable by anon)`);
  s.app_definers = app.length; s.app_anon_definers = appAnon.length;
  s.platform_definers = platform.map((d) => `${d.identity}[anon=${d.anon}; ${d.event_triggers.join(',')}]`);
  if (s.tables_without_rls !== 0) f.push(`tables_without_rls=${s.tables_without_rls}`);
  const buckets = ['feria-worksheets:false:10485760:application/pdf,image/jpeg,image/png,image/webp',
    'purchase-attachments:false:10485760:application/pdf,image/jpeg,image/png,image/webp'];
  if (JSON.stringify(s.buckets) !== JSON.stringify(buckets)) f.push(`buckets=${JSON.stringify(s.buckets)}`);
  if (JSON.stringify(s.cron_job) !== JSON.stringify(['mp_worker_every_minute:true'])) f.push(`cron_job=${JSON.stringify(s.cron_job)}`);
  if (s.auth_users !== 0) f.push(`auth_users=${s.auth_users} (no Auth data before the rehearsed restore)`);
  if (s.business_facts !== 0) f.push(`business_facts=${s.business_facts} (the target must stay empty)`);
  if (s.mp_boundary !== 0) f.push('mp_cutover_boundary is set before the cutover (ADR-017: only the cutover runner writes it)');
  const tzv = timezoneFailures();
  f.push(...tzv.f);
  const vaultMissing = VAULT_NAMES.filter((n) => !s.vault_names.includes(n));
  log(`verify: ledger=${ledger.length}/${files.length} app_definers=${s.app_definers}/${APP_DEFINERS.length} app_anon_definers=${s.app_anon_definers} platform_definers=${s.platform_definers.length}${s.platform_definers.length ? ` [${s.platform_definers.join(' ')}]` : ''} raw_total_definers=${s.definer_list.length} enums=${s.enums} tables=${s.tables} views=${s.views} `
    + `rls_missing=${s.tables_without_rls} anon_table_grants=${s.anon_table_privileges} storage_policies=${s.storage_policies} `
    + `timezone=${tzv.tz.session} cron.timezone=${tzv.tz.cron ?? 'n/a'} (mp_worker_every_minute is minute-based)`);
  log(`verify: buckets=${s.buckets.map((b) => b.split(':').slice(0, 3).join(':')).join(' ')} cron=${s.cron_job.join(',') || 'MISSING'} `
    + `vault PRESENT=[${s.vault_names.join(', ')}] MISSING=[${vaultMissing.join(', ')}] auth_users=${s.auth_users} business_facts=${s.business_facts} `
    + `mp_boundary=${s.mp_boundary} seeds=${JSON.stringify(s.seeds)}`);
  if (f.length) die('VERIFY', 'the target does not match the provisioning contract', f.join('\n'));
  log(vaultMissing.length ? 'verify: schema PASS; Vault entries MISSING (owner step)' : 'verify: PASS');
}

// ── smoke (HTTP probes: no credentials beyond the public anon key; no business write) ──
async function smoke() {
  const api = process.env.TARGET_API_URL; const anon = process.env.TARGET_ANON_KEY;
  if (!api || !anon) die('USAGE', 'TARGET_API_URL and TARGET_ANON_KEY (public values) are required for smoke');
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  const f = [];
  const settings = await fetch(`${api}/auth/v1/settings`, { headers: h }).then((r) => r.json()).catch(() => null);
  const providers = settings ? Object.entries(settings.external || {}).filter(([, on]) => on).map(([k]) => k) : [];
  if (!settings) f.push('auth settings unreachable');
  else {
    if (settings.disable_signup !== true) f.push('Auth sign-up is ENABLED (owner decision: disabled)');
    if (providers.some((p) => p !== 'email')) f.push(`unexpected Auth providers enabled: ${providers.filter((p) => p !== 'email').join(',')}`);
  }
  const wh = await fetch(`${api}/functions/v1/mp-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status).catch(() => 0);
  const wk = await fetch(`${api}/functions/v1/mp-worker`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status).catch(() => 0);
  if (wh === 500) f.push('mp-webhook answered 500: fail-closed because its secrets are not loaded yet (load them, then re-run smoke; expected 401)');
  else if (wh !== 401) f.push(`mp-webhook without a signature answered ${wh} (expected 401)`);
  if (wk !== 401) f.push(`mp-worker without the invoke secret answered ${wk} (expected 401)`);
  const legacyFns = [];
  for (const fn of ['sync-mercadopago', 'check-rate-limit']) {
    const st = await fetch(`${api}/functions/v1/${fn}`, { method: 'OPTIONS' }).then((r) => r.status).catch(() => 0);
    if (st !== 404) legacyFns.push(`${fn}:${st}`);
  }
  if (legacyFns.length) f.push(`legacy functions answer on the target: ${legacyFns.join(', ')}`);
  const pub = [];
  for (const b of ['purchase-attachments', 'feria-worksheets']) pub.push(await fetch(`${api}/storage/v1/object/public/${b}/smoke-probe.pdf`).then((r) => r.status).catch(() => 0));
  if (pub.some((s) => s === 200)) f.push(`a public Storage URL answered 200 (${pub.join(',')})`);
  const cron = JSON.parse(q(`SELECT json_build_object(
    'runs', (SELECT count(*) FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'mp_worker_every_minute' AND d.start_time > now() - interval '15 minutes'),
    'succeeded', (SELECT count(*) FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'mp_worker_every_minute' AND d.status = 'succeeded' AND d.start_time > now() - interval '15 minutes'),
    'http', (SELECT coalesce(json_agg(status_code ORDER BY id DESC), '[]') FROM (SELECT id, status_code FROM net._http_response ORDER BY id DESC LIMIT 5) r)
  )::text;`));
  log(`smoke: auth disable_signup=${settings?.disable_signup} providers=[${providers.join(',')}] mp-webhook(unsigned)=${wh} mp-worker(no secret)=${wk} `
    + `legacy_functions=${legacyFns.join(',') || 'none'} storage_public=[${pub.join(',')}] cron_runs_15m=${cron.runs} succeeded=${cron.succeeded} last_http=${JSON.stringify(cron.http)}`);
  if (f.length) die('SMOKE', 'target smoke failed', f.join('\n'));
  log('smoke: PASS (no business write, no Mercado Pago call)');
}

// ── vault-set: the two approved Vault entries (values never in argv, files of the repo, or output) ──
function vaultSet() {
  const url = opt['worker-url'];
  if (!url) die('USAGE', '--worker-url https://<target-ref>.supabase.co/functions/v1/mp-worker is required');
  if (opt.kind === 'PRODUCTION_TARGET') {
    // The API host is derived ONLY from the already-validated --expected-ref, never from the DB host: a Session
    // Pooler host (aws-0-<region>.pooler.supabase.com) is shared across projects and carries no ref.
    const expectedUrl = `https://${opt['expected-ref']}.supabase.co/functions/v1/mp-worker`;
    if (url !== expectedUrl) die('USAGE', `--worker-url must be exactly ${expectedUrl} (the --expected-ref project, https, mp-worker path, nothing appended)`);
  } else if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/functions\/v1\/mp-worker$/.test(url)) {
    die('USAGE', '--worker-url for a local rehearsal must be http(s)://127.0.0.1:<port>/functions/v1/mp-worker');
  }
  if (!process.env.WORKER_INVOKE_SECRET || process.env.WORKER_INVOKE_SECRET.length < 32) die('SECRET', 'WORKER_INVOKE_SECRET (>= 32 chars) must be exported in this shell (never pasted anywhere)');
  const r = spawnSync('docker', ['exec', '-i', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE',
    '-e', 'WORKER_INVOKE_SECRET', opt.client, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', `wurl=${url}`, '-f', '-'],
  { encoding: 'utf8', env: { ...process.env, ...PGENV }, input: String.raw`\getenv wis WORKER_INVOKE_SECRET
BEGIN;
SELECT CASE WHEN EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'mp_worker_url')
  THEN (SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'mp_worker_url'), :'wurl'))::text
  ELSE vault.create_secret(:'wurl', 'mp_worker_url')::text END IS NOT NULL AS _ \gset
SELECT CASE WHEN EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'mp_worker_invoke_secret')
  THEN (SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'mp_worker_invoke_secret'), :'wis'))::text
  ELSE vault.create_secret(:'wis', 'mp_worker_invoke_secret')::text END IS NOT NULL AS _ \gset
COMMIT;
SELECT string_agg(name, ',' ORDER BY name) FROM vault.secrets WHERE name IN ('mp_worker_url', 'mp_worker_invoke_secret');` });
  if (r.status !== 0) die('VAULT', 'vault update failed', (r.stderr || '').split('\n')[0]);
  log(`vault-set: entries PRESENT=[${(r.stdout || '').trim()}] (values not shown)`);
}

if (command === 'vault-set') vaultSet();
if (command === 'preflight') preflight();
if (command === 'apply') apply();
if (command === 'verify') verify();
if (command === 'smoke') await smoke();
if (!existsSync(MIGRATIONS_DIR)) die('NO_DIR', 'migrations directory missing');
