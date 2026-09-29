#!/usr/bin/env node
/**
 * Phase 27 — static frontend gate (scans src/). Reusable in every slice; read-only.
 *
 *   node scripts/regression/phase27-frontend-static.check.mjs            # check
 *   node scripts/regression/phase27-frontend-static.check.mjs --write-baseline [--allow-grow]
 *
 * Authority: PHASE_27_FRONTEND_INTEGRATION_PLAN.md §8 (static gate), §9 (DONE).
 *
 * The target surface lists live in src/target/db.ts (single source of truth). When the local stack is up
 * they are also verified against the live catalog (views exist; RPCs = the SECURITY DEFINER functions
 * executable by `authenticated`; direct writes = the `authenticated` INSERT / UPDATE / DELETE grants).
 *
 * Legacy code still owned by later slices (F27-B…F27-H) is described by a per-file baseline
 * (phase27-legacy-baseline.json) that may only SHRINK: a reference that is not in its file's entry
 * fails, and an entry that no longer occurs also fails (the baseline must be tightened). The baseline is
 * empty at F27-I. Zero-tolerance findings are never baselined:
 *   legacy Netlify MP sync paths; api.ipify; secrets in localStorage / sessionStorage; hard-coded
 *   token / secret / password / key / bearer literals (lower-case assignments included); service-role keys
 *   or references; complete JWTs other than a public anon key; the S-1 compromised literal
 *   (matched by its SHA-256 fingerprint, the value itself is never stored); VITE_ variables other than
 *   the Supabase URL / anon key.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const SRC = join(REPO, 'src');
const BASELINE_FILE = join(REPO, 'scripts', 'regression', 'phase27-legacy-baseline.json');
const DB_TS = readFileSync(join(SRC, 'target', 'db.ts'), 'utf8');
// S-1 (compromised legacy Netlify bearer, removed in F27-A): SHA-256 of the literal; the value is never stored.
const S1_SHA256 = 'a62bb4f5d452973c5a2ef0be6cd7d86b6d72c0d9e70947dcf229a5dae314498c';

const list = (name) => {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(DB_TS);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
};
const VIEWS = list('TARGET_VIEWS');
const READ_TABLES = list('TARGET_READ_TABLES');
const RPCS = list('TARGET_RPCS');
const WRITES = Object.fromEntries([...(/export const DIRECT_WRITES = \{([\s\S]*?)\} as const/.exec(DB_TS)[1])
  .matchAll(/([a-z_]+): \[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/'([a-z]+)'/g)].map((x) => x[1])]));
const TARGET_NAMES = new Set([...VIEWS, ...READ_TABLES, ...Object.keys(WRITES)]);
// legacy-only relation names (the shared names pedidos / pedido_lineas / perfiles are governed by the per-file baseline)
const LEGACY_ONLY = ['clientes', 'pagos', 'pago_en_caja', 'movimientos_caja', 'cheques', 'comisiones', 'facturas', 'arqueos_caja', 'cuentas_caja',
  'categorias_finanzas', 'lotes', 'producciones', 'recuentos_lote', 'precios_actuales', 'precios_historial', 'productos', 'ledger_entry',
  'account_balance', 'mercadopago_raw', 'mp_financial_movement'];
const LEGACY_RPCS = ['marcar_pedido_entregado'];

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label} :: ${detail}`); }
}
function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}
const files = walk(SRC).filter((f) => /\.(ts|tsx|js|jsx|mjs|html)$/.test(f));

// ── per-file findings ────────────────────────────────────────────────────────
function scan(text) {
  const refs = new Set();      // baseline-able legacy usage
  const strict = [];           // violations for code outside the baseline
  const zero = [];             // zero-tolerance
  for (const m of text.matchAll(/\.from\(\s*(['"`])([a-z_]+)\1\s*\)/g)) {
    const t = m[2];
    const seg = text.slice(m.index, m.index + 700).split(/\.from\(|;\s*\n/)[1] ?? '';
    const ops = [...seg.matchAll(/\.(insert|update|delete|upsert)\(/g)].map((x) => x[1]);
    refs.add(`from:${t}`);
    for (const op of ops) refs.add(`write:${t}:${op}`);
    if (!TARGET_NAMES.has(t)) strict.push(`relation ${t} is not a target view / readable table`);
    for (const op of ops) if (!(WRITES[t] ?? []).includes(op)) strict.push(`${op} on ${t} is not an authorized direct write`);
  }
  for (const m of text.matchAll(/(['"`])([a-z_]+)\1/g)) if (LEGACY_ONLY.includes(m[2])) refs.add(`name:${m[2]}`);
  for (const m of text.matchAll(/\.rpc\(\s*(['"`])([a-z_]+)\1/g)) {
    refs.add(`rpc:${m[2]}`);
    if (!RPCS.includes(m[2])) strict.push(`rpc ${m[2]} is not an authorized target RPC`);
  }
  for (const m of text.matchAll(/(?:callRpc|readView|readTable|writeTable)\(\s*[a-zA-Z_.]+\s*,\s*(['"`])([a-z_]+)\1/g)) {
    if (!TARGET_NAMES.has(m[2]) && !RPCS.includes(m[2])) strict.push(`target helper names unknown ${m[2]}`);
  }
  for (const n of [...LEGACY_ONLY]) if (refs.has(`name:${n}`) || refs.has(`from:${n}`)) strict.push(`legacy relation ${n}`);
  for (const r of LEGACY_RPCS) if (refs.has(`rpc:${r}`)) strict.push(`legacy rpc ${r}`);
  // zero tolerance
  if (/sync-mercadopago|sync-settlement|\.netlify\/functions|netlify\.app/i.test(text)) zero.push('legacy Netlify MP sync path');
  if (/ipify/i.test(text)) zero.push('api.ipify call');
  if (/(localStorage|sessionStorage)\s*\.\s*(getItem|setItem)\(\s*['"`][^'"`]*(secret|token|key|password|bearer|auth)/i.test(text)) zero.push('secret in browser storage');
  for (const m of text.matchAll(/\b([A-Za-z_]*(?:token|secret|password|passwd|api_?key|apikey|bearer|auth_?key|credential)[A-Za-z_]*)\s*[:=]\s*(['"`])([^'"`\s$]{16,})\2/gi)) {
    zero.push(`hard-coded secret literal assigned to ${m[1]}`);
  }
  for (const m of text.matchAll(/Bearer\s+([A-Za-z0-9._~+/=-]{16,})/g)) if (!m[1].startsWith('${')) zero.push('hard-coded bearer literal');
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
    let role = '?';
    try { role = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString()).role ?? '?'; } catch { /* unreadable */ }
    if (role !== 'anon') zero.push(`JWT literal with role ${role}`);
  }
  if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) zero.push('Supabase secret key literal');
  if (/SERVICE_ROLE|service_role/.test(text)) zero.push('service-role reference in frontend');
  for (const m of text.matchAll(/import\.meta\.env\.([A-Z_]+)/g)) if (!['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'DEV', 'PROD', 'MODE', 'BASE_URL'].includes(m[1])) zero.push(`env variable ${m[1]}`);
  for (const m of text.matchAll(/(['"`])([^'"`\s]{20,80})\1/g)) if (createHash('sha256').update(m[2]).digest('hex') === S1_SHA256) zero.push('S-1 compromised literal');
  return { refs: [...refs].sort(), strict: [...new Set(strict)].sort(), zero: [...new Set(zero)].sort() };
}

const results = Object.fromEntries(files.map((f) => [relative(REPO, f).replace(/\\/g, '/'), scan(readFileSync(f, 'utf8'))]));

if (process.argv.includes('--write-baseline')) {
  const prev = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).files : {};
  const next = {};
  for (const [f, r] of Object.entries(results)) {
    if (r.zero.length) { console.error(`refusing: zero-tolerance finding in ${f}: ${r.zero.join(', ')}`); process.exit(1); }
    if (r.strict.length) next[f] = r.refs;
  }
  const grown = Object.entries(next).flatMap(([f, refs]) => refs.filter((x) => !(prev[f] ?? []).includes(x)).map((x) => `${f} ${x}`));
  if (grown.length && !process.argv.includes('--allow-grow')) { console.error(`refusing to grow the baseline:\n${grown.join('\n')}`); process.exit(1); }
  writeFileSync(BASELINE_FILE, `${JSON.stringify({
    note: 'Phase 27 remaining legacy baseline (per file). May only shrink; empty at F27-I. Zero-tolerance findings are never listed here.',
    files: next }, null, 2)}\n`);
  console.log(`baseline written: ${Object.keys(next).length} files, ${Object.values(next).reduce((n, r) => n + r.length, 0)} references`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).files;
console.log('\n  ── Phase 27 static gate ────────────────────────────────────────');
const zero = Object.entries(results).flatMap(([f, r]) => r.zero.map((z) => `${f}: ${z}`));
check('Z-1 zero-tolerance: no legacy Netlify MP sync path, no ipify, no secret in browser storage, no hard-coded token / secret / bearer literal (lower-case assignments included), no service-role key or reference, no non-anon JWT, no S-1 literal (fingerprint), no unexpected VITE_ variable',
  zero.length === 0, zero.join(' | '));
const unexpected = [];
for (const [f, r] of Object.entries(results)) {
  if (!baseline[f]) { for (const s of r.strict) unexpected.push(`${f}: ${s}`); continue; }
  for (const ref of r.refs) if (!baseline[f].includes(ref)) unexpected.push(`${f}: new reference ${ref} (not in its baseline)`);
}
check('B-1 no new legacy reference: code outside the baseline uses only target views / tables / RPCs and authorized direct writes; baselined files add nothing', unexpected.length === 0, unexpected.join(' | '));
const stale = Object.entries(baseline).flatMap(([f, refs]) => refs.filter((x) => !(results[f]?.refs ?? []).includes(x)).map((x) => `${f}: ${x}`));
check('B-2 the baseline has no stale entry (a removed reference must be removed from the baseline: it only shrinks)', stale.length === 0, stale.join(' | '));
const S1_SHA_OK = !Object.values(results).some((r) => r.zero.includes('S-1 compromised literal'));
check('S-1 the compromised literal occurs nowhere in src/ (SHA-256 fingerprint scan of every quoted string)', S1_SHA_OK);

// live catalog verification of src/target/db.ts (only when the local stack is up)
const docker = spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' });
const container = (docker.stdout || '').trim().split('\n').filter(Boolean)[0];
if (container) {
  const q = (s) => (spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-f', '-'], { encoding: 'utf8', input: s }).stdout || '').trim();
  const rpcs = q(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE');`).split(',');
  check('C-1 TARGET_RPCS = exactly the SECURITY DEFINER functions executable by authenticated (live catalog)', JSON.stringify([...RPCS].sort()) === JSON.stringify(rpcs),
    `extra ${RPCS.filter((r) => !rpcs.includes(r))} missing ${rpcs.filter((r) => !RPCS.includes(r))}`);
  const views = q(`SELECT string_agg(viewname, ',' ORDER BY viewname) FROM pg_views WHERE schemaname = 'public';`).split(',');
  check('C-2 every TARGET_VIEWS entry is a live view', VIEWS.every((v) => views.includes(v)), VIEWS.filter((v) => !views.includes(v)).join());
  const sel = q(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.role_table_grants WHERE grantee = 'authenticated' AND table_schema = 'public' AND privilege_type = 'SELECT';`).split(',');
  check('C-3 every TARGET_READ_TABLES entry exists and is SELECT-granted to authenticated', READ_TABLES.every((t) => sel.includes(t)), READ_TABLES.filter((t) => !sel.includes(t)).join());
  const w = q(`SELECT string_agg(table_name || ':' || lower(privilege_type), ',' ORDER BY table_name, privilege_type) FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated' AND table_schema = 'public' AND privilege_type IN ('INSERT','UPDATE','DELETE');`).split(',');
  const mine = Object.entries(WRITES).flatMap(([t, ops]) => ops.map((o) => `${t}:${o}`)).sort();
  check('C-4 DIRECT_WRITES = exactly the INSERT / UPDATE / DELETE grants of authenticated (live catalog)', JSON.stringify(mine) === JSON.stringify(w),
    `extra ${mine.filter((x) => !w.includes(x))} missing ${w.filter((x) => !mine.includes(x))}`);
} else {
  console.log('      (local stack not running: live catalog verification skipped)');
}

const remaining = Object.values(baseline).reduce((n, r) => n + r.length, 0);
console.log(`\n      remaining legacy baseline: ${Object.keys(baseline).length} files, ${remaining} references (must reach 0 at F27-I)`);
console.log(`\n  ══ PHASE 27 STATIC GATE RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
