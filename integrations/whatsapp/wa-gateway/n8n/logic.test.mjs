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
