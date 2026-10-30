// ADR-025 — unit tests of the n8n staging logic (node --test n8n/logic.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const WA = new Function(readFileSync(new URL('./logic.js', import.meta.url), 'utf8') + '\nreturn WA;')();
const CFG = { default_category_id: 'c1', categories: [{ id: 'c1', nombre: 'Insumos', keywords: ['insumo', 'alimento'] }, { id: 'c9', nombre: 'Combustible', keywords: ['nafta', 'combustible'] }],
  accounts: { CASH: { id: 'acc-cash', nombre: 'Caja chica' }, TRANSFER: { id: 'acc-bna', nombre: 'BNA' }, MERCADOPAGO: { id: 'acc-mp', nombre: 'Mercado Pago' } } };
const D = '11111111-2222-4333-8444-555555555555';
const ev = (o) => ({ type: 'wa.message', inbound_id: 10, kind: 'text', phone: '+5491155551234', cap: 'v1.10.1800000900.' + 'c'.repeat(64), ...o });

const CAP = 'v1.10.1800000900.' + 'c'.repeat(64);
test('L-1 verify: fresh ts, single-use nonce, well-formed event with capability', () => {
  const event = ev({ text: 'hola' }), ts = '1800000000', nonce = 'ab'.repeat(8), seen = {};
  assert.equal(WA.verify({ ts, nonce, event }, 1800000010, seen).ok, true);
  assert.equal(WA.verify({ ts, nonce, event }, 1800000011, seen).reason, 'nonce_replay');
  assert.equal(WA.verify({ ts, nonce: 'cd'.repeat(8), event }, 1800000400, seen).reason, 'stale');
  assert.equal(WA.verify({ ts, nonce: 'ef'.repeat(8), event: { ...event, cap: 'forged' } }, 1800000010, seen).reason, 'event');
  assert.equal(WA.verify({ ts, nonce: '12'.repeat(8), event: { ...event, inbound_id: 'x' } }, 1800000010, seen).reason, 'event');
  assert.equal(WA.verify({ ts: 'x', nonce, event }, 1800000010, seen).reason, 'format');
  WA.verify({ ts: '1800002000', nonce: '34'.repeat(8), event }, 1800002000, seen);            // later call purges expired nonces
  assert.equal(seen['ab'.repeat(8)], undefined);
});

test('L-2 the old rule parser is gone (no fallback): no parseAmount / interpret exported', () => {
  assert.equal(WA.parseAmount, undefined); assert.equal(WA.interpret, undefined);
});

test('L-4 route: buttons act directly; every text first asks the database context; non-text / empty → reply', () => {
  assert.deepEqual(WA.route(ev({ kind: 'interactive', button_payload: `CONFIRM:${D}:3` }), CFG).request,
    { action: 'confirm', inbound_id: 10, cap: CAP, draft_id: D, expected_version: 3 });
  assert.equal(WA.route(ev({ kind: 'interactive', button_payload: `CANCEL:${D}:1` }), CFG).request.action, 'cancel');
  assert.equal(WA.route(ev({ kind: 'interactive', button_payload: 'CONFIRM:x:1' }), CFG).reply, 'Ese botón no es válido.');
  for (const text of ['gaste 18mil en combustible', 'corregi el importe a 18000', 'cancelar', 'mp 930000025001', 'ayuda']) {
    const r = WA.route(ev({ text }), CFG);
    assert.deepEqual(r.request, { action: 'context', inbound_id: 10, cap: CAP }, text);
    assert.equal(r.text, text);
  }
  assert.match(WA.route(ev({ kind: 'audio' }), CFG).reply, /solo proceso mensajes de texto/);
  assert.match(WA.route(ev({ text: '   ' }), CFG).reply, /Mandame el gasto/);
});

test('L-7 Argentine mobile 9 stripped only when configured', () => {
  assert.equal(WA.toNumber('+5491155551234', { ar_strip_9: true }), '541155551234');
  assert.equal(WA.toNumber('+5491155551234', {}), '5491155551234');
  assert.equal(WA.toNumber('+14155550100', { ar_strip_9: true }), '14155550100');
});

test('L-5 prepare: raw body + ts / nonce headers, no secret; sha256 = node crypto', () => {
  const p = WA.prepare({ action: 'expire' }, 1800000000, 'cd'.repeat(8));
  assert.deepEqual(p, { raw: '{"action":"expire"}', headers: { 'content-type': 'application/json', 'x-wa-timestamp': '1800000000', 'x-wa-nonce': 'cd'.repeat(8) } });
  assert.match(WA.nonce(), /^[0-9a-f]{32}$/);
  for (const v of ['', '+5491155551234', 'ñandú'.repeat(50)]) assert.equal(WA.sha256Hex(v), createHash('sha256').update(v, 'utf8').digest('hex'));
});

