#!/usr/bin/env node
/**
 * PHASE 31 Step 3 — Auth inventory / fingerprint / dump check / transaction-safe restore (D-PC-7). Never prints an
 * email, a password hash, a token or a UUID list: counts and sha256 fingerprints only. UUID lists go to private files.
 *
 * Commands:
 *   inventory    counts (users, identities per provider, MFA factors, sessions, refresh tokens, …) — READ ONLY
 *   fingerprint  counts + sha256 of the ordered auth.users ids and of the ordered (user_id, provider) identity pairs
 *                → --out <private json> ; optional --ids-out <private txt> (ordered ids, one per line)   — READ ONLY
 *   exclusions   READ ONLY: prints the -x value for `supabase db dump` = EVERY auth base table of the source database
 *                except the allowed ones (users, identities[, mfa_factors with --allow-mfa yes]). Built from the live
 *                catalog, so tables added by future Supabase Auth versions are excluded automatically.
 *   check-dump   --dump <file>: only COPY blocks of the allowed auth tables (users, identities[, mfa_factors]) plus
 *                pg_dump session settings; anything else refuses (prints statement kinds, never data)
 *   restore      --dump <file> --expect <fingerprint json of the source>: target must have 0 Auth rows; ONE
 *                transaction with session_replication_role = replica; after the COPY the fingerprint must equal
 *                the source fingerprint or everything rolls back
 *   compare      --a <fingerprint json> --b <fingerprint json>
 *
 * Connection: --db-env <NAME of an environment variable holding the URL> (LEGACY_DB_URL | CUTOVER_TARGET_DB_URL |
 * LOCAL_DB_URL); psql runs inside --client <container> with libpq variables (the URL never appears in argv / logs).
 *   --kind PRODUCTION_TARGET     needs --expected-ref <ref> (direct host db.<ref>.supabase.co or pooler user postgres.<ref>)
 *                                and --forbidden-refs <legacy ref>; restore also needs --confirm <ref>
 *   --kind LEGACY_READONLY       needs --expected-ref <legacy ref>; only inventory / fingerprint (read-only transaction)
 *   --kind LOCAL_REHEARSAL       loopback only
 * Private files (--out, --ids-out, --dump) must be outside the repository.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED_TABLES = ['users', 'identities', 'mfa_factors'];
const [command, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
const die = (code, msg, detail) => {
  console.error(`\nAUTH ${String(command).toUpperCase()} FAILED [${code}]: ${msg}`);
  if (detail) console.error(String(detail).replace(/password[^\s]*/gi, 'password=***').split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
  process.exit(1);
};
const log = (s) => console.log(`[phase31-auth] ${s}`);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const outsideRepo = (p) => !resolve(p).toLowerCase().startsWith(REPO.toLowerCase());
if (!['inventory', 'fingerprint', 'exclusions', 'check-dump', 'restore', 'compare'].includes(command)) die('USAGE', 'command must be inventory | fingerprint | exclusions | check-dump | restore | compare');

// ── dump check (no database) ────────────────────────────────────────────────
function checkDump(file, { allowMfa }) {
  if (!file || !existsSync(file)) die('USAGE', '--dump <file> is required');
  if (!outsideRepo(file)) die('USAGE', 'the dump must live outside the repository');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const tables = {}; const bad = [];
  let inCopy = null;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (inCopy) { if (l === '\\.') inCopy = null; else tables[inCopy] += 1; continue; }
    const t = l.trim();
    if (t === '' || t.startsWith('--')) continue;
    const copy = t.match(/^COPY "?auth"?\."?([a-z_]+)"? \([^)]*\) FROM stdin;$/);
    if (copy) {
      if (!ALLOWED_TABLES.includes(copy[1]) || (copy[1] === 'mfa_factors' && !allowMfa)) bad.push(`line ${i + 1}: COPY auth.${copy[1]} (not allowed)`);
      inCopy = copy[1]; tables[inCopy] = tables[inCopy] ?? 0; continue;
    }
    if (/^SET [a-z_.]+ = .+;$/i.test(t) || /^SELECT pg_catalog\.set_config\(.+\);$/.test(t) || /^RESET ALL;$/i.test(t)) continue;
    if (/^SELECT pg_catalog\.setval\('"?auth"?\."?(refresh_tokens_id_seq)"?', \d+, (true|false)\);$/.test(t)) continue;   // sequence position only
    bad.push(`line ${i + 1}: ${t.split(/\s+/).slice(0, 2).join(' ')} …`);   // statement kind only, never the data
  }
  if (inCopy) bad.push(`unterminated COPY auth.${inCopy}`);
  if (!tables.users) bad.push('no COPY auth.users block');
  if (!tables.identities) bad.push('no COPY auth.identities block');
  return { tables, bad };
}

