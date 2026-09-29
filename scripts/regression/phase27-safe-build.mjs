#!/usr/bin/env node
/**
 * Phase 27 — production build in a SAFE local environment, then a secret scan of the output.
 *
 *   node scripts/regression/phase27-safe-build.mjs
 *
 * - The repository's .env* files are never loaded: Vite's `envDir` points at an empty temporary directory.
 * - The only injected variables are the local stack URL and the local stack's public anon key (a local demo
 *   JWT: iss supabase-demo, role anon), read from the running local edge-runtime container.
 * - The bundle is written to a temporary directory, scanned, and deleted.
 * The dist scan fails on: the S-1 compromised literal (SHA-256 fingerprint), bearer / token / secret literals,
 * legacy Netlify MP sync paths, service-role keys or references, and any JWT other than the public anon key.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const S1_SHA256 = 'a62bb4f5d452973c5a2ef0be6cd7d86b6d72c0d9e70947dcf229a5dae314498c';

function localAnonKey() {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_edge_runtime', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  if (!c) throw new Error('local stack not running (edge-runtime container)');
  const env = (spawnSync('docker', ['inspect', c, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/);
  const key = (env.find((l) => l.startsWith('SUPABASE_ANON_KEY=')) ?? '').slice('SUPABASE_ANON_KEY='.length);
  const p = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString() || '{}');
  if (p.iss !== 'supabase-demo' || p.role !== 'anon') throw new Error('not the local demo anon key');
  return key;
}

const emptyEnvDir = mkdtempSync(join(tmpdir(), 'p27-noenv-'));
const outDir = mkdtempSync(join(tmpdir(), 'p27-dist-'));
let ok = true;
try {
  process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.VITE_SUPABASE_ANON_KEY = localAnonKey();
  const { build } = await import('vite');
  await build({ root: REPO, configFile: join(REPO, 'vite.config.ts'), envDir: emptyEnvDir, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = walk(outDir).filter((f) => /\.(js|html|css|json|webmanifest|map)$/.test(f));
  const findings = [];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    const rel = f.slice(outDir.length + 1);
    for (const m of t.matchAll(/(['"`])([^'"`\s]{20,80})\1/g)) if (createHash('sha256').update(m[2]).digest('hex') === S1_SHA256) findings.push(`${rel}: S-1 literal`);
    if (/sync-mercadopago|sync-settlement|\.netlify\/functions/.test(t)) findings.push(`${rel}: legacy Netlify MP sync path`);
    if (/SERVICE_ROLE|service_role/.test(t)) findings.push(`${rel}: service-role reference`);
    if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(t)) findings.push(`${rel}: Supabase secret key`);
    if (/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/.test(t)) findings.push(`${rel}: bearer literal`);
    for (const m of t.matchAll(/\b([A-Za-z_]*(?:token|secret|password|api_?key|bearer)[A-Za-z_]*)\s*[:=]\s*(['"`])([^'"`\s$]{16,})\2/gi)) findings.push(`${rel}: secret literal assigned to ${m[1]}`);
    for (const m of t.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
      let role = '?';
      try { role = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString()).role ?? '?'; } catch { /* unreadable */ }
      if (role !== 'anon') findings.push(`${rel}: JWT with role ${role}`);
    }
  }
  console.log(`  build OK: ${files.length} output files scanned`);
  if (findings.length) { ok = false; console.log(`  DIST SCAN FAIL:\n   - ${[...new Set(findings)].join('\n   - ')}`); } else console.log('  DIST SCAN: 0 findings (the public local anon key is the only JWT)');
} catch (err) {
  ok = false;
  console.log(`  BUILD FAILED: ${String(err?.message ?? err).split('\n').slice(0, 6).join(' | ')}`);
} finally {
  rmSync(emptyEnvDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
