#!/usr/bin/env node
/**
 * Phase 31 auth-restore.mjs — dump contract regression. Synthetic dumps only (no real Auth data).
 *   D*  check-dump, offline: ALLOW only COPY auth.users / auth.identities (+ auth.mfa_factors with --allow-mfa yes);
 *       every other auth table (incl. the hosted mfa_recovery_code_sets, mfa_recovery_codes, scim_tokens, scim_users)
 *       and any unknown future table is refused.
 *   E*  exclusions, against the guarded LOCAL stack: the -x list is built from the live catalog, so newly added auth
 *       tables are excluded automatically (temporary tables created and dropped by the test).
 *
 * Usage: node scripts/phase31/auth-restore.test.mjs   (E* needs the local stack; skipped with a note otherwise)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const T = join(REPO, 'scripts', 'phase31', 'auth-restore.mjs');
const dir = mkdtempSync(join(tmpdir(), 'p31-dumptest-'));
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 300)}`); } };
const run = (args, env = {}) => { const r = spawnSync(process.execPath, [T, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }); return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: (r.stdout || '').trim() }; };

const HEAD = 'SET session_replication_role = replica;\n\nSET statement_timeout = 0;\nSELECT pg_catalog.set_config(\'search_path\', \'\', false);\n';
const block = (t, rows = 1) => `COPY "auth"."${t}" ("id", "x") FROM stdin;\n${Array.from({ length: rows }, (_, i) => `00000000-0000-4000-8000-00000000000${i}\tsynthetic`).join('\n')}\n\\.\n\n`;
const dump = (name, body) => { const f = join(dir, `${name}.sql`); writeFileSync(f, `${HEAD}${body}RESET ALL;\n`); return f; };
const checkDump = (f, extra = []) => run(['check-dump', '--dump', f, ...extra]);
const refusedFor = (r, t) => !r.ok && new RegExp(`COPY auth\\.${t} \\(not allowed\\)`).test(r.out);

try {
  console.log('\n  [check-dump contract]');
  let r = checkDump(dump('ok', block('users', 5) + block('identities', 5)));
  check('D1 users + identities only → PASS', r.ok && /COPY rows \{"users":5,"identities":5\}/.test(r.out), r.out);
  for (const [i, t] of ['mfa_recovery_code_sets', 'mfa_recovery_codes', 'scim_tokens', 'scim_users'].entries()) {
    r = checkDump(dump(`hosted-${t}`, block('users') + block('identities') + block(t)));
    check(`D${2 + i} hosted table auth.${t} → refused`, refusedFor(r, t), r.out);
  }
  r = checkDump(dump('future', block('users') + block('identities') + block('passkey_future_table')));
  check('D6 unknown future auth table → refused (fail closed)', refusedFor(r, 'passkey_future_table'), r.out);
  r = checkDump(dump('mfa', block('users') + block('identities') + block('mfa_factors')));
  check('D7 auth.mfa_factors without --allow-mfa → refused', refusedFor(r, 'mfa_factors'), r.out);
  r = checkDump(dump('mfa2', block('users') + block('identities') + block('mfa_factors')), ['--allow-mfa', 'yes']);
  check('D8 auth.mfa_factors with --allow-mfa yes → PASS', r.ok, r.out);
  r = checkDump(dump('sess', block('users') + block('identities') + block('sessions') + block('refresh_tokens')));
  check('D9 sessions / refresh_tokens → refused', refusedFor(r, 'sessions') && refusedFor(r, 'refresh_tokens'), r.out);
  r = checkDump(dump('stmt', `${block('users')}${block('identities')}INSERT INTO auth.users (id) VALUES ('x');\nDROP TABLE auth.users;\n`));
  check('D10 non-COPY statements (INSERT / DROP) → refused, statement kind only', !r.ok && /INSERT INTO/.test(r.out) && /DROP TABLE/.test(r.out) && !/VALUES \('x'\)/.test(r.out), r.out);
  r = checkDump(dump('noident', block('users')));
  check('D11 no auth.identities block → refused', !r.ok && /no COPY auth\.identities block/.test(r.out), r.out);
  r = checkDump(dump('unterminated', `${block('users')}COPY "auth"."identities" ("id") FROM stdin;\nrow\n`));
  check('D12 unterminated COPY → refused', !r.ok && /unterminated COPY auth\.identities/.test(r.out), r.out);
  r = checkDump(dump('public', `${block('users')}${block('identities')}COPY "public"."perfiles" ("id") FROM stdin;\nrow\n\\.\n`));
  check('D13 COPY outside the auth schema → refused', !r.ok && /COPY "public"/.test(r.out), r.out);
  writeFileSync(join(REPO, 'tmp-p31-dump.sql'), '');
  r = checkDump(join(REPO, 'tmp-p31-dump.sql'));
  rmSync(join(REPO, 'tmp-p31-dump.sql'), { force: true });
  check('D14 a dump inside the repository → refused', !r.ok && /outside the repository/.test(r.out), r.out);
  r = checkDump(dump('privacy', block('users') + block('identities') + block('scim_users')));
  check('D15 refusal output never contains row data', !/synthetic/.test(r.out) && !/00000000-0000-4000/.test(r.out), r.out);

  console.log('\n  [exclusions from the live catalog (local stack)]');
  const container = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  if (!container) console.log('    SKIP E* (no local supabase_db container)');
  else {
    // the local auth schema belongs to supabase_admin: the probe tables are created (and always dropped) as that role
    const psql = (sql) => spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: sql });
    const extra = ['mfa_recovery_code_sets', 'mfa_recovery_codes', 'scim_tokens', 'scim_users', 'zz_future_table'];
    const created = extra.filter((t) => (psql(`SELECT to_regclass('auth.${t}') IS NULL;`).stdout || '').trim() === 't'
      && psql(`CREATE TABLE auth.${t} (id int);`).status === 0);
    check('E0 probe tables simulating the hosted additions were created locally', created.length === extra.length, `${created.length}/${extra.length}`);
    try {
      const env = { LOCAL_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' };
      const base = ['exclusions', '--db-env', 'LOCAL_DB_URL', '--kind', 'LOCAL_REHEARSAL', '--client', container];
      r = run(base, env);
      const list = r.stdout.split(',');
      check('E1 exclusions lists every auth table except users / identities (incl. the 4 hosted tables and a future one)',
        r.ok && extra.every((t) => list.includes(`auth.${t}`)) && !list.includes('auth.users') && !list.includes('auth.identities')
        && list.includes('auth.mfa_factors') && list.includes('auth.sessions') && list.includes('auth.refresh_tokens'), r.out);
      r = run([...base, '--allow-mfa', 'yes'], env);
      check('E2 with --allow-mfa yes, auth.mfa_factors is no longer excluded (everything else still is)',
        r.ok && !r.stdout.split(',').includes('auth.mfa_factors') && r.stdout.split(',').includes('auth.mfa_recovery_codes'), r.out);
      check('E3 stdout is only the -x value (comma-separated auth.* names)', /^auth\.[a-z_]+(,auth\.[a-z_]+)*$/.test(r.stdout), r.stdout);
    } finally {
      for (const t of created) psql(`DROP TABLE IF EXISTS auth.${t};`);
    }

    console.log('\n  [credentials fingerprint (local stack, synthetic users)]');
    const sql = (q) => spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: q });
    const U1 = 'c4ed0000-0000-4000-8000-000000000001'; const U2 = 'c4ed0000-0000-4000-8000-000000000002';
    const HASH1 = '$2a$10$syntheticSYNTHETICsyntheticSYNTHETICsyntheticSYNTHE1';
    const HASH2 = '$2a$10$syntheticSYNTHETICsyntheticSYNTHETICsyntheticSYNTHE2';
    const cleanup = () => sql(`DELETE FROM auth.sessions WHERE user_id IN ('${U1}', '${U2}'); DELETE FROM auth.identities WHERE user_id IN ('${U1}', '${U2}'); DELETE FROM auth.users WHERE id IN ('${U1}', '${U2}');`);
    cleanup();
    const seed = sql(`INSERT INTO auth.users (id, email, encrypted_password, is_sso_user, is_anonymous, updated_at) VALUES
      ('${U1}', 'c4-one@test.local', '${HASH1}', false, false, now()), ('${U2}', 'c4-two@test.local', '${HASH2}', false, false, now());
      INSERT INTO auth.identities (user_id, provider, provider_id, identity_data) VALUES
      ('${U1}', 'email', '${U1}', '{}'::jsonb), ('${U2}', 'email', '${U2}', '{}'::jsonb);`);
    try {
      check('C0 synthetic credential fixtures inserted', seed.status === 0, seed.stderr);
      const env = { LOCAL_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' };
      const base = ['--db-env', 'LOCAL_DB_URL', '--kind', 'LOCAL_REHEARSAL', '--client', container];
      const outputs = [];
      const fp = (name) => { const f = join(dir, `${name}.json`); const x = run(['fingerprint', ...base, '--out', f], env); outputs.push(x.out); return { f, x }; };
      const cmp = (a, b) => { const x = run(['compare', '--a', a.f, '--b', b.f]); outputs.push(x.out); return x; };
      const A = fp('a'); const B = fp('b');
      let c = cmp(A, B);
      check('C1 same credentials → IDENTICAL (credentials included)', A.x.ok && c.ok && /IDENTICAL .*credentials/.test(c.out), c.out);
      sql(`UPDATE auth.users SET last_sign_in_at = now(), updated_at = now() + interval '1 day', confirmed_at = coalesce(confirmed_at, now()) WHERE id IN ('${U1}', '${U2}');
           INSERT INTO auth.sessions (id, user_id) VALUES (gen_random_uuid(), '${U1}');`);
      const V = fp('volatile');
      c = cmp(A, V);
      check('C2 login / session / timestamp changes do NOT change the credentials fingerprint',
        JSON.parse(readFileSync(A.f, 'utf8')).credentials_sha256 === JSON.parse(readFileSync(V.f, 'utf8')).credentials_sha256 && c.ok, c.out);
      sql(`UPDATE auth.users SET email = 'c4-changed@test.local' WHERE id = '${U1}';`);
      const E = fp('email');
      c = cmp(A, E);
      check('C3 changed email → MISMATCH on credentials_sha256 only', !c.ok && /fingerprints differ in: credentials_sha256$/m.test(c.out), c.out);
      sql(`UPDATE auth.users SET email = 'C4-One@Test.Local ' WHERE id = '${U1}';`);
      const N = fp('normalized');
      c = cmp(A, N);
      check('C4 email case / surrounding spaces are normalized (same address → IDENTICAL)', c.ok, c.out);
      sql(`UPDATE auth.users SET email = 'c4-one@test.local', encrypted_password = '${HASH2}' WHERE id = '${U1}';`);
      const P = fp('password');
      c = cmp(A, P);
      check('C5 changed encrypted_password → MISMATCH on credentials_sha256 only', !c.ok && /fingerprints differ in: credentials_sha256$/m.test(c.out), c.out);
      const legacyFile = join(dir, 'old.json');
      const old = JSON.parse(readFileSync(A.f, 'utf8')); delete old.credentials_sha256; writeFileSync(legacyFile, JSON.stringify(old));
      c = run(['compare', '--a', legacyFile, '--b', A.f]); outputs.push(c.out);
      check('C6 a fingerprint without credentials_sha256 (older version) → fail closed', !c.ok && /has no credentials_sha256/.test(c.out), c.out);
      const all = outputs.join('\n');
      check('C7 no email, UUID, password hash or full credential hash is printed',
        !/@test\.local|@Test\.Local/i.test(all) && !/c4ed0000-/.test(all) && !/\$2a\$/.test(all)
        && !all.includes(JSON.parse(readFileSync(A.f, 'utf8')).credentials_sha256), 'sensitive value in output');
    } finally {
      cleanup();
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
