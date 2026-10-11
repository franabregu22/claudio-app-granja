#!/usr/bin/env node
/**
 * apply-incremental.mjs — END-TO-END tests on a DISPOSABLE local Supabase project that simulates post-cutover production:
 * target migrations 0001→0072 (applied by the runner itself from an empty target), then representative data (Auth users,
 * profiles, a client, financial operations / postings, a Storage object; BNA / Patagonia come from the migration seeds).
 *
 * It writes to the database, so it refuses to run unless INCR_TEST_PROJECT names a disposable project whose db container
 * is the only Supabase stack running (never Claudio_app_Granja).
 *
 *   INCR_TEST_PROJECT=granja_fresh_0073 node scripts/target-db/apply-incremental.e2e.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const RUNNER = join(REPO, 'scripts', 'target-db', 'apply-incremental.mjs');
const PROVISION = join(REPO, 'scripts', 'phase31', 'provision-target.mjs');
const MIG = join(REPO, 'supabase', 'target-migrations');
const PROJECT = process.env.INCR_TEST_PROJECT ?? '';
if (!PROJECT || PROJECT === 'Claudio_app_Granja') { console.error('  INCR_TEST_PROJECT must name a disposable project'); process.exit(2); }
const CLIENT = `supabase_db_${PROJECT}`;
const names = (spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/);
if (!names.includes(CLIENT) || names.some((n) => n.endsWith('_Claudio_app_Granja'))) { console.error(`  ${CLIENT} must be the only Supabase stack running`); process.exit(2); }
const URL_ = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';   // as seen from inside the client container

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 400)}`); } };
const psql = (sql) => {
  const r = spawnSync('docker', ['exec', '-i', CLIENT, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
};
const runner = (args, extraEnv = {}) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [RUNNER, '--client', CLIENT, ...args], { encoding: 'utf8', env: { ...process.env, MIGRATION_TARGET_DB_URL: URL_, ...extraEnv } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, ms: Date.now() - t };
};
const background = (sql) => {
  const p = spawn('docker', ['exec', '-i', CLIENT, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q'], { stdio: ['pipe', 'ignore', 'ignore'] });
  p.stdin.end(sql);
  return new Promise((done) => p.on('close', done));
};
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const snapshot = () => psql(`SELECT coalesce((SELECT md5(string_agg(version || filename || sha256, ',' ORDER BY version)) FROM migration_ledger.applied), 'none')
  || '|' || (SELECT count(*) FROM migration_ledger.applied) || '|' || (SELECT count(*) FROM pg_class) || '|' || (SELECT count(*) FROM pg_proc)
  || '|' || (SELECT count(*) FROM perfiles) || '|' || (SELECT count(*) FROM financial_posting);`);
const ledgerLast = () => psql(`SELECT max(version) || ':' || count(*) FROM migration_ledger.applied;`);
const tmp = (label) => mkdtempSync(join(tmpdir(), `incr-${label}-`));
const copyMigrations = (upto) => { const d = tmp('mig'); for (const f of readdirSync(MIG)) if (f.slice(0, 4) <= upto) cpSync(join(MIG, f), join(d, f)); return d; };
const dirs = [];

// ── setup: an existing target at 0072 with data ──────────────────────────────
const d72 = copyMigrations('0072'); dirs.push(d72);
let r = runner(['--migrations-dir', d72, '--from', '0000', '--to', '0072']);
check('setup: empty target → 0072 applied by the runner (local only)', r.code === 0 && /RESULT: APPLIED 0000→0072/.test(r.out), r.out.slice(-400));
const env = (spawnSync('docker', ['inspect', `supabase_edge_runtime_${PROJECT}`, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/);
const svc = (env.find((l) => l.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) ?? '').slice('SUPABASE_SERVICE_ROLE_KEY='.length);
const tag = crypto.randomUUID().slice(0, 8);
for (const [role, email] of [['ADMIN', `incr-admin-${tag}@example.invalid`], ['OPERATOR', `incr-operator-${tag}@example.invalid`]]) {
  const res = await fetch('http://127.0.0.1:54321/auth/v1/admin/users', { method: 'POST',
    headers: { apikey: svc, authorization: `Bearer ${svc}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: `Incr-${crypto.randomUUID()}`, email_confirm: true }) });
  const id = (await res.json()).id;
  if (!/^[0-9a-f-]{36}$/.test(String(id))) { console.error('  setup: could not create a synthetic Auth user'); process.exit(2); }
  psql(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${id}', '${email}', '${role}', true);`);
}
psql(`INSERT INTO clients (nombre) VALUES ('INCR CLIENTE SINTETICO');
INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('TRANSFER', '2026-10-05', 'INCR-OP-1', 'synthetic');
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT o.id, a.id, x.amt, '2026-10-05' FROM financial_operation o, (VALUES ('BNA', 100.00), ('Caja chica', -100.00)) x(acc, amt)
  JOIN financial_account a ON a.nombre = x.acc WHERE o.external_ref = 'INCR-OP-1';
INSERT INTO storage.objects (bucket_id, name) VALUES ('purchase-attachments', 'incr/synthetic.pdf');`);
check('setup: target holds data (auth users, profiles, postings, storage object; BNA / Patagonia seeded)',
  psql(`SELECT (SELECT count(*) FROM auth.users) >= 2 AND (SELECT count(*) FROM perfiles) >= 2 AND (SELECT count(*) FROM financial_posting) >= 2
    AND (SELECT count(*) FROM storage.objects) >= 1 AND (SELECT count(*) FROM financial_account WHERE nombre IN ('BNA','Patagonia') AND account_type = 'BANK_ACCOUNT') = 2;`) === 't');
check('setup: ledger exactly 0072', ledgerLast() === '0072:72', ledgerLast());

// ── 11. provisioning runner still refuses an existing database with data ────
const prov = (cmd) => {
  const x = spawnSync(process.execPath, [PROVISION, cmd, '--kind', 'LOCAL_PROVISION_REHEARSAL', '--expected-host', '127.0.0.1', '--client', CLIENT],
    { encoding: 'utf8', env: { ...process.env, CUTOVER_TARGET_DB_URL: URL_ } });
  return { code: x.status, out: `${x.stdout || ''}${x.stderr || ''}` };
};
let snap = snapshot();
let p = prov('preflight');
check('11a provisioning preflight refuses the populated target (NOT_FRESH)', p.code !== 0 && /NOT_FRESH/.test(p.out), p.out.slice(-300));
p = prov('apply');
check('11b provisioning apply refuses it as well (preflight first), nothing written', p.code !== 0 && /PREFLIGHT/.test(p.out) && snapshot() === snap, p.out.slice(-300));

// ── 12 / 1. dry-run: pending set, zero writes ───────────────────────────────
snap = snapshot();
r = runner(['--from', '0072', '--to', '0077', '--dry-run']);
check('1 dry-run lists exactly 0073–0077 as PENDING, in order',
  r.code === 0 && ['0073', '0074', '0075', '0076', '0077'].every((v) => new RegExp(`${v}\\s+[0-9a-f]{12}\\s+PENDING`).test(r.out))
  && /would be applied in this order: 0073 → 0074 → 0075 → 0076 → 0077/.test(r.out), r.out.slice(-500));
check('12 dry-run executed no SQL and wrote nothing (ledger, catalog and data identical)', snapshot() === snap && !/APPLYING/.test(r.out));

// ── 7. wrong expected start ─────────────────────────────────────────────────
r = runner(['--from', '0071', '--to', '0077', '--dry-run']);
check('7 --from 0071 on a target at 0072 → LEDGER_STATE', r.code === 2 && /\[LEDGER_STATE\]/.test(r.out), r.out.slice(-300));

// ── 8. --to that would leave a local file out ───────────────────────────────
r = runner(['--from', '0072', '--to', '0076']);
check('8 --to 0076 while 0077 exists locally → FILES (pending set would differ), nothing written', r.code === 2 && /\[FILES\]/.test(r.out) && snapshot() === snap, r.out.slice(-300));

// ── 4. altered historical migration ─────────────────────────────────────────
const dAlt = copyMigrations('0077'); dirs.push(dAlt);
appendFileSync(join(dAlt, readdirSync(dAlt).find((f) => f.startsWith('0050_'))), '\n-- altered after it was applied\n');
r = runner(['--migrations-dir', dAlt, '--from', '0072', '--to', '0077']);
check('4 altered sha256 of an APPLIED migration (0050) → LEDGER_SHA_MISMATCH before any write', r.code === 2 && /\[LEDGER_SHA_MISMATCH\]: version 0050/.test(r.out) && snapshot() === snap, r.out.slice(-300));

// ── 5. unknown remote migration; missing intermediate ───────────────────────
psql(`INSERT INTO migration_ledger.applied (version, filename, sha256) VALUES ('0500', '0500_ghost.sql', repeat('0', 64));`);
r = runner(['--from', '0072', '--to', '0077']);
check('5 ledger holds a version unknown locally (0500) → LEDGER_UNKNOWN_MIGRATION', r.code === 2 && /\[LEDGER_UNKNOWN_MIGRATION\]: .*0500/.test(r.out), r.out.slice(-300));
psql(`DELETE FROM migration_ledger.applied WHERE version = '0500';`);
const row50 = psql(`SELECT version || '|' || filename || '|' || sha256 || '|' || applied_at FROM migration_ledger.applied WHERE version = '0050';`).split('|');
psql(`DELETE FROM migration_ledger.applied WHERE version = '0050';`);
r = runner(['--from', '0072', '--to', '0077']);
check('5b a missing intermediate version (0050) → LEDGER_STATE naming it', r.code === 2 && /\[LEDGER_STATE\]/.test(r.out) && /0050/.test(r.out), r.out.slice(-300));
psql(`INSERT INTO migration_ledger.applied (version, filename, sha256, applied_at) VALUES ('${row50[0]}', '${row50[1]}', '${row50[2]}', '${row50[3]}');`);
check('5c ledger restored exactly', snapshot() === snap);

// ── 10. concurrent runner (advisory lock) ───────────────────────────────────
let bg = background(`SELECT pg_advisory_lock(hashtext('target_v1_migration_runner')); SELECT pg_sleep(6);`);
await sleep(1500);
r = runner(['--from', '0072', '--to', '0077', '--dry-run']);
check('10a dry-run while another runner holds the lock → LOCK_BUSY', r.code === 2 && /\[LOCK_BUSY\]/.test(r.out), r.out.slice(-300));
r = runner(['--from', '0072', '--to', '0077']);
check('10b apply while another runner holds the lock → LOCK_BUSY, never waits, nothing written', r.code === 2 && /\[LOCK_BUSY\]/.test(r.out) && r.ms < 5000 && snapshot() === snap, `${r.ms} ms ${r.out.slice(-300)}`);
await bg;

// ── lock_timeout: a production table locked by another session → fail fast, no partial state ──
bg = background(`BEGIN; LOCK TABLE financial_account IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8); COMMIT;`);
await sleep(1500);
r = runner(['--from', '0072', '--to', '0077', '--lock-timeout', '1s']);
check('13 a blocked lock fails after lock_timeout (0073 FAILED, 0074+ NOT_RUN), no wait, ledger still 0072',
  r.code === 2 && /0073\s+[0-9a-f]{12}\s+FAILED/.test(r.out) && /0074\s+[0-9a-f]{12}\s+NOT_RUN/.test(r.out) && r.ms < 6000
  && ledgerLast() === '0072:72' && psql(`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'fin\\_%';`) === '0', `${r.ms} ms ${r.out.slice(-400)}`);
await bg;

// ── 2. apply 0072 → 0077 + post verify ──────────────────────────────────────
const before = psql(`SELECT (SELECT count(*) FROM perfiles) || '|' || (SELECT count(*) FROM financial_posting) || '|' || (SELECT count(*) FROM auth.users);`);
r = runner(['--from', '0072', '--to', '0077', '--verify-profile', 'ADR018_POST_0077', '--deployment-check']);
check('2 apply 0072→0077: each APPLIED, ledger 77, profile ADR018_POST_0077 + deployment check PASS',
  r.code === 0 && ['0073', '0074', '0075', '0076', '0077'].every((v) => new RegExp(`${v}\\s+[0-9a-f]{12}\\s+APPLIED`).test(r.out))
  && /RESULT: APPLIED 0072→0077/.test(r.out) && !/MAL/.test(r.out) && ledgerLast() === '0077:77', r.out.slice(-1500));
check('2 existing data untouched', psql(`SELECT (SELECT count(*) FROM perfiles) || '|' || (SELECT count(*) FROM financial_posting) || '|' || (SELECT count(*) FROM auth.users);`) === before);
check('2 output never contains the password', !/postgres:postgres@/.test(r.out));

// ── 3. re-run: safe no-op ───────────────────────────────────────────────────
snap = snapshot();
r = runner(['--from', '0072', '--to', '0077', '--verify-profile', 'ADR018_POST_0077']);
check('3 re-run → NO-OP, 0 pending, profile PASS, nothing written', r.code === 0 && /RESULT: NO-OP/.test(r.out) && !/MAL/.test(r.out) && snapshot() === snap, r.out.slice(-400));

// ── 9. failing migration: rolled back with its ledger row, later ones never run ──
const dFail = copyMigrations('0077'); dirs.push(dFail);
writeFileSync(join(dFail, '0078_incr_test_ok.sql'), 'CREATE TABLE public.incr_test_78 (id INT);\n');
writeFileSync(join(dFail, '0079_incr_test_fail.sql'), 'CREATE TABLE public.incr_test_79 (id INT);\nSELECT 1 / 0;\n');
writeFileSync(join(dFail, '0080_incr_test_after.sql'), 'CREATE TABLE public.incr_test_80 (id INT);\n');
r = runner(['--migrations-dir', dFail, '--from', '0077', '--to', '0080']);
const t = psql(`SELECT (to_regclass('public.incr_test_78') IS NOT NULL) || '|' || (to_regclass('public.incr_test_79') IS NOT NULL) || '|' || (to_regclass('public.incr_test_80') IS NOT NULL);`);
check('9 0078 APPLIED, 0079 FAILED (its table and ledger row rolled back), 0080 NOT_RUN',
  r.code === 2 && /0078\s+[0-9a-f]{12}\s+APPLIED/.test(r.out) && /0079\s+[0-9a-f]{12}\s+FAILED/.test(r.out) && /0080\s+[0-9a-f]{12}\s+NOT_RUN/.test(r.out)
  && t === 'true|false|false' && ledgerLast() === '0078:78', `${t} ${ledgerLast()} ${r.out.slice(-500)}`);
r = runner(['--migrations-dir', dFail, '--from', '0077', '--to', '0080']);
check('9b the partial state is never continued implicitly → LEDGER_STATE', r.code === 2 && /\[LEDGER_STATE\]/.test(r.out), r.out.slice(-300));

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n  ══ APPLY-INCREMENTAL E2E RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
