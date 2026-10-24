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
// GPT answers the CODE of a subcategory of the live catalog; tests name subcategories and get their code (unknown names stay as-is → invalid)
const code = (name) => WAI.options(catalog).find((x) => x.nombre === name)?.code ?? name;
const G = (o) => { const g = { intent: 'new_expense', amount: null, amount_evidence: null, concept: null, category: null, method: null, date: null, changed_fields: [], clarification_question: null, ...o };
  return { ...g, category: g.category == null ? null : code(g.category) }; };
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

test('I-6 category must be in the database catalog; dates: no future, max 60 days back; an unknown or unstated method stays PENDING (never cash)', () => {
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Retiro socio' }), 'gasté 10', ctxNone).outcome, 'propose_pending');   // not in the catalog: subcategory pending
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: null }), 'gasté 10', ctxNone).request.payload.category_options.length, 0);
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos', date: '2026-10-23' }), 'gasté 10', ctxNone).outcome, 'bad_date');
  assert.equal(decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos', date: '2026-07-01' }), 'gasté 10', ctxNone).outcome, 'bad_date');
  const ch = decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos', method: 'CHEQUE' }), 'gasté 10 con cheque', ctxNone);
  assert.deepEqual([ch.outcome, ch.request.payload.method, ch.pending], ['propose_pending', undefined, ['method', 'account']]);
  const none = decide(G({ amount: 10, amount_evidence: '10', concept: 'x', category: 'Insumos' }), 'gasté 10', ctxNone);
  assert.deepEqual([none.request.payload.method, none.request.payload.account_id, none.pending], [undefined, undefined, ['method', 'account']]);
});