test('L-6 compose: DRAFT buttons carry id+version; state transitions; errors in Spanish; replays silent', () => {
  const ctx = { to: '549115', request: { action: 'propose' } };
  const r = { ok: true, draft_id: D, short_code: 'W-0001', state: 'DRAFT', version: 2, possible_duplicates: 1,
    payload: { total: 1600, concept: 'Alimento', category_id: 'c1', account_id: 'acc-cash', method: 'CASH', date: '2026-10-21' } };
  const c = WA.compose(ctx, 200, { ok: true, result: r }, null, CFG);
  assert.deepEqual(c.graph.interactive.action.buttons.map((b) => b.reply.id), [`CONFIRM:${D}:2`, `CANCEL:${D}:2`]);
  assert.match(c.graph.interactive.body.text, /\$ 1\.600,00/); assert.match(c.graph.interactive.body.text, /Caja chica/); assert.match(c.graph.interactive.body.text, /parecido/);
  assert.deepEqual(c.state.open, { draft_id: D, version: 2, state: 'DRAFT', code: 'W-0001' });
  const done = WA.compose({ to: '1', request: { action: 'confirm', draft_id: D } }, 200, { ok: true, result: { ok: true, state: 'CONFIRMED', draft_id: D, short_code: 'W-0001' } }, c.state, CFG);
  assert.equal(done.state.open, null); assert.match(done.graph.text.body, /Registrado W-0001/);
  const failed = WA.compose({ to: '1', request: { action: 'confirm', draft_id: D, expected_version: 2 } }, 200, { ok: true, result: { ok: false, draft_id: D, short_code: 'W-0001', error: 'DUPLICATE_FISCAL_DOCUMENT' } }, c.state, CFG);
  assert.equal(failed.state.open.state, 'FAILED');
  const wait = WA.compose(ctx, 200, { ok: true, result: { ...r, state: 'WAITING_MP', version: 1 } }, null, CFG);
  assert.equal(wait.state.waiting.length, 1); assert.equal(wait.graph.type, 'text');
  const e = WA.compose({ to: '1', request: { action: 'propose' } }, 422, { ok: false, error: { code: 'WA_OPEN_DRAFT_EXISTS' } }, null, CFG);
  assert.match(e.graph.text.body, /borrador abierto/);
  assert.equal(WA.compose({ to: '1', request: { action: 'confirm' } }, 422, { ok: false, error: { code: 'WA_MESSAGE_ALREADY_USED' } }, null, CFG).graph, null);
  assert.equal(WA.compose({ to: '1', request: { action: 'expire' } }, 200, { ok: true, result: { ok: true, expired: 2 } }, null, CFG).graph, null);
  assert.match(WA.compose({ to: '1', request: { action: 'confirm' } }, 502, { ok: false }, null, CFG).graph.text.body, /problema técnico/);
  const exp = WA.compose({ to: '1', request: { action: 'confirm', draft_id: D } }, 200, { ok: true, result: { ok: false, error: 'WA_DRAFT_EXPIRED' } }, c.state, CFG);
  assert.equal(exp.state.open, null);
});

