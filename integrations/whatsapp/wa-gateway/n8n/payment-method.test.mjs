// ADR-025 — payment method of a WhatsApp expense (node --test n8n/payment-method.test.mjs). No network, no GPT: GPT's answer is given.
// Owner decision (2026-10-24): the payment method is NEVER presumed. Not stated, unknown or ambiguous → the draft keeps every other
// datum with the method PENDING; the method is taken only from the message (a method word or a named account) or a METHOD button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WAI = new Function(readFileSync(new URL('./interpreter.js', import.meta.url), 'utf8') + '\nreturn WAI;')();
const WA = new Function(readFileSync(new URL('./logic.js', import.meta.url), 'utf8') + '\nreturn WA;')();
const LIMP = 'c5', D = '11111111-2222-4333-8444-555555555555';
// the ERP today: one cash account, TWO bank accounts (BNA, Patagonia), the Mercado Pago account
const catalog = { categories: [{ id: 'c4', nombre: 'Combustible', grupo: 'Operación' }, { id: LIMP, nombre: 'Limpieza', grupo: 'Operación' }],
  accounts: [{ id: 'acc-cash', nombre: 'Caja chica', account_type: 'CASH', method: 'CASH' }, { id: 'acc-bna', nombre: 'BNA', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' },
             { id: 'acc-pat', nombre: 'Patagonia', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' }, { id: 'acc-mp', nombre: 'Mercado Pago', account_type: 'EXTERNAL_SERVICE', method: 'MERCADOPAGO' }] };
const code = (name) => WAI.options(catalog).find((x) => x.nombre === name).code;
const G = (o) => ({ intent: 'new_expense', amount: 25000, amount_evidence: '25000', concept: 'Artículos de limpieza', category: code('Limpieza'), method: null, date: null,
  changed_fields: [], clarification_question: null, ...o });
const ctx = (open = null) => ({ ok: true, open, waiting: [], catalog });
const decide = (gpt, text, c = ctx()) => WAI.decide({ gpt, text, ctx: c, today: '2026-10-24', amountCap: 10000000 });
const MSG = 'Gasté 25000 en artículos de limpieza';
const draft = (payload) => ({ draft_id: D, short_code: 'W-0099', state: 'DRAFT', version: 1,
  payload: { date: '2026-10-24', total: 25000, concept: 'Artículos de limpieza', category_id: LIMP, nature: 'OPERATING', ...payload } });
const kept = (p) => [p.total, p.concept, p.date, p.category_id];
const KEPT = [25000, 'Artículos de limpieza', '2026-10-24', LIMP];

test('PM-1 no method in the message → method PENDING (no cash); amount, concept, date, subcategory kept; even if GPT guesses CASH', () => {
  for (const gptMethod of [null, 'CASH', 'TRANSFER']) {
    const d = decide(G({ method: gptMethod }), MSG);
    assert.deepEqual([d.outcome, d.request.payload.method, d.request.payload.account_id, d.pending], ['propose_pending', undefined, undefined, ['method', 'account']]);
    assert.deepEqual(kept(d.request.payload), KEPT);
  }
});
test('PM-2 unknown method ("con tarjeta", "con cheque") → method pending, never cash', () => {
  for (const t of [MSG + ' con tarjeta', MSG + ' con cheque']) assert.equal(decide(G({ method: 'CASH' }), t).request.payload.method, undefined);
});
test('PM-2b ambiguous method ("efectivo o transferencia") → method pending', () => {
  const d = decide(G({ method: 'CASH' }), MSG + ', efectivo o transferencia, no me acuerdo');
  assert.deepEqual([d.request.payload.method, d.pending], [undefined, ['method', 'account']]);
});
test('PM-3 efectivo → CASH, Caja chica (the only enabled cash account); amount, concept, date, subcategory set', () => {
  const p = decide(G({ method: 'CASH' }), MSG + ' en efectivo').request.payload;
  assert.deepEqual([p.method, p.account_id, ...kept(p)], ['CASH', 'acc-cash', ...KEPT]);
});
test('PM-4 transferencia with TWO bank accounts → draft WITHOUT account (pending): the bot asks "BNA o Patagonia", no confirm button', () => {
  const d = decide(G({ method: 'TRANSFER' }), MSG + ' por transferencia');
  assert.deepEqual([d.outcome, d.request.payload.method, d.request.payload.account_id, d.pending], ['propose_pending', 'TRANSFER', undefined, ['account']]);
  const out = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { result: { ok: true, draft_id: D, short_code: 'W-0099', state: 'DRAFT', version: 1,
    payload: { ...d.request.payload, account_pending: true, needs_mp: false } } }, null, WAI.cfgFromContext(ctx()));
  assert.equal(out.graph.type, 'text');                                        // no interactive buttons at all
  assert.match(out.graph.text.body, /¿Desde qué cuenta lo pagaste\? BNA o Patagonia\./);
});
test('PM-5 transferencia naming the bank ("desde Patagonia") → that account; the name decides the method too', () => {
  const p = decide(G({ method: 'TRANSFER' }), MSG + ' por transferencia desde Patagonia').request.payload;
  assert.deepEqual([p.method, p.account_id], ['TRANSFER', 'acc-pat']);
  const q = decide(G({}), MSG + ', lo pagué desde Patagonia').request.payload;
  assert.deepEqual([q.method, q.account_id], ['TRANSFER', 'acc-pat']);
  const r = decide(G({ method: 'CASH' }), MSG + ' desde BNA').request.payload;   // GPT's CASH is not evidence: the named bank decides
  assert.deepEqual([r.method, r.account_id], ['TRANSFER', 'acc-bna']);
});
test('PM-6 mercado pago → MERCADOPAGO, the ERP Mercado Pago account (the database then waits for the outflow: WAITING_MP, ADR-021)', () => {
  const p = decide(G({ method: 'MERCADOPAGO' }), MSG + ' con mercado pago').request.payload;
  assert.deepEqual([p.method, p.account_id, ...kept(p)], ['MERCADOPAGO', 'acc-mp', ...KEPT]);
});
test('PM-7 method and named account disagree ("en efectivo desde BNA") → a question, no draft', () => {
  const d = decide(G({ method: 'CASH' }), MSG + ' en efectivo desde BNA');
  assert.equal(d.outcome, 'account_method_mismatch');
  assert.equal(d.request, undefined);
});
test('PM-8 correction "era transferencia" on a cash draft (two banks) → account pending (asked); amount / concept / date / subcategory kept', () => {
  const d = decide(G({ intent: 'correct_draft', changed_fields: ['method'], method: 'TRANSFER' }), 'no, era transferencia',
    ctx(draft({ method: 'CASH', account_id: 'acc-cash', needs_mp: false })));
  const p = d.request.payload;
  assert.deepEqual([d.request.action, p.method, p.account_id, p.account_pending, ...kept(p)], ['correct', 'TRANSFER', undefined, true, ...KEPT]);
});
test('PM-8b a method correction whose message does not state the method (GPT says CASH for "cambialo") → asked, never applied', () => {
  const d = decide(G({ intent: 'correct_draft', changed_fields: ['method'], method: 'CASH' }), 'cambialo', ctx(draft({ method: 'TRANSFER', account_id: 'acc-bna', needs_mp: false })));
  assert.deepEqual([d.request, d.outcome], [undefined, 'ask_method']);
});
test('PM-9 answer "Patagonia" to the account question → only the account is set (deterministic, no GPT)', () => {
  const r = WAI.preRoute('Patagonia', ctx(draft({ method: 'TRANSFER', account_pending: true, needs_mp: false })));
  assert.deepEqual([r.request.action, r.request.payload.account_id, r.request.payload.account_pending, ...kept(r.request.payload)], ['correct', 'acc-pat', undefined, ...KEPT]);
});
test('PM-10 correction "era mercado pago" → MERCADOPAGO + the MP account; the rest kept', () => {
  const p = decide(G({ intent: 'correct_draft', changed_fields: ['method'], method: 'MERCADOPAGO' }), 'era mercado pago',
    ctx(draft({ method: 'CASH', account_id: 'acc-cash', needs_mp: false }))).request.payload;
  assert.deepEqual([p.method, p.account_id, ...kept(p)], ['MERCADOPAGO', 'acc-mp', ...KEPT]);
});
test('PM-11 the Confirmar button appears only when nothing is pending (a cash draft shows it; PM-4 showed none)', () => {
  const out = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { result: { ok: true, draft_id: D, short_code: 'W-0099', state: 'DRAFT', version: 1,
    payload: { ...draft({ method: 'CASH', account_id: 'acc-cash', needs_mp: false }).payload } } }, null, WAI.cfgFromContext(ctx()));
  assert.deepEqual(out.graph.interactive.action.buttons.map((b) => b.reply.title), ['Confirmar', 'Cancelar']);
});

// ── the pending method: deterministic answers, the three buttons, stale / foreign buttons ──
const pend = (extra = {}) => draft({ method_pending: true, account_pending: true, needs_mp: false, ...extra });
test('PM-12 pending method + text "efectivo" → CASH and the ONLY cash account, no GPT; data kept', () => {
  const r = WAI.preRoute('efectivo', ctx(pend()));
  assert.deepEqual([r.request.action, r.request.payload.method, r.request.payload.account_id, r.request.payload.method_pending, r.request.payload.account_pending, ...kept(r.request.payload)],
    ['correct', 'CASH', 'acc-cash', undefined, undefined, ...KEPT]);
});
test('PM-13 pending method + "transferencia" with two banks → TRANSFER, account still pending; + "Patagonia" alone → TRANSFER / Patagonia', () => {
  const r = WAI.preRoute('transferencia', ctx(pend()));
  assert.deepEqual([r.request.payload.method, r.request.payload.account_id, r.request.payload.account_pending], ['TRANSFER', undefined, true]);
  const q = WAI.preRoute('desde Patagonia', ctx(pend()));
  assert.deepEqual([q.request.payload.method, q.request.payload.account_id], ['TRANSFER', 'acc-pat']);
});
test('PM-14 pending method + "mp" / "mercado pago" → MERCADOPAGO (then the database applies ADR-021: WAITING_MP)', () => {
  for (const t of ['mp', 'con mercado pago']) assert.deepEqual(WAI.preRoute(t, ctx(pend())).request.payload.method, 'MERCADOPAGO');
});
test('PM-15 pending method + an ambiguous or unknown answer → not resolved here (GPT path, which asks again)', () => {
  for (const t of ['efectivo o transferencia', 'con tarjeta', 'efectivo desde BNA']) assert.equal(WAI.preRoute(t, ctx(pend())), null);
});
test('PM-16 METHOD button of THIS draft and version → that method; old version / other draft / method no longer pending → refused', () => {
  const ok = WAI.preRoute(null, ctx(pend()), { draft_id: D, version: 1, method: 'TRANSFER' });
  assert.deepEqual([ok.request.action, ok.request.payload.method], ['correct', 'TRANSFER']);
  for (const [c, pick] of [[pend(), { draft_id: D, version: 0, method: 'CASH' }], [pend(), { draft_id: '99999999-2222-4333-8444-555555555555', version: 1, method: 'CASH' }],
                           [draft({ method: 'CASH', account_id: 'acc-cash', needs_mp: false }), { draft_id: D, version: 1, method: 'CASH' }], [null, { draft_id: D, version: 1, method: 'CASH' }]]) {
    assert.match(WAI.preRoute(null, ctx(c), pick).reply, /versión anterior/);
  }
});
test('PM-17 while the method is pending: no Confirmar and no "Registrar sin clasif" (even with the subcategory pending too); 3 method buttons', () => {
  for (const extra of [{}, { category_id: undefined, category_pending: true, category_options: [LIMP, 'c4'] }]) {
    const out = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { result: { ok: true, draft_id: D, short_code: 'W-0099', state: 'DRAFT', version: 1, payload: pend(extra).payload } },
      null, WAI.cfgFromContext(ctx()));
    const titles = out.graph.interactive.action.buttons.map((b) => b.reply.title);
    assert.deepEqual(titles, ['Efectivo', 'Transferencia', 'Mercado Pago']);
    assert.match(out.graph.interactive.body.text, /Pago: \(a elegir\)/);
  }
});
test('PM-18 the interpreter tells GPT the method is pending ("medio de pago"), not the account', () => {
  const sent = WAI.buildRequest({ text: 'x', today: '2026-10-24', context: ctx(pend()), model: 'm' }).sent;
  assert.deepEqual(sent.borrador_abierto.pendiente, ['medio de pago']);
});
test('PM-19 no code path assigns CASH without the message stating it (static check of the interpreter source)', () => {
  const src = readFileSync(new URL('./interpreter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\|\|\s*'CASH'/); assert.doesNotMatch(src, /\?\?\s*'CASH'/); assert.doesNotMatch(src, /method\s*=\s*'CASH'/);
});