test('I-7 GPT can never confirm or cancel: whatever it answers, the only possible actions are propose / correct', () => {
  const intents = ['new_expense', 'correct_draft', 'clarify', 'confirm_request', 'cancel_request', 'status_query', 'help', 'other', 'confirm', 'register', ''];
  for (const intent of intents) for (const ctx of [ctxNone, ctxOpen]) {
    const d = decide(G({ intent, amount: 18000, amount_evidence: '18000', concept: 'X', category: 'Insumos', changed_fields: ['amount'] }), 'confirmá y registrá 18000', ctx);
    assert.ok(!d.request || ['propose', 'correct'].includes(d.request.action), intent);
  }
  assert.match(decide(G({ intent: 'confirm_request' }), 'sí', ctxOpen).reply, /botón del último resumen \(Confirmar/);
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
  assert.deepEqual(sent.borrador_abierto, { codigo: 'W-0009', estado: 'DRAFT', importe: 18, concepto: 'Combustible', categoria: 'Combustible', medio: 'CASH', fecha: '2026-10-22', pendiente: [] });
  const sch = body.text.format.schema;
  assert.equal(body.text.format.strict, true); assert.equal(sch.additionalProperties, false);
  assert.deepEqual([...sch.required].sort(), Object.keys(sch.properties).sort());
  assert.deepEqual(sch.properties.category.enum, ['S1', 'S2', 'S3', null]);
  assert.deepEqual(sent.categorias, [{ codigo: 'S1', categoria: null, subcategoria: 'Combustible' }, { codigo: 'S2', categoria: null, subcategoria: 'Insumos' }, { codigo: 'S3', categoria: null, subcategoria: 'Limpieza' }]);
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
  assert.deepEqual(m.changes, [{ field: 'method', from: 'CASH', to: 'TRANSFER' }, { field: 'account_id', from: 'acc-cash', to: 'acc-bna' },
    { field: 'date', from: '2026-10-22', to: '2026-10-21' }]);   // the only enabled bank account follows the method change
  const c = decide(G({ intent: 'correct_draft', changed_fields: ['category'], category: 'Limpieza' }), 'la categoría es limpieza', ctxOpen);
  // the concept "Combustible" IS the replaced subcategory → it follows (owner decision C03); a descriptive concept would stay (I-23)
  assert.deepEqual(c.changes, [{ field: 'concept', from: 'Combustible', to: 'Limpieza' }, { field: 'category_id', from: C4, to: 'c5' }]);
  assert.equal(decide(G({ amount: 500, amount_evidence: '500', concept: 'Pan', category: 'Insumos' }), 'gasté 500 en pan', ctxNone).changes, undefined);
});

test('I-12 help explains partial corrections (only what changes) and that registering is always the Confirm button', () => {
  const h = WAI.preRoute('ayuda', ctxNone).reply;
  assert.match(h, /decime solo lo que cambia/); assert.match(h, /eran 15 mil/); assert.match(h, /era transferencia/); assert.match(h, /tocá Confirmar/);
  assert.doesNotMatch(h, /mandá el gasto de nuevo/);
});

// ── live ERP catalog with hierarchy (category › subcategory); codes are per message, ids are the accounting key ──
const H = (cats) => ({ ok: true, open: null, waiting: [], catalog: { categories: cats, accounts: catalog.accounts } });
const NAFTA = { id: 'id-nafta', nombre: 'Nafta', grupo_id: 'g-comb', grupo: 'Combustible' };
const GASOIL = { id: 'id-gasoil', nombre: 'Gasoil', grupo_id: 'g-comb', grupo: 'Combustible' };
const MAIZ = { id: 'id-maiz', nombre: 'Maiz', grupo_id: 'g-ins', grupo: 'Insumos alimento balanceado' };
const pick = (cats, name) => WAI.options({ categories: cats }).find((o) => o.nombre === name).code;
const say = (cats, text, o) => decide({ ...G({ amount: 5000, amount_evidence: '5000', concept: 'x', ...o }), category: o.category === undefined ? null : o.category }, text, H(cats));

test('I-13 GPT receives the live hierarchy and answers a code; the code maps to the subcategory id (never the name)', () => {
  const cats = [NAFTA, GASOIL, MAIZ];
  const { body, sent } = WAI.buildRequest({ text: 'gasté 5000 de nafta', today: '2026-10-22', context: H(cats), model: 'm', effort: 'none' });
  assert.deepEqual(sent.categorias, [{ codigo: 'S1', categoria: 'Combustible', subcategoria: 'Nafta' }, { codigo: 'S2', categoria: 'Combustible', subcategoria: 'Gasoil' },
    { codigo: 'S3', categoria: 'Insumos alimento balanceado', subcategoria: 'Maiz' }]);
  assert.deepEqual(body.text.format.schema.properties.category.enum, ['S1', 'S2', 'S3', null]);
  assert.ok(!JSON.stringify(body).includes('id-nafta'), 'ids never go to OpenAI');
  assert.equal(say(cats, 'gasté 5000 de nafta', { category: pick(cats, 'Nafta') }).request.payload.category_id, 'id-nafta');
  assert.equal(say(cats, 'gasté 5000 de nafta', { category: 'Nafta' }).request.payload.category_id, undefined, 'a name is not a valid answer: subcategory pending');
  assert.equal(say(cats, 'gasté 5000 de nafta', { category: 'S9' }).request.payload.category_id, undefined, 'a code outside this catalog is invalid: pending');
});

test('I-14 catalog changes are picked up on the next message: new, renamed, moved, deactivated (no redeploy, no cache)', () => {
  const added = [NAFTA, GASOIL, MAIZ, { id: 'id-urea', nombre: 'Urea', grupo_id: 'g-fert', grupo: 'Fertilizantes' }];
  assert.equal(say(added, 'urea 5000', { category: pick(added, 'Urea') }).request.payload.category_id, 'id-urea');
  const renamed = [{ ...NAFTA, nombre: 'Nafta súper' }, GASOIL, MAIZ];
  const r = WAI.buildRequest({ text: 'x', today: '2026-10-22', context: H(renamed), model: 'm' }).sent.categorias[0];
  assert.deepEqual([r.subcategoria, say(renamed, 'nafta súper 5000', { category: pick(renamed, 'Nafta súper') }).request.payload.category_id], ['Nafta súper', 'id-nafta']);
  const moved = [NAFTA, { ...GASOIL, grupo_id: 'g-maq', grupo: 'Maquinaria' }, MAIZ];
  assert.equal(WAI.buildRequest({ text: 'x', today: '2026-10-22', context: H(moved), model: 'm' }).sent.categorias.find((c) => c.subcategoria === 'Gasoil').categoria, 'Maquinaria');
  const off = [NAFTA, MAIZ];   // Gasoil deactivated in the ERP: gone from the catalog, its old code now points elsewhere or nowhere
  assert.ok(!WAI.buildRequest({ text: 'x', today: '2026-10-22', context: H(off), model: 'm' }).sent.categorias.some((c) => c.subcategoria === 'Gasoil'));
  assert.equal(say(off, 'gasoil 5000', { category: 'S3' }).request.payload.category_id, undefined);
});

test('I-15 ambiguity: the message names a category with several subcategories but not which one → ask, never guess', () => {
  const cats = [NAFTA, GASOIL, MAIZ];
  const amb = say(cats, 'gasté 5000 en combustible', { category: pick(cats, 'Nafta') });
  assert.equal(amb.outcome, 'propose_pending'); assert.equal(amb.request.payload.category_id, undefined);
  assert.deepEqual(amb.request.payload.category_options, ['id-nafta', 'id-gasoil'], 'only the subcategories of the named category are offered');
  assert.equal(amb.request.payload.total, 5000, 'nothing is lost while the subcategory is asked');
  assert.equal(say(cats, 'gasté 5000 en nafta para la camioneta', { category: pick(cats, 'Nafta') }).request.payload.category_id, 'id-nafta');
  assert.equal(say(cats, 'combustible: gasoil 5000', { category: pick(cats, 'Gasoil') }).request.payload.category_id, 'id-gasoil');
  const one = [NAFTA, MAIZ];   // a category with ONE subcategory is not ambiguous
  assert.equal(say(one, 'gasté 5000 en combustible', { category: pick(one, 'Nafta') }).request.payload.category_id, 'id-nafta');
  const ask = say(cats, 'gasté 5000', { category: null });
  assert.equal(ask.outcome, 'propose_pending'); assert.deepEqual(ask.request.payload.category_options, [], 'nothing named: any subcategory may be chosen');
  const corr = decide(G({ intent: 'correct_draft', changed_fields: ['category'], category: pick(cats, 'Gasoil') }), 'era combustible', { ...H(cats), open: { ...open, payload: { ...open.payload, category_id: 'id-maiz' } } });
  assert.equal(corr.outcome, 'ambiguous_category', 'corrections are checked too');
});

// ── live paying accounts (D-3): never hard-coded, never sent to OpenAI, chosen only when named, otherwise asked ──
const A = (accounts) => ({ ok: true, open: null, waiting: [], catalog: { categories: catalog.categories, accounts } });
const CAJA = { id: 'acc-cash', nombre: 'Caja chica', account_type: 'CASH', method: 'CASH' };
const BNA = { id: 'acc-bna', nombre: 'BNA', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' };
const PAT = { id: 'acc-pat', nombre: 'Patagonia', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' };
const MP = { id: 'acc-mp', nombre: 'Mercado Pago', account_type: 'EXTERNAL_SERVICE', method: 'MERCADOPAGO' };
const tr = (text, accounts, o = {}) => decide(G({ amount: 5000, amount_evidence: '5000', concept: 'flete', category: 'Insumos', method: 'TRANSFER', ...o }), text, A(accounts));

test('I-16 transfer with several enabled bank accounts and none named → draft WITHOUT account (not confirmable) and ask; named → that one', () => {
  const pend = tr('transferí 5000 por el flete', [CAJA, BNA, PAT, MP]);
  assert.equal(pend.outcome, 'propose_pending'); assert.deepEqual(pend.pending, ['account']); assert.equal(pend.request.payload.account_id, undefined); assert.equal(pend.request.payload.method, 'TRANSFER');
  assert.equal(tr('transferí 5000 desde Patagonia', [CAJA, BNA, PAT, MP]).request.payload.account_id, 'acc-pat');
  assert.equal(tr('pagué 5000 por bna', [CAJA, BNA, PAT, MP]).request.payload.account_id, 'acc-bna');
  assert.deepEqual(tr('transferí 5000 desde BNA o Patagonia', [CAJA, BNA, PAT, MP]).pending, ['account'], 'two named: not unambiguous, ask');
  assert.equal(tr('transferí 5000', [CAJA, BNA, MP]).request.payload.account_id, 'acc-bna', 'only one enabled bank account: no question');
  // naming an account decides the method; a contradiction is asked, never guessed
  assert.equal(tr('5000 desde patagonia', [CAJA, BNA, PAT, MP], { method: null }).request.payload.method, 'TRANSFER');
  assert.equal(tr('5000 en efectivo desde patagonia', [CAJA, BNA, PAT, MP], { method: 'CASH' }).outcome, 'account_method_mismatch');
  assert.equal(tr('transferí 5000', [CAJA, MP]).outcome, 'no_account');
});

test('I-17 accounts are live: added, renamed and removed accounts change the behaviour without redeploy; names never reach OpenAI', () => {
  assert.equal(tr('transferí 5000 desde Banco Nuevo', [CAJA, BNA, PAT, { id: 'acc-new', nombre: 'Banco Nuevo', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' }]).request.payload.account_id, 'acc-new');
  assert.equal(tr('transferí 5000 desde Patagonia SA', [CAJA, BNA, { ...PAT, nombre: 'Patagonia SA' }]).request.payload.account_id, 'acc-pat');
  assert.equal(tr('transferí 5000 desde patagonia', [CAJA, BNA]).request.payload.account_id, 'acc-bna', 'Patagonia disabled: the only bank left');
  const body = WAI.buildRequest({ text: 'transferí 5000', today: '2026-10-22', context: A([CAJA, BNA, PAT, MP]), model: 'm' }).body;
  assert.ok(!/acc-|Caja chica|BNA|Patagonia/.test(JSON.stringify(body)), 'no account id or name in the OpenAI request');
  // older context without the method field (staging before upgrade-004): the method comes from the account TYPE, never from a name
  assert.equal(tr('transferí 5000 desde patagonia', [{ ...BNA, method: undefined }, { ...PAT, method: undefined }]).request.payload.account_id, 'acc-pat');
});

test('I-18 account-only correction: the pending account is answered with its name (no GPT), or changed later, keeping amount / concept / category', () => {
  const draft = { draft_id: D, short_code: 'W-0030', state: 'DRAFT', version: 1,
    payload: { date: '2026-10-22', total: 5000, concept: 'flete', category_id: C1, nature: 'OPERATING', method: 'TRANSFER', account_pending: true, needs_mp: false } };
  const ctx = { ...A([CAJA, BNA, PAT, MP]), open: draft };
  const pre = WAI.preRoute('Patagonia', ctx);
  assert.equal(pre.request.action, 'correct'); assert.equal(pre.request.expected_version, 1);
  assert.deepEqual(pre.request.payload, { date: '2026-10-22', total: 5000, concept: 'flete', category_id: C1, nature: 'OPERATING', method: 'TRANSFER', account_id: 'acc-pat' });
  assert.deepEqual(pre.changes, [{ field: 'account_id', from: null, to: 'acc-pat' }]);
  assert.equal(WAI.preRoute('cualquiera de los dos', ctx), null, 'not unambiguous: GPT / ask again');
  const set = { ...draft, version: 2, payload: { ...draft.payload, account_pending: undefined, account_id: 'acc-pat' } };
  delete set.payload.account_pending;
  const fix = decide(G({ intent: 'correct_draft', changed_fields: [] }), 'no, era BNA', { ...ctx, open: set });
  assert.deepEqual([fix.request.payload.account_id, fix.request.payload.total, fix.request.payload.concept, fix.request.payload.category_id], ['acc-bna', 5000, 'flete', C1]);
  assert.deepEqual(fix.changes, [{ field: 'account_id', from: 'acc-pat', to: 'acc-bna' }]);
  const cash = decide(G({ intent: 'correct_draft', changed_fields: ['method'], method: 'TRANSFER' }), 'era transferencia', { ...ctx, open: { ...set, payload: { ...set.payload, method: 'CASH', account_id: 'acc-cash' } } });
  assert.equal(cash.request.payload.account_id, undefined, 'cash to transfer with two banks: the account becomes pending (asked)');
});

test('I-19 safe account selection: whole phrases only, the most specific wins, any remaining ambiguity is asked (never auto-selected)', () => {
  const CAJA1 = { id: 'acc-caja', nombre: 'Caja', account_type: 'CASH', method: 'CASH' };
  // no prefix / partial-word match: "cajas" is not the account "Caja"; "pago ... mercado" is not "Mercado Pago"
  assert.equal(tr('compré cajas por 5000', [CAJA1, BNA, PAT], { method: 'TRANSFER' }).request.payload.account_id, undefined);
  assert.equal(tr('hice el pago en el mercado 5000', [CAJA, BNA, MP], { method: null }).request.payload.method, undefined, 'Mercado Pago not inferred from scattered words (and no cash default)');
  // the most specific phrase wins; two different accounts named → ask
  const BANCO = { id: 'acc-banco', nombre: 'Banco', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' };
  const NACION = { id: 'acc-nacion', nombre: 'Banco Nación', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' };
  assert.equal(tr('transferí 5000 desde el banco nación', [BANCO, NACION]).request.payload.account_id, 'acc-nacion');
  assert.equal(tr('transferí 5000 desde el banco', [BANCO, NACION]).request.payload.account_id, 'acc-banco');
  // similar names (future accounts)
  const PATS = { id: 'acc-pats', nombre: 'Patagonia Sueldos', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' };
  assert.equal(tr('transferí 5000 desde patagonia', [BNA, PAT, PATS]).request.payload.account_id, 'acc-pat');
  assert.equal(tr('transferí 5000 desde patagonia sueldos', [BNA, PAT, PATS]).request.payload.account_id, 'acc-pats');
  assert.deepEqual(tr('transferí 5000 desde bna y patagonia', [BNA, PAT, PATS]).pending, ['account']);
  // the chosen account always resolves to its stable id (never a name); the database re-validates it
  assert.match(tr('transferí 5000 desde patagonia', [BNA, PAT]).request.payload.account_id, /^acc-pat$/);
});

test('I-20 several clarifications on one draft (ambiguous subcategory AND account): nothing lost, each answer sets only its datum', () => {
  const cats = [NAFTA, GASOIL, MAIZ];
  const ctxOf = (open) => ({ ok: true, open, waiting: [], catalog: { categories: cats, accounts: [CAJA, BNA, PAT, MP] } });
  const gpt = { ...G({ amount: 5000, amount_evidence: '5000', concept: 'combustible', method: 'TRANSFER' }), category: pick(cats, 'Nafta') };   // GPT guessed Nafta
  const first = decide(gpt, 'transferí 5000 en combustible', ctxOf(null));
  assert.equal(first.outcome, 'propose_pending'); assert.deepEqual(first.pending, ['category', 'account']);
  assert.deepEqual(first.request.payload.category_options, ['id-nafta', 'id-gasoil']); assert.equal(first.request.payload.account_id, undefined);
  // the database stores it as a draft with both data pending
  const d1 = { draft_id: D, short_code: 'W-0040', state: 'DRAFT', version: 1,
    payload: { ...first.request.payload, category_pending: true, account_pending: true, needs_mp: false } };
  const a1 = WAI.preRoute('nafta', ctxOf(d1));   // answers only the subcategory (deterministic, no GPT)
  assert.equal(a1.request.action, 'correct'); assert.equal(a1.request.payload.category_id, 'id-nafta'); assert.equal(a1.request.payload.category_options, undefined);
  assert.equal(a1.request.payload.account_pending, true, 'the account is still pending');
  assert.deepEqual([a1.request.payload.total, a1.request.payload.concept, a1.request.payload.date], [5000, 'combustible', first.request.payload.date]);
  const d2 = { ...d1, version: 2, payload: { ...a1.request.payload, needs_mp: false } };
  const a2 = WAI.preRoute('desde patagonia', ctxOf(d2));
  assert.equal(a2.request.payload.account_id, 'acc-pat'); assert.equal(a2.request.payload.account_pending, undefined); assert.equal(a2.request.payload.category_id, 'id-nafta');
  // both in one message
  const both = WAI.preRoute('gasoil, desde bna', ctxOf(d1));
  assert.deepEqual([both.request.payload.category_id, both.request.payload.account_id], ['id-gasoil', 'acc-bna']);
  // an answer outside the offered options does not set anything (MAIZ is not an option of this draft) → GPT / asked again
  assert.equal(WAI.preRoute('maiz', ctxOf({ ...d1, payload: { ...d1.payload } })), null);
});

test('I-21 answering the question: a word that identifies ONE offered account / subcategory is enough; a word shared by several is not', () => {
  const GAL = { id: 'acc-gal', nombre: 'Banco Galicia', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' };
  const NAC = { id: 'acc-nac', nombre: 'Banco Nación', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' };
  const draft = { draft_id: D, short_code: 'W-0050', state: 'DRAFT', version: 1,
    payload: { date: '2026-10-22', total: 4000, concept: 'flete', category_id: C1, nature: 'OPERATING', method: 'TRANSFER', account_pending: true, needs_mp: false } };
  const ctx = (accounts) => ({ ok: true, open: draft, waiting: [], catalog: { categories: catalog.categories, accounts } });
  assert.equal(WAI.preRoute('galicia', ctx([GAL, NAC])).request.payload.account_id, 'acc-gal');
  assert.equal(WAI.preRoute('nación', ctx([GAL, NAC])).request.payload.account_id, 'acc-nac');
  assert.equal(WAI.preRoute('el banco', ctx([GAL, NAC])), null, '"banco" is in both offered names: ambiguous, asked again');
  assert.equal(WAI.preRoute('galicia', ctx([GAL, NAC, CAJA])).request.payload.account_id, 'acc-gal', 'only accounts of the draft method are offered');
  // the first message still needs the full name (a single word could be anything): "transferí desde galicia" → asked
  assert.deepEqual(tr('transferí 5000 desde galicia', [GAL, NAC]).pending, ['account']);
});

// owner decisions C01 / C03 (real evaluation 2026-10-23): GPT may not rewrite fields the user did not ask to change
const PAT2 = { id: 'acc-pat', nombre: 'Patagonia', account_type: 'BANK_ACCOUNT' };
const fuel = { categories: [{ id: 'g1', nombre: 'Gasoil', grupo: 'Combustible' }, { id: 'g2', nombre: 'Nafta', grupo: 'Combustible' }, { id: 'c5', nombre: 'Limpieza', grupo: 'Servicios' }],
  accounts: [...catalog.accounts, PAT2] };
const fuelCode = (n) => WAI.options(fuel).find((x) => x.nombre === n).code;
const draftOf = (concept, extra = {}) => ({ ok: true, waiting: [], catalog: fuel, open: { draft_id: D, short_code: 'W-0042', state: 'DRAFT', version: 2,
  payload: { date: '2026-10-22', total: 18000, concept, category_id: 'g2', nature: 'OPERATING', account_id: 'acc-cash', method: 'CASH', needs_mp: false, ...extra } } });
const KEEP = (p) => [p.total, p.concept, p.category_id, p.date, p.nature];

test('I-22 C01: a message that only names the account changes ONLY the account and its method (GPT concept / amount / category / date ignored)', () => {
  const base = draftOf('Nafta');
  for (const [text, gpt] of [
    ['era Patagonia', { changed_fields: ['concept'], concept: 'Patagonia' }],                                   // the real C01 answer
    ['no, era desde Patagonia', { changed_fields: ['concept', 'date'], concept: 'Patagonia', date: '2026-10-21' }],
    ['perdón, fue por transferencia desde patagonia', { changed_fields: ['method', 'category'], method: 'TRANSFER', category: fuelCode('Gasoil') }],
    ['era BNA', { changed_fields: ['concept', 'amount'], concept: 'BNA', amount: 18000, amount_evidence: '18000' }]]) {
    const d = decide({ ...G({ intent: 'correct_draft' }), ...gpt }, text, base);
    assert.equal(d.request?.action, 'correct', text);
    const p = d.request.payload;
    assert.deepEqual(KEEP(p), KEEP(base.open.payload), text + ': untouched fields');
    assert.equal(p.method, 'TRANSFER', text);
    assert.deepEqual(d.changes.map((c) => c.field), ['method', 'account_id'], text);
  }
  // the account plus another datum the user DID say: both change (amount evidence is in the message)
  const both = decide(G({ intent: 'correct_draft', changed_fields: ['amount'], amount: 15000, amount_evidence: '15mil' }), 'eran 15mil desde Patagonia', base);
  assert.deepEqual([both.request.payload.total, both.request.payload.account_id, both.request.payload.concept], [15000, 'acc-pat', 'Nafta']);
  // naming the account the draft already has: nothing changes
  assert.equal(decide(G({ intent: 'correct_draft', changed_fields: ['concept'], concept: 'Patagonia' }), 'era Patagonia',
    draftOf('Nafta', { account_id: 'acc-pat', method: 'TRANSFER' })).outcome, 'no_change');
});

test('I-23 C03: on a subcategory correction the concept follows ONLY if it is exactly the replaced subcategory; GPT concept never used', () => {
  const g = G({ intent: 'correct_draft', changed_fields: ['concept', 'category'], concept: 'gasoil' }); g.category = fuelCode('Gasoil');
  const a = decide(g, 'era gasoil', draftOf('Nafta'));                                   // "Nafta" names the replaced subcategory
  assert.deepEqual([a.request.payload.concept, a.request.payload.category_id], ['Gasoil', 'g1']);
  assert.deepEqual(a.changes.map((c) => c.field), ['concept', 'category_id']);
  assert.deepEqual([a.request.payload.total, a.request.payload.date, a.request.payload.account_id], [18000, '2026-10-22', 'acc-cash']);
  for (const concept of ['Combustible para tractor', 'nafta para el tractor', 'Carga de combustible']) {   // descriptive → kept
    const d = decide(g, 'era gasoil', draftOf(concept));
    assert.deepEqual([d.request.payload.concept, d.request.payload.category_id], [concept, 'g1'], concept);
    assert.deepEqual(d.changes.map((c) => c.field), ['category_id'], concept);
  }
  assert.equal(decide(g, 'era gasoil', draftOf('NAFTA')).request.payload.concept, 'Gasoil');   // case / accents do not matter
  // pending subcategory (no previous one): the concept is kept
  const pend = draftOf('combustible', { category_id: undefined, category_pending: true, category_options: ['g1', 'g2'] });
  delete pend.open.payload.category_id;
  assert.equal(decide(g, 'era gasoil', pend).request.payload.concept, 'combustible');
});

test('I-24 a concept correction is accepted only with its words in the message; GPT rewrites are dropped', () => {
  const ok = decide(G({ intent: 'correct_draft', changed_fields: ['concept'], concept: 'Gasoil tractor' }), 'el concepto es gasoil tractor', draftOf('Nafta'));
  assert.deepEqual([ok.request.payload.concept, ok.request.payload.category_id], ['Gasoil tractor', 'g2']);
  const inv = decide(G({ intent: 'correct_draft', changed_fields: ['concept'], concept: 'Combustible premium' }), 'cambialo', draftOf('Nafta'));
  assert.equal(inv.request, undefined); assert.equal(inv.outcome, 'nothing_to_correct');
  // an invented concept riding along a legitimate date correction is dropped; the date changes alone
  const mix = decide(G({ intent: 'correct_draft', changed_fields: ['date', 'concept'], date: '2026-10-21', concept: 'Gasoil' }), 'no, fue ayer', draftOf('Nafta'));
  assert.deepEqual(mix.changes.map((c) => c.field), ['date']);
});
