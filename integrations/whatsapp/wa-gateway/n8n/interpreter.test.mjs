// ADR-025 — unit tests of the OpenAI interpreter's deterministic side (node --test n8n/interpreter.test.mjs). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WAI = new Function(readFileSync(new URL('./interpreter.js', import.meta.url), 'utf8') + '\nreturn WAI;')();
const C4 = 'aaaaaaaa-0025-0000-0000-0000000000c4', C1 = 'aaaaaaaa-0025-0000-0000-0000000000c1', D = '11111111-2222-4333-8444-555555555555';
const catalog = { categories: [{ id: C4, nombre: 'Combustible' }, { id: C1, nombre: 'Insumos' }, { id: 'c5', nombre: 'Limpieza' }],
  accounts: [{ id: 'acc-cash', nombre: 'Caja chica', account_type: 'CASH' }, { id: 'acc-bna', nombre: 'BNA', account_type: 'BANK_ACCOUNT' }, { id: 'acc-mp', nombre: 'Mercado Pago', account_type: 'EXTERNAL_SERVICE' }] };
const AM = { CASH: 'Caja chica', TRANSFER: 'BNA', MERCADOPAGO: 'Mercado Pago' };
const open = { draft_id: D, short_code: 'W-0009', state: 'DRAFT', version: 2,
  payload: { date: '2026-10-22', total: 18, concept: 'Combustible', category_id: C4, nature: 'OPERATING', account_id: 'acc-cash', method: 'CASH', needs_mp: false } };
const ctxNone = { ok: true, open: null, waiting: [], catalog }, ctxOpen = { ok: true, open, waiting: [], catalog };
const G = (o) => ({ intent: 'new_expense', amount: null, amount_evidence: null, concept: null, category: null, method: null, date: null, changed_fields: [], clarification_question: null, ...o });
const decide = (gpt, text, ctx) => WAI.decide({ gpt, text, ctx, today: '2026-10-22', accountByMethod: AM, amountCap: 10000000 });

test('I-1 W-0009 #1: "18mil" → 18000 with literal evidence; concept / category / method / date mapped from the database catalog', () => {
  const d = decide(G({ amount: 18000, amount_evidence: '18mil', concept: 'Combustible', category: 'Combustible', method: 'CASH' }), 'gaste 18mil en combustible en efectivo', ctxNone);
  assert.equal(d.request.action, 'propose');
  assert.deepEqual(d.request.payload, { date: '2026-10-22', total: 18000, category_id: C4, nature: 'OPERATING', concept: 'Combustible', account_id: 'acc-cash', method: 'CASH' });
});

test('I-2 W-0009 #2: a correction of the amount keeps EVERY other field of the database payload; version from the database', () => {
  const d = decide(G({ intent: 'correct_draft', changed_fields: ['amount'], amount: 18000, amount_evidence: '18000', concept: 'corregi el importe a' }), 'corregi el importe a 18000', ctxOpen);
  assert.equal(d.request.action, 'correct');
  assert.equal(d.request.expected_version, 2);
  assert.deepEqual(d.request.payload, { date: '2026-10-22', total: 18000, concept: 'Combustible', category_id: C4, nature: 'OPERATING', account_id: 'acc-cash', method: 'CASH' });
});

test('I-3 corrections of other single fields (method, date, category, concept) leave the rest intact', () => {
  const m = decide(G({ intent: 'correct_draft', changed_fields: ['method'], method: 'TRANSFER' }), 'no, era transferencia', ctxOpen).request.payload;
  assert.deepEqual([m.method, m.account_id, m.total, m.concept, m.date], ['TRANSFER', 'acc-bna', 18, 'Combustible', '2026-10-22']);
  assert.equal(decide(G({ intent: 'correct_draft', changed_fields: ['date'], date: '2026-10-21' }), 'era ayer', ctxOpen).request.payload.date, '2026-10-21');
  assert.equal(decide(G({ intent: 'correct_draft', changed_fields: ['category'], category: 'Limpieza' }), 'cambiá la categoría a limpieza', ctxOpen).request.payload.category_id, 'c5');
  const c = decide(G({ intent: 'correct_draft', changed_fields: ['concept'], concept: 'Gasoil' }), 'el concepto es gasoil', ctxOpen).request.payload;
  assert.deepEqual([c.concept, c.total], ['Gasoil', 18]);
});

