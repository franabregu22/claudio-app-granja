// ADR-025 — generator: ONE template (src/wa-core.template.sql) → two builds that differ only in search_path.
//   build/staging/    AppGranja bot staging: guard + sim doubles + wa core (sim-first path) + seed + tests + teardown
//   build/candidate/  ERP candidate migration (real RPCs, wa.config absent ⇒ every wa_* refuses) + local fixtures + tests
// The candidate migration is refused if it mentions the sim schema anywhere.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, 'src', f), 'utf8').replace(/\r\n/g, '\n');
const PATHS = { staging: 'sim, public, pg_temp', candidate: 'public, pg_temp' };
const fill = (text, variant) => {
  const out = text.replaceAll('__PATH__', PATHS[variant]);
  if (out.includes('__')) {
    const left = out.match(/__[A-Z]+__/);
    if (left) throw new Error(`unreplaced placeholder ${left[0]} (${variant})`);
  }
  return out;
};
const core = src('wa-core.template.sql');
// the promoted ERP migration: generated here, written ONCE to supabase/target-migrations; never rewritten afterwards
const PROD_REL = 'production/0102_wa_whatsapp_gateway.sql';
const PROD_TARGET = join(HERE, '..', '..', '..', 'supabase', 'target-migrations', '0102_wa_whatsapp_gateway.sql');
const between = (text, a, b) => { const s = text.indexOf(a), e = text.indexOf(b); if (s < 0 || e < s) throw new Error('marker ' + a); return text.slice(s, e + b.length) + '\n'; };
const tests = src('tests.template.sql');
const frozen = (f, sha) => {
  const t = readFileSync(join(HERE, 'src', 'applied', f), 'utf8');
  if (createHash('sha256').update(t).digest('hex') !== sha) throw new Error(`frozen applied upgrade ${f} differs from its reviewed hash`);
  return t;
};

const files = {
  'staging/00-guard.sql': src('guard-staging.sql'),
  'staging/01-sim.sql': src('sim.staging-only.sql') + src('sim-unclassified.sql'),
  'staging/02-wa-core.sql': fill(core, 'staging'),
  'staging/03-seed.sql': src('seed-staging.sql'),
  'staging/tests.sql': fill(tests, 'staging'),
  'staging/teardown.sql': src('teardown-staging.sql'),
  // upgrades ALREADY APPLIED on AppGranja: frozen byte for byte (src/applied/, copied from the reviewed commit 0a54bdc) — a later
  // change of the core must never alter an artifact that is installed; each one is checked against its reviewed SHA-256
  'staging/upgrade-001-wa-context.sql': frozen('upgrade-001-wa-context.sql', 'd0d36a4bb6141947cbdc371166fabd37740ca0aedbf71e5de639897ae4c64da1'),
  'staging/upgrade-002-sim-categories.sql': src('guard-upgrade-staging.sql') + src('sim-categories.sql'),
  'staging/upgrade-003-duplicate-refs.sql': frozen('upgrade-003-duplicate-refs.sql', 'e342f7556bff9d364a6258dd93f5961db7fc8e82a3445fb12c03b0a0efa9bde0'),
  // live ERP catalog (D-1), paying accounts (D-3), "Registrar sin clasif", fin_mp_whatsapp_notes — applied 2026-10-23 (rollback file kept)
  'staging/upgrade-004-catalog-rule.sql': frozen('upgrade-004-catalog-rule.sql', 'eceab9af020c83287ed4d57d758e74606e0683de718a05bcc8394ef8fca6e44d'),
  // payment method NEVER presumed (owner, 2026-10-24): method pending in the draft, WA_METHOD_REQUIRED in the confirmation, the
  // METHOD:<draft>:<version>:<method> button only drives that correction. Additive: the published V2 always sends a method.
  'staging/upgrade-005-method-pending.sql': src('guard-upgrade-staging.sql')
    + "DO $$ BEGIN IF to_regprocedure('wa.selectable_categories()') IS NULL THEN RAISE EXCEPTION 'UPGRADE_005_GUARD: upgrade-004 is not installed'; END IF; END $$;\n"
    + `SET LOCAL search_path = ${PATHS.staging};\n`
    + [['validate_payload', 'wa.validate_payload'], ['wa_correct', 'public.wa_correct'], ['wa_confirm', 'public.wa_confirm']]
      .map(([m, f]) => between(fill(core, 'staging'), `-- >>> ${m}`, `-- <<< ${m}`).replace(`CREATE FUNCTION ${f}(`, `CREATE OR REPLACE FUNCTION ${f}(`)).join('')
      // the wa_confirm block also carries wa.dispatch_unclassified (unchanged since upgrade-004): replaced in place, privileges kept
      .replace('CREATE FUNCTION wa.dispatch_unclassified(', 'CREATE OR REPLACE FUNCTION wa.dispatch_unclassified(')
    + 'ALTER FUNCTION wa.validate_payload(text, jsonb) OWNER TO postgres;\nREVOKE ALL ON FUNCTION wa.validate_payload(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;\n'
    + ['public.wa_correct(bigint, uuid, integer, jsonb)', 'public.wa_confirm(bigint, uuid, integer)'].map((s) => `ALTER FUNCTION ${s} OWNER TO postgres;\n`
      + `REVOKE ALL ON FUNCTION ${s} FROM PUBLIC, anon, authenticated, service_role;\nGRANT EXECUTE ON FUNCTION ${s} TO authenticated;\n`).join(''),
  // the ERP migration of the WhatsApp gateway, promoted as supabase/target-migrations/0102_wa_whatsapp_gateway.sql
  [PROD_REL]:
    '-- TARGET V1 — 0102 WHATSAPP EXPENSE GATEWAY (ADR-025). Generated by integrations/whatsapp/wa-staging/build.mjs from\n'
    + '-- src/wa-core.template.sql with search_path = public, pg_temp (the real accounting RPCs). wa.config is NOT seeded: until the\n'
    + '-- owner inserts the gateway user and sets enabled = true, every public.wa_* call is refused (the bot is OFF after this migration).\n'
    + '-- DEPENDS ON 0101_unclassified_expenses (wa.dispatch_unclassified calls register_unclassified_expense): checked by the guard.\n'
    + src('guard-candidate.sql') + '\n' + fill(core, 'candidate'),
  'candidate/fixtures.sql': src('fixtures-candidate.sql'),
  'candidate/tests.sql': fill(tests, 'candidate'),
};

