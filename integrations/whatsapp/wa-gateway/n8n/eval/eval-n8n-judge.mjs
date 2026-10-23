// ADR-025 — judges the answers of the temporary n8n evaluation workflow with the SAME pipeline and criteria as
// eval-models.mjs (preRoute → parseResponse → decide → judge, from eval-lib.mjs).
// usage: node eval-n8n-judge.mjs <execution.json> [--manifest build/eval-n8n.manifest.json]
// <execution.json>: the "Collect" output saved from the execution (n8n MCP get_workflow_execution, or copied from the UI);
// any JSON that contains the object { eval: 'adr025-v2', run, results: [...] } is accepted.
// Every request is rebuilt locally and must match the sha256 recorded at build time (the model answered what we judge).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cases, prepare, finish, score, eligible, fnv } from './eval-lib.mjs';

const file = process.argv[2];
const mi = process.argv.indexOf('--manifest');
const mpath = mi > 0 ? process.argv[mi + 1] : new URL('./build/eval-n8n.manifest.json', import.meta.url);
if (!file) { console.log('usage: node eval-n8n-judge.mjs <execution.json> [--manifest <file>]'); process.exit(2); }
const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
const find = (x) => { if (!x || typeof x !== 'object') return null; if (x.eval === 'adr025-v2' && Array.isArray(x.results)) return x;
  for (const v of Object.values(x)) { const f = find(v); if (f) return f; } return null; };
const raw = readFileSync(file, 'utf8');
const got = find(JSON.parse(raw));
if (!got) { console.log('STOP: no eval results (Collect output) in ' + file); process.exit(2); }
if (got.run !== manifest.run) { console.log(`STOP: results of run ${got.run}, manifest of run ${manifest.run}`); process.exit(2); }
if (/sk-[A-Za-z0-9_-]{20,}/.test(raw)) console.log('WARNING: the execution file contains something shaped like an API key — delete it, do not share it');
const sim = !!got.simulated;
if (manifest.focused) console.log(`FOCUSED run: cases ${manifest.case_ids.join(', ')} — not a full evaluation (no model selection from it)`);
console.log(sim ? '#### OFFLINE SIMULATION of the n8n run — this is NOT a model evaluation ####'
                : `#### REAL MODEL RUN via n8n credential STAGING_OPENAI_GRANJA · run ${manifest.run} · date ${manifest.today} ####`);

const sha = (s) => createHash('sha256').update(s).digest('hex');
const results = [];
for (const cand of manifest.candidates) {
  const { label } = cand;
  console.log(`\n== ${label}`);
  const rows = [];
  for (const c of cases.filter((x) => !manifest.case_ids || manifest.case_ids.includes(x.id))) {
    const prep = prepare(c, cand, manifest.today);
    let status = 0, json = null;
    if (prep.body) {
      if (manifest.requests[`${label}|${c.id}`] !== sha(JSON.stringify(prep.body))) { console.log(`STOP: request ${label}|${c.id} differs from the one sent`); process.exit(2); }
      const a = got.results.find((r) => r.id === c.id && r.label === label);
      if (a && a.fp !== fnv(JSON.stringify(prep.body))) { console.log(`STOP: n8n sent a different request for ${label}|${c.id}`); process.exit(2); }
      if (a) { status = a.statusCode; json = a.body; }
    }
    const row = finish(c, prep, status, json, manifest.today); rows.push(row);
    console.log(`  ${row.v.ok ? 'PASS' : row.v.hard ? 'HARD' : 'FAIL'} ${c.id}${row.v.ok ? '' : ' :: ' + row.v.why} [${row.tag}]`);
  }
  const r = score(cand, label, rows, []); results.push(r);
  console.log(`  score ${(r.score * 100).toFixed(0)}% (${r.ok}/${r.n}) · hard failures ${r.hard} · GPT errors ${r.errors} · GPT calls ${r.gpt}`
    + ` · tokens/msg in ${r.tin} out ${r.tout} · ~USD ${r.perMsgUSD.toFixed(5)}/GPT message · ~USD ${r.totalUSD.toFixed(4)} this run`);
}
const el = eligible(results);
console.log('\n== SUMMARY (latency not measured in this mode)');
for (const r of results) console.log(`  ${r.label}: score ${(r.score * 100).toFixed(0)}%, hard ${r.hard}, errors ${r.errors}, ~USD ${r.perMsgUSD.toFixed(5)}/msg`);
console.log(`  estimated cost of the whole run: ~USD ${results.reduce((s, r) => s + r.totalUSD, 0).toFixed(4)} (prices from eval-config.json, to be confirmed)`);
console.log(el.length ? `CHOSEN: ${el[0].cand.model} effort=${el[0].cand.effort ?? 'null'}` : 'CHOSEN: none — no candidate meets the criteria');
if (sim) console.log('#### OFFLINE SIMULATION — not a model result ####');
process.exitCode = el.length ? 0 : 1;
