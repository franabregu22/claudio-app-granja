#!/usr/bin/env node
/**
 * Incremental target-migration runner — applies an EXPLICIT, owner-reviewed range of new target migrations to an
 * EXISTING target database that already holds data (post-cutover production). Separate from the provisioning runner
 * (scripts/phase31/provision-target.mjs), whose fresh-project protections are unchanged and still refuse such a database.
 *
 *   node scripts/target-db/apply-incremental.mjs --from 0072 --to 0077 --client <psql client container> [--dry-run]
 *        [--production --expected-project-ref <ref> --forbidden-refs <ref,…>
 *         --confirm-project <ref> --confirm-from 0072 --confirm-to 0077]
 *        [--verify-profile ADR018_POST_0077 | ADR018_POST_0078 | ADR018_POST_0079 | ADR018_POST_0080 | ADR018_POST_0081 | ADR018_POST_0082 | ADR018_POST_0083 | ADR018_POST_0084 | ADR018_POST_0085 | ADR018_POST_0086 | ADR018_POST_0087 | ADR018_POST_0088 | ADR018_POST_0089 | ADR018_POST_0090 | ADR018_POST_0091 | ADR018_POST_0092 | ADR018_POST_0093 | ADR018_POST_0094 | ADR018_POST_0095 | ADR018_POST_0098 [--deployment-check]] [--verify-only]
 *        [--lock-timeout 5s] [--statement-timeout 120s]
 *        [--migrations-dir <dir>]                         (non-production only: tests)
 *
 * Connection: MIGRATION_TARGET_DB_URL, exported by the operator in their own shell. It is split into libpq environment
 * variables for psql inside the client container (never argv, a file or a log). The Supabase CLI and its linked project are
 * never used, and `supabase link` is never run.
 *
 * Guarantees (each enforced BEFORE any write; any violation aborts with a code):
 *   PROJECT      --production: the project ref carried by the connection (db.<ref>.supabase.co or the pooler user
 *                postgres.<ref>) must equal --expected-project-ref and --confirm-project, and not be a --forbidden-refs entry;
 *                --confirm-from / --confirm-to must repeat --from / --to; a loopback host is refused.
 *                Without --production only a loopback host is accepted.
 *   FILES        NNNN_lowercase_words.sql, unique versions, no transaction control; --from and --to exist; NO local file
 *                beyond --to (a newer migration needs a new owner-reviewed --to).
 *   LEDGER       migration_ledger.applied (version, filename, sha256 of the file text — the format of apply.mjs /
 *                provision-target.mjs) is read in full. Every row must be a local file with the identical filename and
 *                sha256. The ledger must be EXACTLY the files up to --from (→ apply the pending set) or EXACTLY the files
 *                up to --to (→ no-op). Anything else — a missing intermediate version, an unknown remote version, a different
 *                sha256, a partial state — aborts.
 *   PENDING      exactly the local files with --from < version <= --to, in order. The runner never applies "whatever is
 *                pending".
 *   LOCK         session-level pg_try_advisory_lock(hashtext('target_v1_migration_runner')): the same key that apply.mjs
 *                and provision-target.mjs take as a transaction lock, so no two runners of any kind interleave. Busy → abort
 *                (never wait). The dry-run takes it too (transaction level), so it never reads a ledger that is being written.
 *   ATOMICITY    one psql session: lock → ledger re-checked against the precheck (no drift) → per migration
 *                BEGIN; file SQL; ledger row; COMMIT. A failure aborts the session (ON_ERROR_STOP): that migration's SQL
 *                and its ledger row roll back together and no later migration runs.
 *   TIMEOUTS     per session: lock_timeout (default 5s), statement_timeout (default 120s),
 *                idle_in_transaction_session_timeout 60s. 0073–0077 are DDL plus a 2-row seed: every statement is
 *                milliseconds, but the new foreign keys / policies take brief locks on financial_account, perfiles,
 *                financial_operation, financial_posting and storage.objects. A blocked lock fails after lock_timeout instead
 *                of queueing production traffic behind it. Other sessions are never terminated.
 *   DRY-RUN      READ ONLY transaction: identity, files, ledger, pending set and order are shown; no SQL is executed and
 *                nothing is written.
 *   VERIFY       --verify-profile runs a read-only state profile after the apply (or alone with --verify-only); success
 *                requires every check. --deployment-check adds the deployment-time "zero evidence" gate.
 * Output: per migration VERIFIED_APPLIED | PENDING | APPLYING | APPLIED | FAILED with sha256[0..12]; never a password,
 * a connection string, a token or a bank identifier.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const REPO_MIGRATIONS = join(REPO, 'supabase', 'target-migrations');
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const TXN_CONTROL = /\b(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE\s+SAVEPOINT|END\s*;)/i;
const LOCK_KEY = "hashtext('target_v1_migration_runner')";
const LEDGER = 'migration_ledger.applied';
const PROFILES = {
  ADR018_POST_0077: './verify-profiles/adr018-post-0077.mjs',
  ADR018_POST_0078: './verify-profiles/adr018-post-0078.mjs',
  ADR018_POST_0079: './verify-profiles/adr018-post-0079.mjs',
  ADR018_POST_0080: './verify-profiles/adr018-post-0080.mjs',
  ADR018_POST_0081: './verify-profiles/adr018-post-0081.mjs',
  ADR018_POST_0082: './verify-profiles/adr018-post-0082.mjs',
  ADR018_POST_0083: './verify-profiles/adr018-post-0083.mjs',
  ADR018_POST_0084: './verify-profiles/adr018-post-0084.mjs',
  ADR018_POST_0085: './verify-profiles/adr018-post-0085.mjs',
  ADR018_POST_0086: './verify-profiles/adr018-post-0086.mjs',
  ADR018_POST_0087: './verify-profiles/adr018-post-0087.mjs',
  ADR018_POST_0088: './verify-profiles/adr018-post-0088.mjs',
  ADR018_POST_0089: './verify-profiles/adr018-post-0089.mjs',
  ADR018_POST_0090: './verify-profiles/adr018-post-0090.mjs',
  ADR018_POST_0091: './verify-profiles/adr018-post-0091.mjs',
  ADR018_POST_0092: './verify-profiles/adr018-post-0092.mjs',
  ADR018_POST_0093: './verify-profiles/adr018-post-0093.mjs',
  ADR018_POST_0094: './verify-profiles/adr018-post-0094.mjs',
  ADR018_POST_0095: './verify-profiles/adr018-post-0095.mjs',
  ADR018_POST_0098: './verify-profiles/adr018-post-0098.mjs',
};
const t0 = Date.now();

const log = (m) => console.log(`  ${m}`);
function die(code, message, detail = '') {
  console.error(`\n  ✗ [${code}]: ${message}${detail ? `\n    ${String(detail).split('\n').join('\n    ')}` : ''}\n`);
  console.error(`  RESULT: ABORTED (${code}) after ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  process.exit(2);
}

// ── arguments ───────────────────────────────────────────────────────────────
const FLAGS = new Set(['production', 'dry-run', 'deployment-check', 'verify-only']);
const opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) die('USAGE', `unexpected argument ${a}`);
  const k = a.slice(2);
  if (FLAGS.has(k)) { opt[k] = true; continue; }
  if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die('USAGE', `--${k} needs a value`);
  opt[k] = argv[++i];
}
const KNOWN = ['from', 'to', 'client', 'production', 'expected-project-ref', 'forbidden-refs', 'confirm-project', 'confirm-from', 'confirm-to',
  'dry-run', 'verify-profile', 'deployment-check', 'verify-only', 'lock-timeout', 'statement-timeout', 'migrations-dir'];
for (const k of Object.keys(opt)) if (!KNOWN.includes(k)) die('USAGE', `unknown option --${k}`);
const V = /^\d{4}$/;
if (!V.test(opt.from ?? '') || !V.test(opt.to ?? '')) die('USAGE', '--from and --to are required (4-digit migration versions)');
if (opt.from >= opt.to) die('USAGE', '--from must be lower than --to');
if (!opt.client || !/^[A-Za-z0-9_.-]+$/.test(opt.client)) die('USAGE', '--client <psql client container> is required');
const TIMEOUT = /^\d{1,4}(ms|s|min)$/;
const lockTimeout = opt['lock-timeout'] ?? '5s';
const statementTimeout = opt['statement-timeout'] ?? '120s';
if (!TIMEOUT.test(lockTimeout) || !TIMEOUT.test(statementTimeout)) die('USAGE', 'timeouts must look like 5s / 500ms / 2min');
if (opt['verify-profile'] && !PROFILES[opt['verify-profile']]) die('USAGE', `unknown --verify-profile (known: ${Object.keys(PROFILES).join(', ')})`);
if (opt['deployment-check'] && !opt['verify-profile']) die('USAGE', '--deployment-check requires --verify-profile');
if (opt['verify-only'] && (!opt['verify-profile'] || opt['dry-run'])) die('USAGE', '--verify-only requires --verify-profile and excludes --dry-run');

// ── connection and project identity (before anything touches a database) ─────
const raw = process.env.MIGRATION_TARGET_DB_URL;
if (!raw) die('TARGET', 'MIGRATION_TARGET_DB_URL is not set (export it in your own shell; never paste it anywhere)');
let u;
try { u = new URL(raw); } catch { die('TARGET', 'MIGRATION_TARGET_DB_URL is not a valid URL'); }
if (!['postgres:', 'postgresql:'].includes(u.protocol)) die('TARGET', 'MIGRATION_TARGET_DB_URL must be a postgresql:// URL');
const host = u.hostname;
const user = decodeURIComponent(u.username || '');
const loopback = ['127.0.0.1', 'localhost'].includes(host);
/** The Supabase project ref carried by the connection: db.<ref>.supabase.co, or the pooler user postgres.<ref>. */
export const refOf = (h, usr) => (h.match(/^db\.([a-z0-9]{20})\.supabase\.co$/) || [])[1] || (usr.match(/^postgres\.([a-z0-9]{20})$/) || [])[1] || null;
const ref = refOf(host, user);
if (opt.production) {
  const expected = opt['expected-project-ref'] ?? '';
  const forbidden = (opt['forbidden-refs'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!/^[a-z0-9]{20}$/.test(expected)) die('USAGE', '--production requires --expected-project-ref <20-char project ref>');
  if (forbidden.length === 0) die('USAGE', '--production requires --forbidden-refs <legacy ref[,…]>');
  if (loopback) die('TARGET', '--production cannot target a loopback host');
  if (opt['migrations-dir']) die('USAGE', '--migrations-dir is refused with --production (production applies only the repository migrations)');
  if (!ref) die('PROJECT', 'the connection carries no Supabase project ref (expected db.<ref>.supabase.co or user postgres.<ref>)');
  if (ref !== expected) die('PROJECT', `connection project ref ${ref} differs from --expected-project-ref ${expected}`);
  if (forbidden.includes(ref)) die('PROJECT', `connection project ref ${ref} is a forbidden (legacy) project`);
  if (opt['confirm-project'] !== expected) die('CONFIRM', '--confirm-project must repeat the expected project ref');
  if (opt['confirm-from'] !== opt.from || opt['confirm-to'] !== opt.to) die('CONFIRM', '--confirm-from / --confirm-to must repeat --from / --to');
} else {
  if (!loopback) die('TARGET', 'a non-loopback host requires --production and its confirmations');
  for (const k of ['expected-project-ref', 'confirm-project', 'confirm-from', 'confirm-to']) if (opt[k]) die('USAGE', `--${k} is only valid with --production`);
}
const PGENV = {
  PGHOST: host, PGPORT: u.port || '5432', PGUSER: user || 'postgres', PGPASSWORD: decodeURIComponent(u.password || ''),
  PGDATABASE: (u.pathname || '/postgres').slice(1) || 'postgres', PGSSLMODE: u.searchParams.get('sslmode') || (loopback ? 'disable' : 'require'),
};

// ── local migration files ───────────────────────────────────────────────────
const dir = opt['migrations-dir'] ? (isAbsolute(opt['migrations-dir']) ? opt['migrations-dir'] : resolve(process.cwd(), opt['migrations-dir'])) : REPO_MIGRATIONS;
if (!existsSync(dir)) die('FILES', `migrations directory not found: ${dir}`);
const topLevel = (body) => body.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ').replace(/'(?:[^']|'')*'/g, "''")
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
const all = readdirSync(dir).filter((f) => f.endsWith('.sql'));
const bad = all.filter((f) => !FILE_PATTERN.test(f));
if (bad.length) die('FILES', 'migration file names must match NNNN_lowercase_words.sql', bad.join('\n'));
const versions = all.map((f) => f.slice(0, 4));
if (new Set(versions).size !== versions.length) die('FILES', 'two migration files share a version');
const files = all.sort((a, b) => a.localeCompare(b, 'en')).map((f) => {
  const body = readFileSync(join(dir, f), 'utf8');
  return { file: f, version: f.slice(0, 4), body, sha: createHash('sha256').update(body).digest('hex') };
});
const txn = files.filter((m) => TXN_CONTROL.test(topLevel(m.body)));
if (txn.length) die('FILES', 'migration files must not contain transaction control', txn.map((m) => m.file).join('\n'));
if (opt.from === '0000' && opt.production) die('USAGE', '--from 0000 (empty target) is refused with --production');
if (opt.from !== '0000' && !files.some((m) => m.version === opt.from)) die('FILES', `--from ${opt.from} is not a local migration file`);
if (!files.some((m) => m.version === opt.to)) die('FILES', `--to ${opt.to} is not a local migration file`);
const beyond = files.filter((m) => m.version > opt.to);
if (beyond.length) die('FILES', `local migration(s) beyond --to ${opt.to}: a newer migration needs a new, owner-reviewed --to`, beyond.map((m) => m.file).join('\n'));
const startSet = files.filter((m) => m.version <= opt.from);
const pending = files.filter((m) => m.version > opt.from && m.version <= opt.to);
const line = (m) => `${m.version}|${m.file}|${m.sha}`;

// ── database access (psql inside the client container, libpq env only) ─────
function psql(script, extra = []) {
  const r = spawnSync('docker', ['exec', '-i', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE',
    '-e', 'PGAPPNAME', opt.client, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra, '-f', '-'],
  { encoding: 'utf8', input: script, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...PGENV, PGAPPNAME: 'apply-incremental' } });
  if (r.error) die('DOCKER', 'could not run docker', r.error.message);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
/** Read-only snapshot: try-lock (transaction level), ledger rows. Never writes. */
function readState() {
  const r = psql(`BEGIN READ ONLY;
SELECT json_build_object(
  'lock', pg_try_advisory_xact_lock(${LOCK_KEY}),
  'ledger_exists', to_regclass('${LEDGER}') IS NOT NULL,
  'server', current_setting('server_version'),
  'read_only', current_setting('transaction_read_only')
)::text;
SELECT (to_regclass('${LEDGER}') IS NOT NULL) AS has_ledger \\gset
\\if :has_ledger
SELECT coalesce(json_agg(version || '|' || filename || '|' || sha256 ORDER BY version), '[]')::text FROM ${LEDGER};
\\else
SELECT '[]';
\\endif
ROLLBACK;`);
  if (!r.ok) die('CONNECT', 'could not read the target (read-only precheck)', r.err.split('\n')[0]);
  const [a, b] = r.out.split('\n').filter(Boolean);
  return { ...JSON.parse(a), ledger: JSON.parse(b) };
}

// ── precheck (read-only) ────────────────────────────────────────────────────
log(`target: host=${host} project_ref=${ref ?? '(local)'} mode=${opt.production ? 'PRODUCTION' : 'LOCAL'} range=${opt.from}→${opt.to} `
  + `dir=${dir === REPO_MIGRATIONS ? 'supabase/target-migrations' : dir}`);
const st = readState();
if (st.read_only !== 'on') die('PRECHECK', 'the precheck transaction is not read-only');
if (!st.lock) die('LOCK_BUSY', 'another migration runner holds the migration advisory lock; nothing was done');
if (!st.ledger_exists && opt.from !== '0000') die('LEDGER', `${LEDGER} does not exist: this is not a target database at ${opt.from}`);
const byVersion = new Map(files.map((m) => [m.version, m]));
for (const l of st.ledger) {
  const [v, f, s] = l.split('|');
  const m = byVersion.get(v);
  if (!m) die('LEDGER_UNKNOWN_MIGRATION', `the target ledger holds version ${v} (${f}), which is not a local migration file; nothing was done`);
  if (m.file !== f) die('LEDGER_FILENAME_MISMATCH', `version ${v}: ledger filename ${f} differs from the local ${m.file}; nothing was done`);
  if (m.sha !== s) die('LEDGER_SHA_MISMATCH', `version ${v}: ledger sha256 ${s.slice(0, 12)}… differs from the local file ${m.sha.slice(0, 12)}…; nothing was done`);
}
const startLines = startSet.map(line);
const endLines = startSet.concat(pending).map(line);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
let state;
if (same(st.ledger, startLines)) state = 'AT_FROM';
else if (same(st.ledger, endLines)) state = 'AT_TO';
else {
  const have = new Set(st.ledger.map((l) => l.split('|')[0]));
  const missing = endLines.map((l) => l.split('|')[0]).filter((v) => !have.has(v) && v <= opt.from);
  die('LEDGER_STATE', `the target ledger (${st.ledger.length} rows, last ${st.ledger.at(-1)?.split('|')[0] ?? 'none'}) is neither exactly ${opt.from} nor exactly ${opt.to}; nothing was done`,
    missing.length ? `versions up to --from not registered: ${missing.join(', ')}` : 'partial or unexpected state: review with the owner before choosing a new range');
}
for (const m of startSet) log(`${m.version}  ${m.sha.slice(0, 12)}  VERIFIED_APPLIED  ${m.file}`);
for (const m of pending) log(`${m.version}  ${m.sha.slice(0, 12)}  ${state === 'AT_TO' ? 'VERIFIED_APPLIED' : 'PENDING'}  ${m.file}`);
log(`ledger: ${st.ledger.length} row(s), every sha256 verified; state ${state}; pending ${state === 'AT_FROM' ? pending.map((m) => m.version).join(',') : 'none'}`);

// ── verification profile ────────────────────────────────────────────────────
async function runProfile() {
  const prof = await import(PROFILES[opt['verify-profile']]);
  const r = psql(`BEGIN READ ONLY;\n${prof.buildSql(REPO)}\nROLLBACK;`);
  if (!r.ok) return [{ label: `profile ${prof.NAME} query`, ok: false, detail: r.err.split('\n')[0] }];
  const checks = prof.evaluate(JSON.parse(r.out.split('\n').filter(Boolean).pop()), { repo: REPO, expectedLedger: endLines.length, deploymentCheck: !!opt['deployment-check'] });
  log(`verify profile ${prof.NAME}${opt['deployment-check'] ? ' + DEPLOYMENT CHECK' : ''}:`);
  for (const c of checks) log(`  ${c.ok ? 'OK ' : 'MAL'}  ${c.label}${c.ok ? '' : ` :: ${c.detail}`}`);
  return checks;
}
const finish = async (applied, startLen) => {
  const end = readState();
  const endOk = same(end.ledger, endLines);
  log(`starting ledger: ${startLen} · ending ledger: ${end.ledger.length} (last ${end.ledger.at(-1)?.split('|')[0] ?? 'none'}) · applied: ${applied}`);
  if (!endOk) die('LEDGER_END', `the ledger does not end exactly at ${opt.to}`);
  if (opt['verify-profile']) {
    const checks = await runProfile();
    if (checks.some((c) => !c.ok)) die('VERIFY', `profile ${opt['verify-profile']} failed`);
  }
  log(`RESULT: ${applied ? 'APPLIED' : 'NO-OP'} ${opt.from}→${opt.to} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};

if (opt['dry-run']) {
  log(`DRY-RUN: ${state === 'AT_FROM' ? `${pending.length} migration(s) would be applied in this order: ${pending.map((m) => m.version).join(' → ')}` : 'nothing to apply'}; `
    + 'no SQL executed, nothing written');
  log(`RESULT: DRY-RUN OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}
if (opt['verify-only']) {
  if (state !== 'AT_TO') die('VERIFY', `--verify-only needs the ledger exactly at ${opt.to}`);
  await finish(0, st.ledger.length);
  process.exit(0);
}
if (state === 'AT_TO') { log('nothing pending: the target is already exactly at --to'); await finish(0, st.ledger.length); process.exit(0); }

// ── apply: one session, session lock, ledger re-checked, one transaction per migration ──
const arr = (lines) => (lines.length ? `ARRAY[${lines.map((l) => `'${l}'`).join(', ')}]::text[]` : `'{}'::text[]`);
const script = [`SET lock_timeout = '${lockTimeout}';`, `SET statement_timeout = '${statementTimeout}';`, `SET idle_in_transaction_session_timeout = '60s';`,
  `DO $lock$ BEGIN IF NOT pg_try_advisory_lock(${LOCK_KEY}) THEN RAISE EXCEPTION 'LOCK_BUSY: another migration runner holds the lock'; END IF; END $lock$;`,
  `CREATE SCHEMA IF NOT EXISTS migration_ledger;`,
  `CREATE TABLE IF NOT EXISTS ${LEDGER} (version TEXT PRIMARY KEY, filename TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`,
  `DO $drift$ DECLARE got text[]; BEGIN
  SELECT coalesce(array_agg(version || '|' || filename || '|' || sha256 ORDER BY version), '{}') INTO got FROM ${LEDGER};
  IF got IS DISTINCT FROM ${arr(startLines)} THEN RAISE EXCEPTION 'LEDGER_DRIFT: the ledger changed after the read-only precheck'; END IF;
END $drift$;`,
  `\\echo RUNNER|LOCKED`];
for (const m of pending) {
  script.push(`\\echo RUNNER|APPLYING|${m.version}`, 'BEGIN;',
    `DO $guard$ BEGIN IF EXISTS (SELECT 1 FROM ${LEDGER} WHERE version = '${m.version}') THEN RAISE EXCEPTION 'ALREADY_APPLIED: %', '${m.version}'; END IF; END $guard$;`,
    m.body, '', `INSERT INTO ${LEDGER} (version, filename, sha256) VALUES ('${m.version}', '${m.file}', '${m.sha}');`, 'COMMIT;',
    `\\echo RUNNER|APPLIED|${m.version}`);
}
script.push(`SELECT pg_advisory_unlock(${LOCK_KEY});`);
log(`apply: ${pending.length} migration(s), lock_timeout=${lockTimeout} statement_timeout=${statementTimeout}`);
const r = psql(script.join('\n'));
const marks = r.out.split('\n').filter((l) => l.startsWith('RUNNER|'));
const applied = marks.filter((l) => l.startsWith('RUNNER|APPLIED|')).map((l) => l.split('|')[2]);
const applying = marks.filter((l) => l.startsWith('RUNNER|APPLYING|')).map((l) => l.split('|')[2]);
for (const m of pending) {
  const status = applied.includes(m.version) ? 'APPLIED' : applying.includes(m.version) ? 'FAILED' : 'NOT_RUN';
  log(`${m.version}  ${m.sha.slice(0, 12)}  ${status}  ${m.file}`);
}
if (!r.ok) {
  const end = readState();
  log(`starting ledger: ${st.ledger.length} · ending ledger: ${end.ledger.length} (last ${end.ledger.at(-1)?.split('|')[0] ?? 'none'}) · applied: ${applied.length}`);
  const failed = applying.find((v) => !applied.includes(v));
  die('APPLY', failed ? `migration ${failed} failed: its SQL and its ledger row were rolled back together; no later migration ran`
    : 'the session failed before any migration ran (lock or ledger drift)', r.err.split('\n').filter((l) => /ERROR|DETAIL/.test(l)).slice(0, 3).join('\n'));
}
await finish(applied.length, st.ledger.length);