test('L-7 correction header + marked fields; duplicate references (same category ⚠ / other ℹ); buttons of the new version; new texts', () => {
  const ctx = { to: '549115', request: { action: 'correct', draft_id: D }, changes: [{ field: 'total', from: 18000, to: 15000 }] };
  const r = { ok: true, draft_id: D, short_code: 'W-0011', state: 'DRAFT', version: 2, possible_duplicates: 1,
    duplicates: [{ date: '2026-10-22', total: 15000, same_category: false, ref: 'W-0007', category: 'Insumos', concept: 'Alimento y' }],
    payload: { total: 15000, concept: 'combustible', category_id: 'c9', account_id: 'acc-cash', method: 'CASH', date: '2026-10-22' } };
  const t = WA.compose(ctx, 200, { ok: true, result: r }, null, CFG).graph;
  const b = t.interactive.body.text;
  assert.ok(b.startsWith('✏️ Corregí W-0011 (v2): Importe $ 18.000,00 → $ 15.000,00\n\nBorrador W-0011 (v2)'), b);
  assert.match(b, /Total: \$ 15\.000,00 ✏️\n/); assert.match(b, /Concepto: combustible\n/);        // only the corrected line is marked
  assert.match(b, /ℹ Mismo importe y fecha cercana: W-0007 · Alimento y · \$ 15\.000,00 · 22\/10 \(Insumos\)\. Si es otro gasto, confirmá igual\./);
  assert.doesNotMatch(b, /⚠|mandá el gasto de nuevo|parecido/); assert.match(b, /decime solo lo que cambia/);
  assert.deepEqual(t.interactive.action.buttons.map((x) => x.reply.id), [`CONFIRM:${D}:2`, `CANCEL:${D}:2`]);
  assert.ok(b.length <= 1024, String(b.length));
  // same category → ⚠ ; a non-ADMIN view (no ref / concept / category) still names date and amount; more matches than shown
  const s = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { ok: true, result: { ...r, version: 1, possible_duplicates: 4,
    duplicates: [{ date: '2026-10-21', total: 15000, same_category: true, ref: 'W-0003', category: 'Combustible', concept: 'Nafta' }, { date: '2026-10-22', total: 15000, same_category: false }] } }, null, CFG).graph.interactive.body.text;
  assert.match(s, /⚠ Posible duplicado: W-0003 · Nafta · \$ 15\.000,00 · 21\/10 \(Combustible\)/); assert.match(s, /ℹ Mismo importe y fecha cercana: \$ 15\.000,00 · 22\/10\./);
  assert.match(s, /\(\+2 más\)/); assert.doesNotMatch(s, /Corregí/);
  // method + category corrections are labelled with names, not ids
  const mc = WA.compose({ to: '1', request: { action: 'correct' }, changes: [{ field: 'method', from: 'CASH', to: 'TRANSFER' }, { field: 'category_id', from: 'c1', to: 'c9' }] },
    200, { ok: true, result: { ...r, duplicates: [], possible_duplicates: 0 } }, null, CFG).graph.interactive.body.text;
  assert.match(mc, /Pago Efectivo → Transferencia; Categoría Insumos → Combustible/); assert.doesNotMatch(mc, /c1|c9 /);
  const failed = WA.compose({ to: '1', request: { action: 'confirm', draft_id: D, expected_version: 2 } }, 200, { ok: true, result: { ok: false, draft_id: D, short_code: 'W-0011', error: 'X' } }, null, CFG);
  assert.match(failed.graph.text.body, /Decime qué corregir o escribí "cancelar"/);
});

test('L-8 live hierarchy in texts; a subcategory deactivated before confirming → clear message, draft kept for a category-only correction', () => {
  const cfg = { categories: [{ id: 'id-nafta', nombre: 'Nafta', grupo: 'Combustible' }, { id: 'id-gasoil', nombre: 'Gasoil', grupo: 'Combustible' }], accounts: CFG.accounts };
  const r = { ok: true, draft_id: D, short_code: 'W-0020', state: 'DRAFT', version: 2, possible_duplicates: 0, duplicates: [],
    payload: { total: 5000, concept: 'nafta', category_id: 'id-gasoil', account_id: 'acc-cash', method: 'CASH', date: '2026-10-22' } };
  const b = WA.compose({ to: '1', request: { action: 'correct' }, changes: [{ field: 'category_id', from: 'id-nafta', to: 'id-gasoil' }] }, 200, { ok: true, result: r }, null, cfg).graph.interactive.body.text;
  assert.match(b, /Categoría Combustible › Nafta → Combustible › Gasoil/); assert.match(b, /Categoría: Combustible › Gasoil ✏️/);
  const gone = WA.compose({ to: '1', request: { action: 'confirm', draft_id: D, expected_version: 2 } }, 200,
    { ok: true, result: { ok: false, draft_id: D, short_code: 'W-0020', error: 'WA_CATEGORY_NOT_SELECTABLE: subcategory Gasoil is inactive' } }, null, cfg);
  assert.match(gone.graph.text.body, /W-0020: la subcategoría elegida ya no está disponible.*el resto del gasto se mantiene/s);
  assert.equal(gone.state.open.state, 'FAILED');
  const refused = WA.compose({ to: '1', request: { action: 'propose' } }, 422, { ok: false, error: { code: 'WA_CATEGORY_NOT_SELECTABLE' } }, null, cfg);
  assert.match(refused.graph.text.body, /ya no está disponible/);
});

