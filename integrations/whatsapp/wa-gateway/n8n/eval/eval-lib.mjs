// ADR-025 — shared pieces of the v2 model evaluation: the production interpreter (WAI), the synthetic catalog and accounts,
// the golden set, the open draft of a case, the judge, the offline "ideal" answer and the per-case pipeline. Used by
// eval-models.mjs (direct key), eval-n8n-build.mjs / eval-n8n-judge.mjs (existing n8n credential) and the offline tests.
// Every case is synthetic: no real amounts, people or documents.
import { readFileSync } from 'node:fs';

const HERE = new URL('.', import.meta.url);
export const WAI = new Function(readFileSync(new URL('../interpreter.js', HERE), 'utf8') + '\nreturn WAI;')();
export const cfg = JSON.parse(readFileSync(new URL('./eval-config.json', HERE), 'utf8'));
export const cases = JSON.parse(readFileSync(new URL('./golden-set-v2.json', HERE), 'utf8'));
/** FNV-1a 32-bit of a string (same code runs in the n8n Collect node): proves n8n sent exactly the locally built request */
export const FNV_SRC = "(s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }";
export const fnv = new Function('return ' + FNV_SRC)();
export const AMOUNT_CAP = 10000000;
export const MAX_OUTPUT_TOKENS = 600;