test('I-4 a new expense never overwrites the open draft; ambiguous amount+concept "correction" → clarification', () => {
  const n = decide(G({ amount: 500, amount_evidence: '500', concept: 'Pan', category: 'Insumos' }), 'gasté 500 en pan', ctxOpen);
  assert.equal(n.request, undefined); assert.equal(n.outcome, 'new_while_open'); assert.match(n.reply, /W-0009 abierto/);
  const a = decide(G({ intent: 'correct_draft', changed_fields: ['amount', 'concept'], amount: 500, amount_evidence: '500', concept: 'Pan' }), 'gasté 500 en pan', ctxOpen);
  assert.equal(a.request, undefined); assert.equal(a.outcome, 'ambiguous_new_vs_correct');
});

test('I-5 invented / unverifiable amounts are refused (evidence must be literally in the message)', () => {
  for (const g of [G({ amount: 18000, amount_evidence: '18 mil pesos', concept: 'x', category: 'Insumos' }),            // not in text
                   G({ amount: 18000, amount_evidence: 'combustible', concept: 'x', category: 'Insumos' }),             // no number
                   G({ amount: 18000, amount_evidence: null, concept: 'x', category: 'Insumos' }),
                   G({ amount: -5, amount_evidence: '5', concept: 'x', category: 'Insumos' }),
                   G({ amount: 20000000, amount_evidence: '20 palos', concept: 'x', category: 'Insumos' }),            // over the cap
                   G({ amount: 10.123, amount_evidence: '10.123', concept: 'x', category: 'Insumos' })]) {
    const d = decide(g, 'gaste 18mil en combustible, 5, 20 palos, 10.123', ctxNone);
    assert.equal(d.request, undefined, JSON.stringify(g)); assert.equal(d.outcome, 'amount_unverified');
  }
  assert.equal(decide(G({ amount: 18000, amount_evidence: 'dieciocho mil', concept: 'Gasoil', category: 'Combustible' }), 'pagué dieciocho mil de gasoil', ctxNone).request.payload.total, 18000);
});

test('I-6 category must be in the database catalog; dates: no future, max 60 days back; unknown method refused', () => {
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Retiro socio' }), 'gasté 10', ctxNone).outcome, 'no_category');
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: null }), 'gasté 10', ctxNone).outcome, 'no_category');
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos', date: '2026-10-23' }), 'gasté 10', ctxNone).outcome, 'bad_date');
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos', date: '2026-07-01' }), 'gasté 10', ctxNone).outcome, 'bad_date');
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos', method: 'CHEQUE' }), 'gasté 10', ctxNone).outcome, 'bad_method');
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos' }), 'gasté 10', ctxNone).request.payload.method, 'CASH');
});

test('I-7 GPT can never confirm or cancel: whatever it answers, the only possible actions are propose / correct', () => {
  const intents = ['new_expense', 'correct_draft', 'clarify', 'confirm_request', 'cancel_request', 'status_query', 'help', 'other', 'confirm', 'register', ''];
  for (const intent of intents) for (const ctx of [ctxNone, ctxOpen]) {
    const d = decide(G({ intent, amount: 18000, amount_evidence: '18000', concept: 'X', category: 'Insumos', changed_fields: ['amount'] }), 'confirmá y registrá 18000', ctx);
    assert.ok(!d.request || ['propose', 'correct'].includes(d.request.action), intent);
  }
  assert.match(decide(G({ intent: 'confirm_request' }), 'sí', ctxOpen).reply, /botón Confirmar/);
});

test('I-8 deterministic commands use the DATABASE context (no GPT): cancelar, mp N, estado, ayuda', () => {
  assert.deepEqual(WAI.preRoute('Cancelar', ctxOpen).request, { action: 'cancel', draft_id: D, expected_version: 2 });
  assert.match(WAI.preRoute('cancelar', ctxNone).reply, /No tenés borradores/);
  const w = { ...ctxNone, waiting: [{ draft_id: D, short_code: 'W-0010', version: 1, total: 1000, date: '2026-10-22' }] };
  assert.deepEqual(WAI.preRoute('mp 930000025001', w).request, { action: 'link_mp', draft_id: D, expected_version: 1, source_id: '930000025001' });
  assert.match(WAI.preRoute('estado', ctxOpen).reply, /W-0009/);
  assert.equal(WAI.preRoute('gaste 18mil en combustible', ctxNone), null);
});