test('L-9 a draft whose account is pending has NO confirm button and asks which account; account errors are explained', () => {
  const cfg = { categories: CFG.categories, accounts: { 'acc-bna': { id: 'acc-bna', nombre: 'BNA', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' },
    'acc-pat': { id: 'acc-pat', nombre: 'Patagonia', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' }, 'acc-cash': { id: 'acc-cash', nombre: 'Caja chica', account_type: 'CASH', method: 'CASH' } } };
  const r = { ok: true, draft_id: D, short_code: 'W-0030', state: 'DRAFT', version: 1, possible_duplicates: 0, duplicates: [],
    payload: { total: 5000, concept: 'flete', category_id: 'c1', method: 'TRANSFER', account_pending: true, date: '2026-10-22' } };
  const g = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { ok: true, result: r }, null, cfg).graph;
  assert.equal(g.type, 'text', 'no interactive confirm button while the account is pending');
  assert.match(g.text.body, /Pago: Transferencia \(cuenta a elegir\)/); assert.match(g.text.body, /¿Desde qué cuenta lo pagaste\? BNA o Patagonia\./);
  const set = WA.compose({ to: '1', request: { action: 'correct' }, changes: [{ field: 'account_id', from: null, to: 'acc-pat' }] }, 200,
    { ok: true, result: { ...r, version: 2, payload: { ...r.payload, account_pending: undefined, account_id: 'acc-pat' } } }, null, cfg).graph;
  assert.equal(set.type, 'interactive'); assert.match(set.interactive.body.text, /Cuenta \(sin elegir\) → Patagonia/); assert.match(set.interactive.body.text, /Transferencia \(Patagonia\) ✏️/);
  assert.match(WA.compose({ to: '1', request: { action: 'confirm' } }, 422, { ok: false, error: { code: 'WA_ACCOUNT_REQUIRED' } }, null, cfg).graph.text.body, /desde qué cuenta/);
  const gone = WA.compose({ to: '1', request: { action: 'confirm', draft_id: D, expected_version: 2 } }, 200,
    { ok: true, result: { ok: false, draft_id: D, short_code: 'W-0030', error: 'WA_ACCOUNT_NOT_SELECTABLE: account Patagonia is inactive' } }, null, cfg);
  assert.match(gone.graph.text.body, /la cuenta elegida ya no está habilitada.*el resto del gasto se mantiene/s); assert.equal(gone.state.open.state, 'FAILED');
});

test('L-10 "Confirmar sin clasificar": route, buttons only when the subcategory is the ONLY datum left, texts', () => {
  assert.deepEqual(WA.route(ev({ kind: 'interactive', button_payload: `UNCLASSIFIED:${D}:4` }), CFG).request,
    { action: 'confirm', inbound_id: 10, cap: CAP, draft_id: D, expected_version: 4 });
  assert.equal(WA.route(ev({ kind: 'interactive', button_payload: `UNCLASSIFIED:${D}:x` }), CFG).reply, 'Ese botón no es válido.');
  const base = { ok: true, draft_id: D, short_code: 'W-0005', state: 'DRAFT', version: 1, possible_duplicates: 0 };
  const pay = { date: '2026-10-22', total: 3000, concept: 'algo', method: 'CASH', category_pending: true, category_options: [] };
  const only = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { ok: true, result: { ...base, payload: { ...pay, account_id: 'acc-cash' } } }, null, CFG).graph;
  assert.deepEqual(only.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [[`UNCLASSIFIED:${D}:1`, 'Registrar sin clasif'], [`CANCEL:${D}:1`, 'Cancelar']]);
  assert.match(only.interactive.body.text, /¿En qué categoría va\?/);
  const noAcc = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { ok: true, result: { ...base, payload: { ...pay, method: 'TRANSFER', account_pending: true } } }, null, CFG).graph;
  assert.equal(noAcc.type, 'text', 'financial data incomplete: no confirmation offered');
  const done = WA.compose({ to: '1', request: { action: 'confirm', draft_id: D } }, 200, { ok: true, result: { ok: true, state: 'CONFIRMED', unclassified: true, draft_id: D,
    short_code: 'W-0005', result: { unclassified: true, financial_effect: 'PAYMENT_POSTED', amount: 3000 } } }, null, CFG).graph;
  assert.match(done.text.body, /Registré el egreso W-0005 de \$ 3\.000,00: ya descuenta de la cuenta\. Queda SIN CLASIFICAR/);
  assert.equal(WA.compose({ to: '1', request: { action: 'confirm', draft_id: D } }, 422, { ok: false, error: { code: 'WA_UNCLASSIFIED_NOT_ALLOWED' } }, null, CFG).graph.text.body,
    'Ese borrador ya tiene subcategoría: usá el botón Confirmar del último resumen.');
});

// ── Lote 4 (0111): Mercado Pago confirmed without the operation number; the invoice details asked before any confirmation ──
const WAR4 = new Function(readFileSync(new URL('./receipt.js', import.meta.url), 'utf8') + '\nreturn WAR;')();
const WAI4 = new Function('WAR', readFileSync(new URL('./interpreter.js', import.meta.url), 'utf8') + '\nreturn WAI;')(WAR4);
const ctx4 = { to: '5491155551234', request: { action: 'confirm', draft_id: D, expected_version: 1 } };

test('L4-L1 a Mercado Pago expense confirmed without its movement: in the P&L now, movement pending link, no number asked', () => {
  const r = { ok: true, draft_id: D, short_code: 'W-0012', state: 'CONFIRMED', mp_link_pending: true,
    result: { mp_link_pending: true, financial_effect: 'NONE', amount: 70637.06, purchase_id: 'p1', fiscal_document_id: 'f1', status: 'PENDIENTE_VINCULACION_MP' } };
  const c = WA.compose(ctx4, 200, { result: r }, { open: { draft_id: D }, waiting: [] }, CFG);
  assert.match(c.graph.text.body, /ya figura en resultados y su IVA en Fiscal/);
  assert.match(c.graph.text.body, /PENDIENTE DE VINCULAR/);
  assert.match(c.graph.text.body, /no hace falta el número de operación/i);
  assert.doesNotMatch(c.graph.text.body, /mp <número/);
  assert.equal(c.state.open, null);
});

test('L4-L2 a draft paid with Mercado Pago is confirmable (Confirmar button) and says it links later; never "Registrar sin clasif" while unlinked', () => {
  const p = { total: 500, concept: 'Gasoil', category_id: 'c9', method: 'MERCADOPAGO', account_id: 'acc-mp', mp_link_pending: true, date: '2026-10-22' };
  const ok = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { result: { ok: true, draft_id: D, short_code: 'W-0012', version: 1, state: 'DRAFT', payload: p } }, null, CFG);
  assert.equal(ok.graph.interactive.action.buttons[0].reply.id, 'CONFIRM:' + D + ':1');
  assert.match(ok.graph.interactive.body.text, /se vincula después en el ERP/);
  const onlyCat = { ...p, category_id: undefined, category_pending: true, category_options: [] };
  const c = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { result: { ok: true, draft_id: D, short_code: 'W-0012', version: 1, state: 'DRAFT', payload: onlyCat } }, null, CFG);
  assert.equal(c.graph.type, 'text');   // the subcategory is asked; no UNCLASSIFIED button without the linked outflow
});