// mechanical checks
const cand = files[PROD_REL];
if (/\bsim\b/i.test(cand.replace(/to_regnamespace\('sim'\)|schema sim exists \(staging-only object in an ERP database\)/g, ''))) {
  throw new Error('ERP migration references the sim schema');
}
if (/aplbsutpzgemexayldct|shdrztqgwpyyxclgfpdg|AppGranja/i.test(cand)) throw new Error('ERP migration references the staging / Farm ERP project');
if (!cand.includes("SET LOCAL search_path = public, pg_temp;")) throw new Error('ERP migration search_path');
// once promoted, 0102 is immutable (its sha256 becomes a production ledger row): a different core needs a NEW migration
if (existsSync(PROD_TARGET) && readFileSync(PROD_TARGET, 'utf8') !== cand) {
  throw new Error('supabase/target-migrations/0102_wa_whatsapp_gateway.sql is already promoted and differs from this build: write a new migration');
}
if (!files['staging/02-wa-core.sql'].includes('SET search_path = sim, public, pg_temp')) throw new Error('staging search_path');
const strip = (t, v) => t.replaceAll(PATHS[v], '<PATH>');
if (strip(files['staging/02-wa-core.sql'], 'staging') !== strip(fill(core, 'candidate'), 'candidate')) throw new Error('builds differ beyond search_path');

rmSync(join(HERE, 'build'), { recursive: true, force: true });
const sums = [];
for (const [rel, text] of Object.entries(files)) {
  const p = join(HERE, 'build', rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  sums.push(`${createHash('sha256').update(text).digest('hex')}  ${rel}`);
}
writeFileSync(join(HERE, 'build', 'SHA256SUMS'), sums.join('\n') + '\n');
if (!existsSync(PROD_TARGET)) { writeFileSync(PROD_TARGET, cand); console.log('promoted: supabase/target-migrations/0102_wa_whatsapp_gateway.sql'); }
console.log(sums.join('\n'));
console.log('build: OK (ERP migration 0102 has no sim / staging reference; staging and ERP cores differ only in search_path)');
