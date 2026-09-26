#!/usr/bin/env node
/**
 * Executable proof that the destructive-operation guard is fail-closed.
 *
 * Run:  node scripts/test-env/guard.test.mjs
 * Exit: 0 only if every case behaves as specified.
 *
 * This is Phase 12 evidence, not a unit-test suite for the app. It exercises the
 * two guard layers independently, because the link check short-circuits the URL
 * check at runtime and would otherwise mask it.
 */

import {
  assertTestTarget,
  assertNoProductionCredentials,
  assertNoActiveRemoteLink,
  assertLocalOnlyCliArgs,
  hasActiveRemoteLink,
} from './guard.mjs';

let pass = 0;
let fail = 0;

function check(label, expected, fn) {
  let actual;
  let reason = '';
  try {
    const result = fn();
    actual = 'ALLOW';
    reason = result?.redacted ?? 'ok';
  } catch (err) {
    actual = 'REFUSE';
    reason = (err.message.match(/│ ([A-Z][^│\n]*)/) || [, ''])[1].trim();
  }
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(
    `  ${ok ? 'OK  ' : 'MAL '} ${actual.padEnd(6)} expected=${expected.padEnd(6)} ${label.padEnd(42)} :: ${reason}`
  );
}

console.log('\n── Layer 1: target URL validation ──────────────────────────────');

const urlCases = [
  ['postgresql://postgres:x@127.0.0.1:54322/postgres', 'local supabase (legitimate)', 'ALLOW'],
  ['postgresql://postgres:x@localhost:54322/postgres', 'localhost:54322', 'ALLOW'],
  ['postgres://postgres:x@[::1]:54322/postgres', 'loopback IPv6', 'ALLOW'],
  ['postgresql://u:p@examplerefonly.supabase.co:5432/postgres', 'CLOUD production-shaped', 'REFUSE'],
  ['postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres', 'CLOUD db.* host', 'REFUSE'],
  ['postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres', 'CLOUD pooler', 'REFUSE'],
  ['postgresql://postgres:x@127.0.0.1:5432/postgres', 'loopback port 5432 (tunnel risk)', 'REFUSE'],
  ['postgresql://postgres:x@192.168.1.50:54322/postgres', 'LAN host', 'REFUSE'],
  ['postgresql://postgres:x@127.0.0.1:54322/produccion', 'disallowed db name', 'REFUSE'],
  ['postgresql://postgres:x@127.0.0.1/postgres', 'no explicit port', 'REFUSE'],
  ['mysql://postgres:x@127.0.0.1:54322/postgres', 'non-postgres protocol', 'REFUSE'],
  ['no-es-una-url', 'unparseable string', 'REFUSE'],
  ['', 'empty (no default fallback)', 'REFUSE'],
  [undefined, 'undefined', 'REFUSE'],
];

for (const [url, label, expected] of urlCases) {
  check(label, expected, () => assertTestTarget(url));
}

console.log('\n── Layer 2: production credential detection ────────────────────');

check('clean environment', 'ALLOW', () => {
  assertNoProductionCredentials({});
  return { redacted: 'no production credentials' };
});

for (const v of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD']) {
  check(`${v} present`, 'REFUSE', () => assertNoProductionCredentials({ [v]: 'dummy-value' }));
  check(`${v} empty string`, 'ALLOW', () => {
    assertNoProductionCredentials({ [v]: '' });
    return { redacted: 'blank treated as absent' };
  });
}

console.log('\n── Layer 3: CLI argv locality (what actually selects remote) ───');

const cliCases = [
  [['db', 'reset'], 'db reset (local by default)', 'ALLOW'],
  [['db', 'reset', '--debug'], 'db reset with a harmless flag', 'ALLOW'],
  [['db', 'reset', '--linked'], 'db reset --linked', 'REFUSE'],
  [['db', 'reset', '--db-url', 'postgresql://x'], 'db reset --db-url', 'REFUSE'],
  [['db', 'reset', '--db-url=postgresql://x'], 'db reset --db-url= form', 'REFUSE'],
  [['db', 'push'], 'db push', 'REFUSE'],
  [['db', 'pull'], 'db pull', 'REFUSE'],
  [['link', '--project-ref', 'abc'], 'link', 'REFUSE'],
  [['db', 'reset', '--project-ref', 'abc'], 'db reset --project-ref', 'REFUSE'],
  [['db', 'reset', '--PROJECT-REF', 'abc'], 'uppercase selector still caught', 'REFUSE'],
];

for (const [args, label, expected] of cliCases) {
  check(label, expected, () => {
    assertLocalOnlyCliArgs(args);
    return { redacted: `supabase ${args.join(' ')}` };
  });
}

check('argv not an array', 'REFUSE', () => assertLocalOnlyCliArgs('db reset'));

console.log('\n── Layer 4: remote link detection (still available) ────────────');

check('link presence is reported', 'ALLOW', () => ({
  redacted: `hasActiveRemoteLink() = ${hasActiveRemoteLink()}`,
}));
check('strict link assertion still refuses while linked', 'REFUSE', () => assertNoActiveRemoteLink());

console.log('\n── Secret leakage ─────────────────────────────────────────────');

const CANARY_PASS = 'PASS_CANARY_ZZZ';
let leaked = false;
try {
  assertTestTarget(`postgresql://user:${CANARY_PASS}@evil.example.com:54322/postgres`);
} catch (err) {
  leaked = err.message.includes(CANARY_PASS);
}
if (leaked) {
  fail++;
  console.log('  MAL  the guard echoed a password into its refusal message');
} else {
  pass++;
  console.log('  OK   no credential material appears in refusal output');
}

console.log(`\n  RESULT: ${pass} correct, ${fail} incorrect`);
process.exit(fail === 0 ? 0 : 1);