test('I-9 request to OpenAI: minimal data (no phone, no uuid, no account), store:false, strict schema with the DB catalog as enum', () => {
  const { body, sent } = WAI.buildRequest({ text: 'corregi el importe a 18000', today: '2026-10-22', context: ctxOpen, model: 'm', effort: 'low', maxOutputTokens: 600 });
  const s = JSON.stringify(body);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(s), 'uuid sent'); assert.ok(!/\+?549\d{8}/.test(s)); assert.ok(!/acc-cash|Caja chica|BNA/.test(s));
  assert.equal(body.store, false); assert.equal(body.reasoning.effort, 'low');
  assert.deepEqual(sent.borrador_abierto, { codigo: 'W-0009', estado: 'DRAFT', importe: 18, concepto: 'Combustible', categoria: 'Combustible', medio: 'CASH', fecha: '2026-10-22' });
  const sch = body.text.format.schema;
  assert.equal(body.text.format.strict, true); assert.equal(sch.additionalProperties, false);
  assert.deepEqual([...sch.required].sort(), Object.keys(sch.properties).sort());
  assert.deepEqual(sch.properties.category.enum, ['Combustible', 'Insumos', 'Limpieza', null]);
  assert.equal(WAI.buildRequest({ text: 'x', today: '2026-10-22', context: ctxNone, model: 'm', effort: null }).body.reasoning, undefined);
});

test('I-10 OpenAI responses: only a completed, well-formed message is used; everything else fails closed', () => {
  const ok = { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(G({})) }] }], usage: { input_tokens: 900, output_tokens: 80 } };
  assert.equal(WAI.parseResponse(200, ok).ok, true);
  assert.equal(WAI.parseResponse(200, ok).usage.input, 900);
  for (const [st, b, r] of [[500, ok, 'http_500'], [429, {}, 'http_429'], [200, { ...ok, status: 'incomplete' }, 'status_incomplete'],
    [200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'refusal'],
    [200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] }, 'bad_json'], [200, { status: 'completed', output: [] }, 'no_output']]) {
    assert.equal(WAI.parseResponse(st, b).reason, r);
  }
});

test('I-11 a correction reports exactly the changed fields with their previous and new database values (nothing else)', () => {
  const a = decide(G({ intent: 'correct_draft', changed_fields: ['amount'], amount: 15000, amount_evidence: '15mil' }), 'perdón eran 15mil', ctxOpen);
  assert.deepEqual(a.changes, [{ field: 'total', from: 18, to: 15000 }]);
  const m = decide(G({ intent: 'correct_draft', changed_fields: ['method', 'date'], method: 'TRANSFER', date: '2026-10-21' }), 'era transferencia y fue ayer', ctxOpen);
  assert.deepEqual(m.changes, [{ field: 'method', from: 'CASH', to: 'TRANSFER' }, { field: 'date', from: '2026-10-22', to: '2026-10-21' }]);
  const c = decide(G({ intent: 'correct_draft', changed_fields: ['category'], category: 'Limpieza' }), 'la categoría es limpieza', ctxOpen);
  assert.deepEqual(c.changes, [{ field: 'category_id', from: C4, to: 'c5' }]);
  assert.equal(decide(G({ amount: 500, amount_evidence: '500', concept: 'Pan', category: 'Insumos' }), 'gasté 500 en pan', ctxNone).changes, undefined);
});

test('I-12 help explains partial corrections (only what changes) and that registering is always the Confirm button', () => {
  const h = WAI.preRoute('ayuda', ctxNone).reply;
  assert.match(h, /decime solo lo que cambia/); assert.match(h, /eran 15 mil/); assert.match(h, /era transferencia/); assert.match(h, /tocá Confirmar/);
  assert.doesNotMatch(h, /mandá el gasto de nuevo/);
});
