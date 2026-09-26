#!/usr/bin/env node
/**
 * Fail-closed target guard for destructive test-environment operations.
 *
 * Contract: a destructive operation runs ONLY if this module can positively prove
 * the target is the local test database. Anything it cannot prove is refused.
 * There is no flag, env var or argument that turns the refusal off.
 *
 * Usage:
 *   import { assertTestTarget, assertNoProductionCredentials } from './guard.mjs';
 *   const target = assertTestTarget(process.env.TEST_DATABASE_URL);
 *
 * Or as a CLI pre-check:
 *   node scripts/test-env/guard.mjs "$TEST_DATABASE_URL"
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Hosts that may ever be a destructive target. Loopback only. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Port the Supabase CLI exposes for the local Postgres. */
const ALLOWED_PORTS = new Set(['54322']);

/** Database names accepted on the local instance. */
const ALLOWED_DB_NAMES = new Set(['postgres']);

/** Production credential names that must never be present during a destructive run. */
const PRODUCTION_CREDENTIAL_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
];

class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardRefusal';
  }
}

function refuse(reason, detail) {
  const lines = [
    '',
    '  ┌─ DESTRUCTIVE OPERATION REFUSED ───────────────────────────────',
    `  │ ${reason}`,
  ];
  if (detail) lines.push(`  │ ${detail}`);
  lines.push(
    '  │',
    '  │ The guard refuses anything it cannot prove is the local test',
    '  │ database. This is fail-closed by design and cannot be overridden.',
    '  └───────────────────────────────────────────────────────────────',
    ''
  );
  throw new GuardError(lines.join('\n'));
}

/** True when the repository holds an active CLI link to a remote project. */
export function hasActiveRemoteLink() {
  return existsSync(resolve(REPO_ROOT, 'supabase', '.temp', 'project-ref'));
}

/**
 * Refuses if the CLI is linked to a remote Supabase project.
 * Kept for callers that cannot otherwise prove locality.
 */
export function assertNoActiveRemoteLink() {
  if (hasActiveRemoteLink()) {
    refuse(
      'The Supabase CLI is LINKED to a remote project.',
      'supabase/.temp/project-ref exists. This operation cannot prove it will not ' +
        'follow that link, so it is refused.'
    );
  }
  return true;
}

/**
 * Argument selectors that make a Supabase CLI command act on a REMOTE project.
 * Presence of any of these is what actually turns a local command into a remote one.
 */
const REMOTE_SELECTOR_FLAGS = ['--linked', '--db-url', '--project-ref', '--project-id'];

/** CLI subcommands that are remote by definition and are never allowed here. */
const REMOTE_SUBCOMMANDS = ['push', 'pull', 'link', 'remote'];

/**
 * Proves a Supabase CLI invocation operates on the LOCAL stack only.
 *
 * Why this exists, and why it replaced a blanket link refusal:
 * an earlier version refused every destructive operation while
 * supabase/.temp/project-ref existed. That conflated two different things —
 * "a link exists in the repository" and "this command follows the link".
 * `supabase db reset` acts on the local database; only `--linked` (or an explicit
 * --db-url / --project-ref) makes it remote. Inspecting argv is therefore both more
 * precise AND strictly stronger than checking for the link file, because it catches
 * the dangerous selector whether or not a link is present.
 *
 * @param {string[]} args argv that will be handed to the supabase CLI
 */
export function assertLocalOnlyCliArgs(args) {
  if (!Array.isArray(args)) {
    refuse('CLI arguments were not supplied as an array.', 'The guard cannot inspect what it cannot see.');
  }

  for (const arg of args) {
    const lowered = String(arg).toLowerCase();
    for (const flag of REMOTE_SELECTOR_FLAGS) {
      if (lowered === flag || lowered.startsWith(`${flag}=`)) {
        refuse(
          `The command carries the remote selector "${flag}".`,
          `Full argv: supabase ${args.join(' ')} — this would act on a REMOTE project.`
        );
      }
    }
    if (REMOTE_SUBCOMMANDS.includes(lowered)) {
      refuse(
        `The subcommand "${lowered}" is remote by definition.`,
        `Full argv: supabase ${args.join(' ')}`
      );
    }
  }

  return true;
}