export const todayAR = (now = Date.now()) => new Date(now - 3 * 3600 * 1000).toISOString().slice(0, 10);
export const dayBefore = (d) => new Date(Date.parse(d + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);

// a production-like catalog (category › subcategory, in the database order) and the four enabled paying accounts
const TREE = [['Combustible', ['Gasoil', 'Nafta']], ['Insumos alimento balanceado', ['Afrechillo de trigo', 'Conchilla', 'Expeller de Soja', 'Maiz']],
  ['Insumos varios', ['Gas', 'Medicamentos', 'Otros']], ['Logística / Fletes', ['Flete Insumos balanceado', 'Flete Varios']], ['Mano de obra', ['Jornales']],
  ['Materiales / Repuestos', ['Herramientas', 'Repuestos']], ['Servicios', ['Contador', 'Electricidad', 'Telefonía / Internet', 'Veterinario']]];
export const categories = TREE.flatMap(([g, subs], gi) => subs.map((s, si) => ({ id: `cat-${gi}-${si}`, nombre: s, grupo_id: `grp-${gi}`, grupo: g })));
const METHOD_OF = { CASH: 'CASH', BANK_ACCOUNT: 'TRANSFER', EXTERNAL_SERVICE: 'MERCADOPAGO' };
const baseAccounts = [['Caja chica', 'CASH'], ['BNA', 'BANK_ACCOUNT'], ['Patagonia', 'BANK_ACCOUNT'], ['Mercado Pago', 'EXTERNAL_SERVICE']];
export const accountsOf = (c) => [...baseAccounts, ...(c.accounts_extra || []).map((a) => [a.nombre, a.account_type])]
  .map(([n, t], i) => ({ id: `acc-${i}`, nombre: n, account_type: t, method: METHOD_OF[t] }));
export const subId = (n) => categories.find((c) => c.nombre === n)?.id;

/** the open draft of a case, as wa_context returns it (pending data included) */
export function openOf(c, accounts, today) {
  if (!c.open) return null;
  const o = c.open, p = { date: today, total: o.total, concept: o.concept, nature: 'OPERATING', method: o.method, needs_mp: false };
  if (Array.isArray(o.category_pending)) Object.assign(p, { category_pending: true, category_options: o.category_pending.map(subId) });
  else p.category_id = subId(o.category);
  if (o.account_pending) p.account_pending = true; else p.account_id = accounts.find((a) => a.nombre === o.account).id;
  return { draft_id: 'd0000000-0000-4000-8000-000000000042', short_code: 'W-0042', state: 'DRAFT', version: 2, payload: p };
}

/** the context of a case (what wa_context would return) */
export function contextOf(c, today) {
  const accounts = accountsOf(c);
  return { accounts, ctx: { ok: true, open: openOf(c, accounts, today), waiting: [], catalog: { categories, accounts } } };
}

/** verdict: ok / soft fail / HARD (an action where none was allowed, a wrong amount, a wrong account, an ambiguous datum
 *  auto-selected, or a field the user did not mention changed) */
export function judge(c, d, ctx, accounts, today) {
  const e = c.expect, r = d.request, accId = (n) => accounts.find((a) => a.nombre === n)?.id;
  const dateOf = (v) => (v === 'yesterday' ? dayBefore(today) : v ?? today);
  if (e.kind === 'reply') return r ? { ok: false, hard: true, why: `unexpected ${r.action}` } : { ok: true };
  if (!r) return { ok: false, hard: false, why: `reply (${d.outcome})` };
  if (r.action !== e.kind) return { ok: false, hard: true, why: `${r.action} instead of ${e.kind}` };
  const p = r.payload;
  if (e.total !== undefined && p.total !== e.total) return { ok: false, hard: true, why: `total ${p.total} ≠ ${e.total}` };
  if (e.account && p.account_id !== accId(e.account)) return { ok: false, hard: !!p.account_id, why: p.account_id ? `WRONG account ${p.account_id}` : 'account left pending' };
  if (e.account_pending && p.account_id) return { ok: false, hard: true, why: `ambiguous account auto-selected (${p.account_id})` };
  if (e.category_pending && p.category_id) return { ok: false, hard: true, why: `ambiguous subcategory auto-selected (${p.category_id})` };
  if (e.category && p.category_id !== subId(e.category)) return { ok: false, hard: false, why: p.category_id ? `subcategory ${p.category_id}` : 'subcategory left pending' };
  if (e.options) { const got = (p.category_options || []).map((id) => categories.find((x) => x.id === id)?.nombre).sort();
    if (JSON.stringify(got) !== JSON.stringify([...e.options].sort())) return { ok: false, hard: false, why: `options ${got.join('/')}` }; }
  if (e.method && p.method !== e.method) return { ok: false, hard: false, why: `method ${p.method}` };
  if (e.date && p.date !== dateOf(e.date)) return { ok: false, hard: false, why: `date ${p.date}` };
  // owner decision C03: the concept is never rewritten arbitrarily → a concept other than the expected one is HARD
  const n = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  if (e.concept !== undefined && n(p.concept) !== n(e.concept)) return { ok: false, hard: true, why: `concept "${p.concept}" ≠ "${e.concept}"` };
  if (e.kind === 'correct') {   // fields NOT mentioned must be identical to the database payload
    const map = { amount: ['total'], concept: ['concept'], category: ['category_id', 'category_pending', 'category_options'], method: ['method', 'account_id', 'account_pending'],
                  account: ['account_id', 'method', 'account_pending'], date: ['date'] };
    const allowed = new Set(e.changed.flatMap((f) => map[f]));
    for (const k of ['total', 'concept', 'category_id', 'category_pending', 'category_options', 'method', 'account_id', 'account_pending', 'date', 'nature']) {
      if (!allowed.has(k) && JSON.stringify(p[k]) !== JSON.stringify(ctx.open.payload[k])) return { ok: false, hard: true, why: `untouched field ${k} changed` };
    }
  }
  return { ok: true };
}

/** step 1 of a case: deterministic preRoute (no GPT) or the exact OpenAI request body production would send */
export function prepare(c, cand, today) {
  const { accounts, ctx } = contextOf(c, today);
  const pre = WAI.preRoute(c.text, ctx);
  if (pre) return { accounts, ctx, pre };
  const { body } = WAI.buildRequest({ text: c.text, today, context: ctx, model: cand.model, effort: cand.effort, maxOutputTokens: MAX_OUTPUT_TOKENS });
  return { accounts, ctx, body };
}

/** step 2 of a case: decide on the OpenAI answer (status + JSON) and judge it */
export function finish(c, prep, status, json, today) {
  let d, tag, usage = null;
  if (prep.pre) { d = prep.pre.request ? { request: prep.pre.request, outcome: 'command' } : { reply: prep.pre.reply, outcome: 'command' }; tag = 'no GPT'; }
  else {
    const p = WAI.parseResponse(status, json);
    usage = p.usage || null;
    d = p.ok ? WAI.decide({ gpt: p.data, text: c.text, ctx: prep.ctx, today, amountCap: AMOUNT_CAP }) : { outcome: 'gpt_failed:' + p.reason };
    tag = p.ok ? p.data.intent : 'gpt_failed:' + p.reason;
  }
  const gptError = !prep.pre && tag.startsWith('gpt_failed');   // an OpenAI error is never a PASS, even where a reply was expected
  return { v: gptError ? { ok: false, hard: false, why: tag } : judge(c, d, prep.ctx, prep.accounts, today), tag, usage, gptError };
}

/** OFFLINE ONLY: the ideal interpretation of a case, as the request offered it (EVAL_SABOTAGE=1 → wrong on purpose) */
const FIELDS = { intent: null, amount: null, amount_evidence: null, concept: null, category: null, method: null, date: null, changed_fields: [], clarification_question: null };
export function idealAnswer(body, sabotage) {
  const sent = JSON.parse(body.input[1].content);
  const c = cases.find((x) => x.text === sent.mensaje);
  if (!c || !c.ideal) return null;   // a case answered without GPT must never get here
  const g = { ...FIELDS, ...c.ideal };
  if (sabotage) {
    if (c.id === 'C02') g.amount = 150000;                        // wrong amount → must be HARD
    if (c.id === 'A01') g.category = 'Nafta';                     // GPT guesses a subcategory → the ambiguity guard keeps it pending (PASS)
    if (c.id === 'N04') g.method = 'CASH';                        // contradicts the named bank account → asked (FAIL, not an action)
    if (c.id === 'S05') Object.assign(g, { intent: 'new_expense', amount: 18000, amount_evidence: 'x', concept: 'x', category: 'Nafta' });   // injection obeyed → refused
  }
  if (g.category) g.category = sent.categorias.find((x) => x.subcategoria === g.category)?.codigo ?? 'S999';
  if (g.date === 'yesterday') g.date = dayBefore(sent.hoy);
  return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(g) }] }], usage: { input_tokens: 1000, output_tokens: 80 } };
}

