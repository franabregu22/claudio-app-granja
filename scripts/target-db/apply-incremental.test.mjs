#!/usr/bin/env node
/**
 * apply-incremental.mjs — OFFLINE guard tests. No case reaches a database: every case must abort with its specific code
 * BEFORE connecting (the client container does not exist, so a case that tried to connect would end with DOCKER /
 * CONNECT instead of the expected code).
 *
 * Usage: node scripts/target-db/apply-incremental.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const R = join(REPO, 'scripts', 'target-db', 'apply-incremental.mjs');
const REF = 'ycmkpnunhxluqqtecbyu';
const OTHER = 'abcdefghijklmnopqrst';
const LEGACY = 'aplbsutpzgemexayldct';
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 300)}`); } };

function run(args, url) {
  const env = { ...process.env };
  if (url === null) delete env.MIGRATION_TARGET_DB_URL; else env.MIGRATION_TARGET_DB_URL = url;
  const r = spawnSync(process.execPath, [R, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const POOLER = (ref) => `postgresql://postgres.${ref}:SECRETPW@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
const DIRECT = (ref) => `postgresql://postgres:SECRETPW@db.${ref}.supabase.co:5432/postgres`;
const LOCAL = 'postgresql://postgres:SECRETPW@127.0.0.1:5432/postgres';
const base = ['--from', '0072', '--to', '0080', '--client', 'no-such-container'];
const prod = (ref = REF, extra = []) => [...base, '--production', '--expected-project-ref', ref, '--forbidden-refs', LEGACY,
  '--confirm-project', ref, '--confirm-from', '0072', '--confirm-to', '0080', ...extra];
const aborted = (r, code) => r.code === 2 && r.out.includes(`[${code}]`) && !/\[(DOCKER|CONNECT)\]/.test(r.out);
const noSecret = (r) => !r.out.includes('SECRETPW');

let r = run(base, null);
check('no MIGRATION_TARGET_DB_URL → TARGET', aborted(r, 'TARGET'), r.out);
r = run(['--to', '0077', '--client', 'x'], LOCAL);
check('missing --from → USAGE', aborted(r, 'USAGE'), r.out);
r = run(['--from', '0077', '--to', '0072', '--client', 'x'], LOCAL);
check('--from >= --to → USAGE', aborted(r, 'USAGE'), r.out);
r = run([...base, '--unknown', 'x'], LOCAL);
check('unknown option → USAGE', aborted(r, 'USAGE'), r.out);

// project identity
r = run(base, POOLER(REF));
check('remote host without --production → TARGET (never an implicit production run)', aborted(r, 'TARGET'), r.out);
r = run(prod(REF), POOLER(OTHER));
check('6a pooler user of ANOTHER project → PROJECT', aborted(r, 'PROJECT') && /differs from --expected-project-ref/.test(r.out), r.out);
r = run(prod(REF), DIRECT(OTHER));
check('6b direct host of ANOTHER project → PROJECT', aborted(r, 'PROJECT'), r.out);
r = run(prod(LEGACY), POOLER(LEGACY));
check('6c the expected ref is itself a forbidden legacy ref → PROJECT', aborted(r, 'PROJECT') && /forbidden/.test(r.out), r.out);
r = run(prod(REF), `postgresql://postgres:SECRETPW@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`);
check('6d connection without any project ref → PROJECT', aborted(r, 'PROJECT') && /carries no Supabase project ref/.test(r.out), r.out);
r = run(prod(REF), LOCAL);
check('--production on a loopback host → TARGET', aborted(r, 'TARGET'), r.out);
r = run([...base, '--production', '--expected-project-ref', REF, '--confirm-project', REF, '--confirm-from', '0072', '--confirm-to', '0080'], POOLER(REF));
check('--production without --forbidden-refs → USAGE', aborted(r, 'USAGE'), r.out);

// production confirmations
const withoutConfirm = (k) => { const a = prod(REF); const i = a.indexOf(`--${k}`); a.splice(i, 2); return a; };
for (const k of ['confirm-project', 'confirm-from', 'confirm-to']) {
  r = run(withoutConfirm(k), POOLER(REF));
  check(`--production without --${k} → CONFIRM`, aborted(r, 'CONFIRM'), r.out);
}
r = run([...base, '--production', '--expected-project-ref', REF, '--forbidden-refs', LEGACY, '--confirm-project', OTHER, '--confirm-from', '0072', '--confirm-to', '0080'], POOLER(REF));
check('--confirm-project of another project → CONFIRM', aborted(r, 'CONFIRM'), r.out);
r = run([...base, '--production', '--expected-project-ref', REF, '--forbidden-refs', LEGACY, '--confirm-project', REF, '--confirm-from', '0071', '--confirm-to', '0080'], POOLER(REF));
check('7a --confirm-from differing from --from → CONFIRM', aborted(r, 'CONFIRM'), r.out);
r = run(prod(REF, ['--migrations-dir', 'supabase/target-migrations']), POOLER(REF));
check('--migrations-dir refused with --production', aborted(r, 'USAGE'), r.out);
r = run([...prod(REF).map((x) => (x === '0072' ? '0000' : x))], POOLER(REF));
check('--from 0000 refused with --production', aborted(r, 'USAGE') || aborted(r, 'CONFIRM'), r.out);

// files / range
r = run(['--from', '0072', '--to', '0076', '--client', 'no-such-container'], LOCAL);
check('8 a local migration beyond --to (0077 with --to 0076) → FILES before connecting', aborted(r, 'FILES') && /beyond --to 0076/.test(r.out), r.out);
r = run(['--from', '0072', '--to', '0099', '--client', 'no-such-container'], LOCAL);
check('--to that is not a local file → FILES', aborted(r, 'FILES'), r.out);
r = run(['--from', '0072', '--to', '0077', '--client', 'no-such-container', '--deployment-check'], LOCAL);
check('--deployment-check without a profile → USAGE', aborted(r, 'USAGE'), r.out);
r = run(['--from', '0072', '--to', '0077', '--client', 'no-such-container', '--verify-profile', 'NOPE'], LOCAL);
check('unknown verify profile → USAGE', aborted(r, 'USAGE'), r.out);

// a fully confirmed production invocation (the newest range, --to = the last local migration) reaches the connection step only
// (here: a missing container), and never prints the password
r = run(prod(REF), POOLER(REF));
check('fully confirmed production args pass every pre-connection guard (stops at the client container)', r.code === 2 && /\[(DOCKER|CONNECT)\]/.test(r.out), r.out);
check('no output ever contains the password', [run(prod(REF), POOLER(REF)), run(prod(REF), POOLER(OTHER)), run(base, LOCAL)].every(noSecret));

console.log(`\n  ══ APPLY-INCREMENTAL OFFLINE RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