// ── connection ──────────────────────────────────────────────────────────────
function connection() {
  const envName = opt['db-env'];
  if (!['LEGACY_DB_URL', 'CUTOVER_TARGET_DB_URL', 'LOCAL_DB_URL'].includes(envName)) die('USAGE', '--db-env LEGACY_DB_URL | CUTOVER_TARGET_DB_URL | LOCAL_DB_URL');
  const raw = process.env[envName];
  if (!raw) die('TARGET', `${envName} is not set (export it in your own shell; never paste it anywhere)`);
  let u; try { u = new URL(raw); } catch { die('TARGET', `${envName} is not a valid URL`); }
  const host = u.hostname; const user = decodeURIComponent(u.username || '');
  const loopback = ['127.0.0.1', 'localhost'].includes(host);
  const ref = (host.match(/^db\.([a-z0-9]{20})\.supabase\.co$/) || [])[1] || (user.match(/^postgres\.([a-z0-9]{20})$/) || [])[1] || null;
  const kind = opt.kind;
  if (kind === 'LOCAL_REHEARSAL') {
    if (!loopback) die('TARGET', 'LOCAL_REHEARSAL must be a loopback host');
  } else if (kind === 'PRODUCTION_TARGET' || kind === 'LEGACY_READONLY') {
    if (!/^[a-z0-9]{20}$/.test(opt['expected-ref'] || '')) die('USAGE', `${kind} requires --expected-ref <20-char project ref>`);
    if (ref !== opt['expected-ref']) die('TARGET', `connection project ref ${ref ?? 'UNKNOWN'} differs from --expected-ref`);
    if (kind === 'PRODUCTION_TARGET') {
      const forbidden = (opt['forbidden-refs'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!forbidden.length) die('USAGE', 'PRODUCTION_TARGET requires --forbidden-refs <legacy ref>');
      if (forbidden.includes(ref)) die('TARGET', 'the connection is the LEGACY project: refusing');
    }
  } else die('USAGE', '--kind PRODUCTION_TARGET | LEGACY_READONLY | LOCAL_REHEARSAL');
  if (!opt.client) die('USAGE', '--client <psql client container> is required');
  return { kind, ref, env: {
    PGHOST: host, PGPORT: u.port || '5432', PGUSER: user || 'postgres', PGPASSWORD: decodeURIComponent(u.password || ''),
    PGDATABASE: (u.pathname || '/postgres').slice(1) || 'postgres', PGSSLMODE: u.searchParams.get('sslmode') || (loopback ? 'disable' : 'require'),
  } };
}
function psql(conn, sqlText, extra = []) {
  const r = spawnSync('docker', ['exec', '-i', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE',
    opt.client, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra, '-f', '-'],
  { encoding: 'utf8', input: sqlText, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...conn.env } });
  if (r.error) die('DOCKER', 'could not run docker', r.error.message);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const READ_ONLY = (sql) => `BEGIN TRANSACTION READ ONLY;\n${sql}\nROLLBACK;`;
const INVENTORY_SQL = `SELECT json_build_object(
  'auth_users', (SELECT count(*) FROM auth.users),
  'auth_identities', (SELECT count(*) FROM auth.identities),
  'identities_by_provider', (SELECT coalesce(json_object_agg(provider, n ORDER BY provider), '{}') FROM (SELECT provider, count(*) n FROM auth.identities GROUP BY provider) x),
  'mfa_factors', (SELECT count(*) FROM auth.mfa_factors),
  'sessions', (SELECT count(*) FROM auth.sessions),
  'refresh_tokens', (SELECT count(*) FROM auth.refresh_tokens),
  'users_unconfirmed', (SELECT count(*) FROM auth.users WHERE email_confirmed_at IS NULL),
  'users_deleted', (SELECT count(*) FROM auth.users WHERE deleted_at IS NOT NULL),
  'users_anonymous', (SELECT count(*) FROM auth.users WHERE is_anonymous),
  'users_sso', (SELECT count(*) FROM auth.users WHERE is_sso_user),
  'users_example_invalid', (SELECT count(*) FROM auth.users WHERE email ILIKE '%@example.invalid'),
  'auth_schema_version', (SELECT max(version) FROM auth.schema_migrations)
)::text;`;
// Credentials fingerprint: ONE aggregate sha256 over the ordered users using only stable credential identity fields
// (user id, normalized email, encrypted_password). No timestamp, sign-in, session or token field takes part, so a login
// never changes it; an email or password-hash change always does. Only the aggregate (or a prefix) is ever printed.
const CREDENTIALS_EXPR = `'credentials_sha256', encode(sha256(convert_to(coalesce((SELECT string_agg(
    id::text || '|' || lower(btrim(coalesce(email, ''))) || '|' || coalesce(encrypted_password, ''), E'\\n' ORDER BY id) FROM auth.users), ''), 'UTF8')), 'hex')`;
const FINGERPRINT_SQL = `SELECT json_build_object(
  'users', (SELECT count(*) FROM auth.users),
  'identities', (SELECT count(*) FROM auth.identities),
  'mfa_factors', (SELECT count(*) FROM auth.mfa_factors),
  'providers', (SELECT coalesce(json_object_agg(provider, n ORDER BY provider), '{}') FROM (SELECT provider, count(*) n FROM auth.identities GROUP BY provider) x),
  'user_ids_sha256', encode(sha256(convert_to(coalesce((SELECT string_agg(id::text, E'\\n' ORDER BY id) FROM auth.users), ''), 'UTF8')), 'hex'),
  'identity_pairs_sha256', encode(sha256(convert_to(coalesce((SELECT string_agg(user_id::text || '|' || provider, E'\\n' ORDER BY user_id, provider) FROM auth.identities), ''), 'UTF8')), 'hex'),
  'mfa_pairs_sha256', encode(sha256(convert_to(coalesce((SELECT string_agg(user_id::text || '|' || factor_type::text, E'\\n' ORDER BY user_id, factor_type::text) FROM auth.mfa_factors), ''), 'UTF8')), 'hex'),
  ${CREDENTIALS_EXPR}
)::text;`;

function inventory() {
  const conn = connection();
  const r = psql(conn, READ_ONLY(INVENTORY_SQL));
  if (!r.ok) die('SQL', 'inventory query failed', r.err);
  const inv = JSON.parse(r.out.split('\n').filter(Boolean).pop());
  log(`inventory (${conn.kind}${conn.ref ? ` ${conn.ref}` : ''}): ${JSON.stringify(inv)}`);
}
function fingerprint() {
  const conn = connection();
  if (!opt.out || !outsideRepo(opt.out)) die('USAGE', '--out <private json outside the repository> is required');
  const r = psql(conn, READ_ONLY(FINGERPRINT_SQL));
  if (!r.ok) die('SQL', 'fingerprint query failed', r.err);
  const fp = JSON.parse(r.out.split('\n').filter(Boolean).pop());
  writeFileSync(opt.out, `${JSON.stringify({ kind: conn.kind, ref: conn.ref, at: new Date().toISOString(), ...fp }, null, 2)}\n`, { mode: 0o600 });
  if (opt['ids-out']) {
    if (!outsideRepo(opt['ids-out'])) die('USAGE', '--ids-out must be outside the repository');
    const ids = psql(conn, READ_ONLY('SELECT id FROM auth.users ORDER BY id;'));
    if (!ids.ok) die('SQL', 'id list query failed', ids.err);
    const lines = ids.out.split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l));
    writeFileSync(opt['ids-out'], `${lines.join('\n')}\n`, { mode: 0o600 });
    if (sha256(lines.join('\n')) !== fp.user_ids_sha256) die('FINGERPRINT', 'id list file does not match the fingerprint');
  }
  try { chmodSync(opt.out, 0o600); } catch { /* Windows */ }
  log(`fingerprint (${conn.kind}${conn.ref ? ` ${conn.ref}` : ''}): users=${fp.users} identities=${fp.identities} mfa=${fp.mfa_factors} `
    + `providers=${JSON.stringify(fp.providers)} user_ids_sha256=${fp.user_ids_sha256.slice(0, 16)}… identity_pairs_sha256=${fp.identity_pairs_sha256.slice(0, 16)}… credentials_sha256=${fp.credentials_sha256.slice(0, 16)}… → ${opt.out}`);
}
function exclusions() {
  const conn = connection();
  const allowed = opt['allow-mfa'] === 'yes' ? ['users', 'identities', 'mfa_factors'] : ['users', 'identities'];
  const r = psql(conn, READ_ONLY(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_type = 'BASE TABLE';`));
  if (!r.ok) die('SQL', 'auth table listing failed', r.err);
  const all = (r.out.split('\n').filter(Boolean).pop() || '').split(',').filter(Boolean);
  for (const t of allowed) if (!all.includes(t)) die('SCHEMA', `auth.${t} does not exist on the source`);
  const excl = all.filter((t) => !allowed.includes(t)).map((t) => `auth.${t}`);
  console.error(`[phase31-auth] exclusions (${conn.kind}${conn.ref ? ` ${conn.ref}` : ''}): ${all.length} auth tables; allowed=${allowed.join(',')}; excluded=${excl.length}`);
  console.log(excl.join(','));   // stdout = the -x value only (table names; no data)
}
function compare() {
  if (!opt.a || !opt.b) die('USAGE', '--a <fingerprint json> --b <fingerprint json>');
  const a = JSON.parse(readFileSync(opt.a, 'utf8')); const b = JSON.parse(readFileSync(opt.b, 'utf8'));
  const keys = ['users', 'identities', 'mfa_factors', 'providers', 'user_ids_sha256', 'identity_pairs_sha256', 'mfa_pairs_sha256', 'credentials_sha256'];
  // a fingerprint taken before the credentials fingerprint existed cannot prove the absence of drift: fail closed
  for (const [n, f] of [['a', a], ['b', b]]) if (!/^[0-9a-f]{64}$/.test(f.credentials_sha256 || '')) die('MISMATCH', `--${n} has no credentials_sha256: recompute it with this version of fingerprint`);
  const diff = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  log(`compare: users ${a.users}/${b.users} identities ${a.identities}/${b.identities} mfa ${a.mfa_factors}/${b.mfa_factors} providers ${JSON.stringify(a.providers)} / ${JSON.stringify(b.providers)}`);
  if (diff.length) die('MISMATCH', `fingerprints differ in: ${diff.join(', ')}`);
  log('compare: IDENTICAL (counts, providers, ordered UUID set, identity relationships, MFA, credentials)');
}
function restore() {
  const conn = connection();
  if (conn.kind === 'LEGACY_READONLY') die('USAGE', 'restore never runs against the legacy project');
  if (conn.kind === 'PRODUCTION_TARGET' && opt.confirm !== conn.ref) die('CONFIRM', '--confirm <target ref> is required for a PRODUCTION_TARGET restore');
  if (!opt.expect || !existsSync(opt.expect)) die('USAGE', '--expect <source fingerprint json> is required');
  const exp = JSON.parse(readFileSync(opt.expect, 'utf8'));
  const { tables, bad } = checkDump(opt.dump, { allowMfa: exp.mfa_factors > 0 });
  if (bad.length) die('DUMP', 'the dump contains statements outside the allowed Auth tables', bad.join('\n'));
  if (tables.users !== exp.users || tables.identities !== exp.identities || (tables.mfa_factors ?? 0) !== exp.mfa_factors)
    die('DUMP', `dump rows users=${tables.users} identities=${tables.identities} mfa=${tables.mfa_factors ?? 0} differ from the source fingerprint (${exp.users}/${exp.identities}/${exp.mfa_factors})`);
  const pre = psql(conn, READ_ONLY(INVENTORY_SQL));
  if (!pre.ok) die('SQL', 'preflight failed', pre.err);
  const inv = JSON.parse(pre.out.split('\n').filter(Boolean).pop());
  if (inv.auth_users || inv.auth_identities || inv.mfa_factors || inv.sessions || inv.refresh_tokens)
    die('NOT_EMPTY', `the destination Auth is not empty (users=${inv.auth_users} identities=${inv.auth_identities} mfa=${inv.mfa_factors} sessions=${inv.sessions} refresh_tokens=${inv.refresh_tokens})`);
  const triggers = psql(conn, `SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('auth.users'::regclass, 'auth.identities'::regclass) AND NOT tgisinternal;`);
  // ONE transaction: replica role (no trigger fires), the dump's COPY blocks, then an in-transaction fingerprint check
  const script = `BEGIN;
SET LOCAL session_replication_role = replica;
${readFileSync(opt.dump, 'utf8').replace(/^SET session_replication_role = replica;\s*$/m, '-- (session_replication_role set above, transaction-local)').replace(/^RESET ALL;\s*$/gm, '-- RESET ALL skipped inside the transaction')}
DO $$ DECLARE fp jsonb; BEGIN
  SELECT jsonb_build_object('users', (SELECT count(*) FROM auth.users), 'identities', (SELECT count(*) FROM auth.identities),
    'mfa_factors', (SELECT count(*) FROM auth.mfa_factors),
    'user_ids_sha256', encode(sha256(convert_to(coalesce((SELECT string_agg(id::text, E'\\n' ORDER BY id) FROM auth.users), ''), 'UTF8')), 'hex'),
    'identity_pairs_sha256', encode(sha256(convert_to(coalesce((SELECT string_agg(user_id::text || '|' || provider, E'\\n' ORDER BY user_id, provider) FROM auth.identities), ''), 'UTF8')), 'hex'),
    ${CREDENTIALS_EXPR})
    INTO fp;
  IF fp->>'users' <> '${Number(exp.users)}' OR fp->>'identities' <> '${Number(exp.identities)}' OR fp->>'mfa_factors' <> '${Number(exp.mfa_factors)}'
     OR fp->>'user_ids_sha256' <> '${String(exp.user_ids_sha256).replace(/[^0-9a-f]/g, '')}'
     OR fp->>'identity_pairs_sha256' <> '${String(exp.identity_pairs_sha256).replace(/[^0-9a-f]/g, '')}'
     OR fp->>'credentials_sha256' <> '${String(exp.credentials_sha256 || '').replace(/[^0-9a-f]/g, '')}' THEN
    RAISE EXCEPTION 'AUTH_RESTORE_MISMATCH: restored Auth differs from the source fingerprint; rolling back';
  END IF;
  IF (SELECT count(*) FROM auth.sessions) + (SELECT count(*) FROM auth.refresh_tokens) > 0 THEN
    RAISE EXCEPTION 'AUTH_RESTORE_SESSIONS: session rows present; rolling back';
  END IF;
END $$;
COMMIT;`;
  const r = psql(conn, script);
  if (!r.ok) die('RESTORE', 'restore failed; the whole transaction was rolled back (nothing written)', r.err.split('\n').filter((l) => /ERROR|DETAIL|HINT/.test(l)).map((l) => l.replace(/\(.*\)/, '(…)')).join('\n'));
  log(`restore (${conn.kind}${conn.ref ? ` ${conn.ref}` : ''}): committed users=${exp.users} identities=${exp.identities} mfa=${exp.mfa_factors}; `
    + `fingerprint verified inside the transaction; auth triggers on the destination=${triggers.out || '?'} (replica role during COPY)`);
}

if (command === 'check-dump') {
  const { tables, bad } = checkDump(opt.dump, { allowMfa: opt['allow-mfa'] === 'yes' });
  log(`check-dump: COPY rows ${JSON.stringify(tables)}`);
  if (bad.length) die('DUMP', 'the dump contains statements outside the allowed Auth tables', bad.join('\n'));
  log('check-dump: PASS (only allowed Auth tables; pg_dump session settings)');
}
if (command === 'exclusions') exclusions();
if (command === 'inventory') inventory();
if (command === 'fingerprint') fingerprint();
if (command === 'compare') compare();
if (command === 'restore') restore();