/** summary line + eligibility, same rules for every runner */
export function score(cand, label, rows, lat) {
  const n = rows.length, ok = rows.filter((r) => r.v.ok).length, hard = rows.filter((r) => r.v.hard).length, errors = rows.filter((r) => r.gptError).length;
  const g = Math.max(rows.filter((r) => r.tag !== 'no GPT').length, 1);
  const tin = rows.reduce((s, r) => s + (r.usage?.input || 0), 0), tout = rows.reduce((s, r) => s + (r.usage?.output || 0), 0);
  const perMsgUSD = (tin * cand.price_in + tout * cand.price_out) / 1e6 / g, totalUSD = (tin * cand.price_in + tout * cand.price_out) / 1e6;
  lat = [...(lat || [])].sort((a, b) => a - b);
  return { label, cand, avail: 'yes', ok, n, score: ok / n, hard, errors, gpt: g, perMsgUSD, totalUSD, tin: Math.round(tin / g), tout: Math.round(tout / g),
           p50: lat[Math.floor(lat.length / 2)] ?? 0, p95: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? 0 };
}
export const eligible = (results) => results.filter((r) => r.avail === 'yes' && !r.cand.deprecated && r.hard === 0 && r.score >= cfg.min_score)
  .sort((a, b) => b.score - a.score || a.perMsgUSD - b.perMsgUSD || a.p95 - b.p95);
