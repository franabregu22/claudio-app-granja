// ADR-025 — model evaluation of the interpreter (stage 1). Runs the golden set through the EXACT production path
// (WAI.buildRequest → OpenAI Responses API → WAI.parseResponse → WAI.decide) for every candidate in eval-config.json.
// The API key comes from OPENAI_API_KEY (set by eval-models.sh, typed privately); it is never printed or written.
// Writes nothing anywhere; costs a few cents. Selection: eligible (available, not deprecated, 0 hard failures,
// score >= min_score) → highest score → lowest estimated cost → lowest p95 latency.
import { readFileSync } from 'node:fs';

const HERE = new URL('.', import.meta.url);
const WAI = new Function(readFileSync(new URL('../interpreter.js', HERE), 'utf8') + '\nreturn WAI;')();
const cfg = JSON.parse(readFileSync(new URL('./eval-config.json', HERE), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('./golden-set.json', HERE), 'utf8'));
const KEY = process.env.OPENAI_API_KEY || '';
const BASE = process.env.EVAL_BASE_URL || 'https://api.openai.com';   // overridable only for the offline harness test
if (!KEY) { console.log('STOP: OPENAI_API_KEY missing'); process.exit(2); }
if (!/^https:\/\/api\.openai\.com$|^http:\/\/127\.0\.0\.1:[0-9]+$/.test(BASE)) { console.log('STOP: unexpected endpoint'); process.exit(2); }

const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const catalog = { categories: ['Combustible', 'Insumos', 'Limpieza', 'Mantenimiento'].map((n, i) => ({ id: `cat-${i}`, nombre: n })),
  accounts: [{ id: 'acc-cash', nombre: 'Caja chica', account_type: 'CASH' }, { id: 'acc-bna', nombre: 'BNA', account_type: 'BANK_ACCOUNT' }, { id: 'acc-mp', nombre: 'Mercado Pago', account_type: 'EXTERNAL_SERVICE' }] };
const catId = (n) => catalog.categories.find((c) => c.nombre === n)?.id;
const accOf = { CASH: 'acc-cash', TRANSFER: 'acc-bna', MERCADOPAGO: 'acc-mp' };
const openDraft = { draft_id: 'd0000000-0000-4000-8000-000000000009', short_code: 'W-0009', state: 'DRAFT', version: 2,
  payload: { date: today, total: 18, concept: 'Combustible', category_id: catId('Combustible'), nature: 'OPERATING', account_id: 'acc-cash', method: 'CASH', needs_mp: false } };

/** verdict of one case: ok / hard (an action where none was allowed, a wrong amount, or an untouched field changed) */
function judge(c, d) {
  const e = c.expect, r = d.request;
  const date = (v) => (v === 'yesterday' ? yesterday : v);
  if (e.kind === 'reply') return r ? { ok: false, hard: true, why: `unexpected ${r.action}` } : { ok: true };
  if (!r) return { ok: false, hard: false, why: `reply (${d.outcome})` };
  if (r.action !== e.kind) return { ok: false, hard: true, why: `${r.action} instead of ${e.kind}` };
  const p = r.payload;
  if (e.total !== undefined && p.total !== e.total) return { ok: false, hard: true, why: `total ${p.total} ≠ ${e.total}` };
  if (e.category && p.category_id !== catId(e.category)) return { ok: false, hard: false, why: `category ${p.category_id}` };
  if (e.method && p.method !== e.method) return { ok: false, hard: false, why: `method ${p.method}` };
  if (e.date && p.date !== date(e.date)) return { ok: false, hard: false, why: `date ${p.date}` };
  if (e.concept_contains && !String(p.concept).toLowerCase().includes(e.concept_contains)) return { ok: false, hard: false, why: `concept "${p.concept}"` };
  if (e.kind === 'correct') {                                             // fields NOT mentioned must be identical to the DB payload
    const map = { amount: ['total'], concept: ['concept'], category: ['category_id'], method: ['method', 'account_id'], date: ['date'] };
    const allowed = new Set(e.changed.flatMap((f) => map[f]));
    for (const k of ['total', 'concept', 'category_id', 'method', 'account_id', 'date', 'nature']) {
      if (!allowed.has(k) && p[k] !== openDraft.payload[k]) return { ok: false, hard: true, why: `untouched field ${k} changed` };
    }
    if (e.method && p.account_id !== accOf[e.method]) return { ok: false, hard: true, why: 'account not mapped from method' };
  }
  return { ok: true };
}

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
  let ok = 0, hard = 0, tin = 0, tout = 0; const lat = [];
  for (const c of cases) {
    const ctx = { ok: true, open: c.open ? openDraft : null, waiting: [], catalog };
    const { body } = WAI.buildRequest({ text: c.text, today, context: ctx, model: cand.model, effort: cand.effort, maxOutputTokens: 600 });
    const t0 = Date.now();
    let status = 0, json = null;
    try { const r = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
          status = r.status; json = await r.json().catch(() => null); } catch { status = 0; }
    lat.push(Date.now() - t0);
    const p = WAI.parseResponse(status, json);
    if (p.usage) { tin += p.usage.input || 0; tout += p.usage.output || 0; }
    const d = p.ok ? WAI.decide({ gpt: p.data, text: c.text, ctx, today, accountByMethod: cfg.account_by_method, amountCap: 10000000 }) : { outcome: 'gpt_failed:' + p.reason };
    const v = p.ok ? judge(c, d) : { ok: c.expect.kind === 'reply', hard: false, why: 'gpt_failed:' + p.reason };
    if (v.ok) ok++; if (v.hard) hard++;
    console.log(`  ${v.ok ? 'PASS' : v.hard ? 'HARD' : 'FAIL'} ${c.id}${v.ok ? '' : ' :: ' + v.why}${p.ok ? ' [' + p.data.intent + ']' : ''}`);
  }
  lat.sort((a, b) => a - b);
  const n = cases.length, cost = (tin * cand.price_in + tout * cand.price_out) / 1e6 / n;
  const r = { label, cand, avail, score: ok / n, hard, perMsgUSD: cost, p50: lat[Math.floor(n / 2)], p95: lat[Math.min(n - 1, Math.floor(n * 0.95))], tin: Math.round(tin / n), tout: Math.round(tout / n) };
  results.push(r);
  console.log(`  score ${(r.score * 100).toFixed(0)}% (${ok}/${n}) · hard failures ${hard} · ~USD ${cost.toFixed(5)}/message · tokens/msg in ${r.tin} out ${r.tout} · latency p50 ${r.p50} ms p95 ${r.p95} ms`);
}
const eligible = results.filter((r) => r.avail === 'yes' && !r.cand.deprecated && r.hard === 0 && r.score >= cfg.min_score)
  .sort((a, b) => b.score - a.score || a.perMsgUSD - b.perMsgUSD || a.p95 - b.p95);
console.log('\n== SUMMARY');
for (const r of results) console.log(`  ${r.label}: ${r.avail !== 'yes' ? 'not available' : `score ${(r.score * 100).toFixed(0)}%, hard ${r.hard}, USD ${r.perMsgUSD.toFixed(5)}/msg, p95 ${r.p95} ms`}${r.cand.deprecated ? ' (deprecated: not eligible)' : ''}`);
console.log(eligible.length ? `CHOSEN: ${eligible[0].cand.model} effort=${eligible[0].cand.effort ?? 'null'}` : 'CHOSEN: none — no candidate meets the criteria');
process.exitCode = eligible.length ? 0 : 1;
