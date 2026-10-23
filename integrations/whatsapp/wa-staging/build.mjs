// ADR-025 — generator: ONE template (src/wa-core.template.sql) → two builds that differ only in search_path.
//   build/staging/    AppGranja bot staging: guard + sim doubles + wa core (sim-first path) + seed + tests + teardown
//   build/candidate/  ERP candidate migration (real RPCs, wa.config absent ⇒ every wa_* refuses) + local fixtures + tests
// The candidate migration is refused if it mentions the sim schema anywhere.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
const between = (text, a, b) => { const s = text.indexOf(a), e = text.indexOf(b); if (s < 0 || e < s) throw new Error('marker ' + a); return text.slice(s, e + b.length) + '\n'; };
const tests = src('tests.template.sql');

const files = {
  'staging/00-guard.sql': src('guard-staging.sql'),
  'staging/01-sim.sql': src('sim.staging-only.sql'),
  'staging/02-wa-core.sql': fill(core, 'staging'),
  'staging/03-seed.sql': src('seed-staging.sql'),
  'staging/tests.sql': fill(tests, 'staging'),
  'staging/teardown.sql': src('teardown-staging.sql'),
  // upgrades of the ALREADY INSTALLED AppGranja staging (each one transaction; idempotency by the guard / ON CONFLICT)
  'staging/upgrade-001-wa-context.sql': src('guard-upgrade-staging.sql') + `SET LOCAL search_path = ${PATHS.staging};\n`
    + 'DROP FUNCTION IF EXISTS public.wa_context(bigint);\n' + between(fill(core, 'staging'), '-- >>> wa_context', '-- <<< wa_context')
    + `ALTER FUNCTION public.wa_context(bigint) OWNER TO postgres;\nREVOKE ALL ON FUNCTION public.wa_context(bigint) FROM PUBLIC, anon, authenticated, service_role;\n`
    + `GRANT EXECUTE ON FUNCTION public.wa_context(bigint) TO authenticated;\n`,
  'staging/upgrade-002-sim-categories.sql': src('guard-upgrade-staging.sql') + src('sim-categories.sql'),
  // duplicate references (same criterion as wa.duplicate_hint; details only for an active mapped ADMIN viewer) in propose / correct
  'staging/upgrade-003-duplicate-refs.sql': src('guard-upgrade-staging.sql') + `SET LOCAL search_path = ${PATHS.staging};\n`
    + 'DROP FUNCTION IF EXISTS wa.duplicate_refs(jsonb, uuid);\n' + between(fill(core, 'staging'), '-- >>> duplicate_refs', '-- <<< duplicate_refs')
    + 'ALTER FUNCTION wa.duplicate_refs(jsonb, uuid) OWNER TO postgres;\nREVOKE ALL ON FUNCTION wa.duplicate_refs(jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;\n'
    + ['wa_propose', 'wa_correct'].map((f) => between(fill(core, 'staging'), `-- >>> ${f}`, `-- <<< ${f}`).replace(`CREATE FUNCTION public.${f}(`, `CREATE OR REPLACE FUNCTION public.${f}(`)).join('')
    + ['public.wa_propose(bigint, text, jsonb)', 'public.wa_correct(bigint, uuid, integer, jsonb)'].map((s) => `ALTER FUNCTION ${s} OWNER TO postgres;\n`
      + `REVOKE ALL ON FUNCTION ${s} FROM PUBLIC, anon, authenticated, service_role;\nGRANT EXECUTE ON FUNCTION ${s} TO authenticated;\n`).join(''),
  // live ERP catalog with hierarchy (one selectability rule) + re-check of the subcategory inside the confirmation transaction
  'staging/upgrade-004-catalog-rule.sql': src('guard-upgrade-staging.sql') + `SET LOCAL search_path = ${PATHS.staging};\n`
    + 'DROP FUNCTION IF EXISTS wa.selectable_categories();\nDROP FUNCTION IF EXISTS wa.category_check(uuid, boolean);\n'
    + between(fill(core, 'staging'), '-- >>> category_rule', '-- <<< category_rule')
    + [['validate_payload', 'wa.validate_payload'], ['wa_confirm', 'public.wa_confirm'], ['wa_context', 'public.wa_context']]
      .map(([m, f]) => between(fill(core, 'staging'), `-- >>> ${m}`, `-- <<< ${m}`).replace(`CREATE FUNCTION ${f}(`, `CREATE OR REPLACE FUNCTION ${f}(`)).join('')
    + ['wa.selectable_categories()', 'wa.category_check(uuid, boolean)', 'wa.validate_payload(text, jsonb)'].map((s) => `ALTER FUNCTION ${s} OWNER TO postgres;\n`
      + `REVOKE ALL ON FUNCTION ${s} FROM PUBLIC, anon, authenticated, service_role;\n`).join('')
    + ['public.wa_confirm(bigint, uuid, integer)', 'public.wa_context(bigint)'].map((s) => `ALTER FUNCTION ${s} OWNER TO postgres;\n`
      + `REVOKE ALL ON FUNCTION ${s} FROM PUBLIC, anon, authenticated, service_role;\nGRANT EXECUTE ON FUNCTION ${s} TO authenticated;\n`).join(''),
  'candidate/0101_wa_whatsapp_gateway.candidate.sql':
    '-- ADR-025 CANDIDATE migration (NOT in supabase/target-migrations; never applied without an owner GO).\n'
    + '-- Generated from src/wa-core.template.sql with search_path = public, pg_temp (real accounting RPCs). wa.config is NOT\n'
    + '-- seeded: until the owner inserts the gateway user and sets enabled = true, every public.wa_* call is refused.\n'
    + src('guard-candidate.sql') + '\n' + fill(core, 'candidate'),
  'candidate/fixtures.sql': src('fixtures-candidate.sql'),
  'candidate/tests.sql': fill(tests, 'candidate'),
};

// mechanical checks
const cand = files['candidate/0101_wa_whatsapp_gateway.candidate.sql'];
if (/\bsim\b/i.test(cand.replace(/to_regnamespace\('sim'\)|schema sim exists \(staging-only object in an ERP database\)/g, ''))) {
  throw new Error('candidate migration references the sim schema');
}
if (!cand.includes("SET LOCAL search_path = public, pg_temp;")) throw new Error('candidate search_path');
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
console.log(sums.join('\n'));
console.log('build: OK (candidate has no sim reference; staging and candidate cores differ only in search_path)');