test('L4-L3 receiver / issuer CUIT pending: asked, no confirm button; the database refusal is explained', () => {
  const p = { total: 70637.06, concept: 'Gasoil', category_id: 'c9', method: 'CASH', account_id: 'acc-cash', date: '2026-10-24', vat_receiver_pending: true, issuer_cuit_pending: true,
    fiscal_pending: { components: [] }, receipt: { document_type: 'INVOICE_A', iva: [{ rate: 21, amount: 11647.14 }], other_taxes: [] } };
  const c = WA.compose({ to: '1', request: { action: 'propose' } }, 200, { result: { ok: true, draft_id: D, short_code: 'W-0013', version: 1, state: 'DRAFT', payload: p } }, null, CFG);
  assert.equal(c.graph.type, 'text');
  assert.match(c.graph.text.body, /a nombre de Santo Tomás/);
  assert.match(c.graph.text.body, /CUIT del emisor/);
  for (const code of ['WA_RECEIVER_REQUIRED', 'WA_ISSUER_CUIT_REQUIRED']) {
    const e = WA.compose(ctx4, 422, { error: { code } }, null, CFG);
    assert.doesNotMatch(e.graph.text.body, /No pude procesar/);
  }
});

test('L4-L4 "es de Santo Tomás" on the open draft → a correction of THAT draft (no GPT); help no longer asks for "mp <número>"', () => {
  const p = { total: 1210, concept: 'Repuestos', category_id: 'c1', method: 'CASH', account_id: 'acc-cash', vat_receiver_pending: true,
    fiscal: { document_type: 'INVOICE_A', components: [], issuer_tax_id: '20123456786' }, receipt: { document_type: 'INVOICE_A', iva: [{ rate: 21, base: 1000, amount: 210 }], other_taxes: [] } };
  const ctx = { open: { draft_id: D, version: 3, state: 'DRAFT', short_code: 'W-0014', payload: p }, waiting: [], catalog: {} };
  const r = WAI4.preRoute('sí, es de Santo Tomás', ctx, null, { ownCuits: [] });
  assert.deepEqual([r.request.action, r.request.draft_id, r.request.expected_version, r.request.payload.fiscal.components.length, r.request.payload.vat_receiver_pending],
    ['correct', D, 3, 1, undefined]);
  assert.equal(r.changes[0].field, 'receiver');
  assert.doesNotMatch(WAI4.preRoute('ayuda', ctx).reply, /mp <número>/);
});
