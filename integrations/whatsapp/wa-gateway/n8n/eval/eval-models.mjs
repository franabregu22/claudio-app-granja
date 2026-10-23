// ADR-025 — model evaluation of the interpreter, v2 (D-1 live catalog with hierarchy + D-3 live paying accounts).
// Every case runs the EXACT production path: WAI.preRoute (deterministic commands / answers to pending data, no GPT)
// → if needed WAI.buildRequest → OpenAI Responses API → WAI.parseResponse → WAI.decide (shared code: eval-lib.mjs).
// The API key comes from OPENAI_API_KEY (set by eval-models.sh, typed privately); it is never printed or written.
// EVAL_BASE_URL may point ONLY to 127.0.0.1 for the offline harness test (eval-offline.mjs): that run checks the harness,
// NOT the model. Selection: eligible (available, not deprecated, 0 hard failures, score >= min_score) → highest score →
// lowest estimated cost → lowest p95 latency.
import { cfg, cases, todayAR, prepare, finish, score, eligible } from './eval-lib.mjs';

const KEY = process.env.OPENAI_API_KEY || '';
const BASE = process.env.EVAL_BASE_URL || 'https://api.openai.com';
if (!KEY) { console.log('STOP: OPENAI_API_KEY missing'); process.exit(2); }
if (!/^https:\/\/api\.openai\.com$|^http:\/\/127\.0\.0\.1:[0-9]+$/.test(BASE)) { console.log('STOP: unexpected endpoint'); process.exit(2); }
if (BASE !== 'https://api.openai.com') console.log('#### OFFLINE HARNESS RUN (simulated answers on 127.0.0.1) — this is NOT a model evaluation ####');

const today = todayAR();

async function available(model) {
  const r = await fetch(`${BASE}/v1/models/${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${KEY}` } });
  return r.status === 200 ? 'yes' : `no (HTTP ${r.status})`;
}

const results = [];
for (const cand of cfg.candidates) {
  const label = `${cand.model}${cand.effort ? ' / ' + cand.effort : ''}`;
  const avail = await available(cand.model);
  if (avail !== 'yes') { console.log(`\n== ${label}: available ${avail}`); results.push({ label, cand, avail }); continue; }
  console.log(`\n== ${label}: available yes`);
  const rows = [], lat = [];
  for (const c of cases) {
    const prep = prepare(c, cand, today);
    let status = 0, json = null;
    if (prep.body) {
      const t0 = Date.now();
      try { const r = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(prep.body) });
            status = r.status; json = await r.json().catch(() => null); } catch { status = 0; }
      lat.push(Date.now() - t0);
    }
    const row = finish(c, prep, status, json, today); rows.push(row);
    console.log(`  ${row.v.ok ? 'PASS' : row.v.hard ? 'HARD' : 'FAIL'} ${c.id}${row.v.ok ? '' : ' :: ' + row.v.why} [${row.tag}]`);
  }
  const r = score(cand, label, rows, lat); results.push(r);
  console.log(`  score ${(r.score * 100).toFixed(0)}% (${r.ok}/${r.n}) · hard failures ${r.hard} · GPT calls ${r.gpt} · ~USD ${r.perMsgUSD.toFixed(5)}/GPT message · tokens in ${r.tin} out ${r.tout} · latency p50 ${r.p50} ms p95 ${r.p95} ms`);
}
const el = eligible(results);
console.log('\n== SUMMARY');
for (const r of results) console.log(`  ${r.label}: ${r.avail !== 'yes' ? 'not available' : `score ${(r.score * 100).toFixed(0)}%, hard ${r.hard}, USD ${r.perMsgUSD.toFixed(5)}/msg, p95 ${r.p95} ms`}${r.cand.deprecated ? ' (deprecated)' : ''}`);
console.log(el.length ? `CHOSEN: ${el[0].cand.model} effort=${el[0].cand.effort ?? 'null'}` : 'CHOSEN: none — no candidate meets the criteria');
if (BASE !== 'https://api.openai.com') console.log('#### OFFLINE HARNESS RUN — not a model result ####');
process.exitCode = el.length ? 0 : 1;