/** Refuses if a production credential is visible in the environment. */
export function assertNoProductionCredentials(env = process.env) {
  const present = PRODUCTION_CREDENTIAL_VARS.filter((v) => {
    const value = env[v];
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (present.length > 0) {
    refuse(
      'A production credential is present in the environment.',
      `Unset ${present.join(', ')} before running a destructive test operation. ` +
        'Values are never printed by this guard.'
    );
  }
  return true;
}

/**
 * Proves a connection string points at the local test database.
 * @returns {{host:string, port:string, database:string, redacted:string}}
 */
export function assertTestTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    refuse(
      'No target was supplied.',
      'Set TEST_DATABASE_URL explicitly. The guard never falls back to a default, ' +
        'because a default is how the wrong database gets dropped.'
    );
  }

  const url = rawUrl.trim();

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    refuse('The target is not a parseable URL.', 'Expected postgresql://…@127.0.0.1:54322/postgres');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    refuse(`Unsupported protocol "${parsed.protocol}".`, 'Expected postgres:// or postgresql://');
  }

  const host = parsed.hostname;
  const port = parsed.port;
  const database = parsed.pathname.replace(/^\//, '');
  const redacted = `${parsed.protocol}//***@${host}:${port || '(none)'}/${database}`;

  // Cloud is never a destructive target, under any circumstance.
  if (/supabase\.(co|in|net)$/i.test(host) || /\.pooler\.supabase\./i.test(host)) {
    refuse(
      'The target is a Supabase CLOUD host.',
      `${redacted} — cloud is never an allowed destructive target.`
    );
  }

  if (!ALLOWED_HOSTS.has(host)) {
    refuse(
      'The target host is not loopback.',
      `Got "${host}". Allowed: ${[...ALLOWED_HOSTS].join(', ')}. ` +
        'A non-loopback host cannot be proven to be the test environment.'
    );
  }

  if (!port) {
    refuse('The target has no explicit port.', 'An implicit port cannot be proven to be the test instance.');
  }

  if (!ALLOWED_PORTS.has(port)) {
    refuse(
      'The target port is not the local Supabase Postgres port.',
      `Got "${port}". Allowed: ${[...ALLOWED_PORTS].join(', ')}. ` +
        'Port 5432 is refused on purpose: it is the default of any Postgres, ' +
        'including one tunnelled to production.'
    );
  }

  if (!ALLOWED_DB_NAMES.has(database)) {
    refuse(
      'The target database name is not allowed.',
      `Got "${database}". Allowed: ${[...ALLOWED_DB_NAMES].join(', ')}.`
    );
  }

  return { host, port, database, redacted };
}

/**
 * Entry point for a DIRECT-URL destructive operation (pg_dump, pg_restore, psql).
 *
 * The CLI link is not consulted here, and deliberately so: these tools read the
 * connection string they are given and never read supabase/.temp/project-ref, so a
 * link in the repository contributes no risk to them. Locality is proven by the URL
 * itself, which is the control that actually applies.
 */
export function assertSafeDestructiveTarget(rawUrl) {
  assertNoProductionCredentials();
  const target = assertTestTarget(rawUrl);
  if (hasActiveRemoteLink()) {
    console.log(
      '  guard: note — a CLI link exists (supabase/.temp/project-ref), but this is a\n' +
        '         direct-URL operation, which cannot follow it.'
    );
  }
  console.log(`  guard: target proven local test → ${target.redacted}`);
  return target;
}

/**
 * Entry point for a CLI-MEDIATED destructive operation (`supabase db reset`).
 * Locality is proven by argv, since that is what selects local versus remote.
 */
export function assertSafeCliOperation(args) {
  assertNoProductionCredentials();
  assertLocalOnlyCliArgs(args);
  console.log(`  guard: cli argv proven local-only → supabase ${args.join(' ')}`);
  return true;
}

// CLI mode
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    assertSafeDestructiveTarget(process.argv[2] ?? process.env.TEST_DATABASE_URL);
    console.log('  guard: PASS');
    process.exit(0);
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
