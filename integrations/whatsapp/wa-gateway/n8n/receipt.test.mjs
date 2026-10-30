// ADR-025 stage 4 — receipt reader decisions (pure). node --test n8n/receipt.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WAR = new Function(readFileSync(new URL('./receipt.js', import.meta.url), 'utf8') + '\nreturn WAR;')();
const WAI = new Function(readFileSync(new URL('./interpreter.js', import.meta.url), 'utf8') + '\nreturn WAI;')();
const C4 = 'aaaaaaaa-0025-0000-0000-0000000000c4';
const CTX = { open: null, catalog: { categories: [{ id: C4, nombre: 'Combustible', grupo: 'Combustible' }, { id: 'c1', nombre: 'Insumos' }],
  accounts: [{ id: 'acc-cash', nombre: 'Caja chica', account_type: 'CASH', method: 'CASH' }, { id: 'acc-bna', nombre: 'BNA', account_type: 'BANK_ACCOUNT', method: 'TRANSFER' },
             { id: 'acc-mp', nombre: 'Mercado Pago', account_type: 'EXTERNAL_SERVICE', method: 'MERCADOPAGO' }] } };
const DOC = { id: 'f-1', mime: 'image/jpeg', signed_url: 'https://x.supabase.co/storage/v1/object/sign/wa-media/wa/a.jpg?token=t', duplicate: false, links: 0, draft_short_code: null };
const TODAY = '2026-10-25';
const OWN = '30712345671';     // Santo Tomás (test value; the real one is the owner's configuration)
const OTHER = '30709998885';
const R = (o) => ({ readable: true, document_type: 'TICKET', issuer_name: 'YPF', issuer_cuit: null, number: null, date: '2026-10-24', total: 45230.5, net: null,
  iva: [], other_taxes: [], addressed_to_santo_tomas: null, concept: null, category: null, issues: [], ...o });
const go = (gpt, caption, extra = {}) => WAR.decide({ gpt, caption, ctx: CTX, today: TODAY, amountCap: 10000000, document: DOC,
  saidMethods: WAI.saidMethods, namedAccounts: WAI.namedAccounts, accountOptions: WAI.accountOptions, ownCuits: [OWN], ...extra });

test('RC-1 CUIT check digit; "solo IVA" phrases', () => {
  assert.equal(WAR.cuitValid('30-71234567-9'), null);
  assert.equal(WAR.cuitValid('20-12345678-6'), '20123456786');
  assert.equal(WAR.cuitValid('12345'), null);
  for (const t of ['solo IVA', 'Solo crédito fiscal', 'lo pagué con mi plata', 'pagado con mis fondos']) assert.ok(WAR.isVatOnly(t), t);
  for (const t of ['gasoil', 'ticket del super', 'iva incluido']) assert.ok(!WAR.isVatOnly(t), t);
});

test('RC-2 ticket + "gasté esto en gasoil": ONE expense for the TOTAL, concept Gasoil, category from the CONCEPT, method pending (never presumed)', () => {
  const d = go(R({ concept: 'Gasoil', category: 'S1' }), 'Gasté esto en gasoil');
  assert.equal(d.request.type, 'CASUAL_EXPENSE');
  const p = d.request.payload;
  assert.deepEqual([p.total, p.concept, p.category_id, p.date, p.document_file_id, p.method, p.fiscal], [45230.5, 'Gasoil', C4, '2026-10-24', 'f-1', undefined, undefined]);
  assert.deepEqual(d.pending, ['method', 'account']);
  assert.equal(p.receipt.issuer_name, 'YPF');   // what was READ stays apart from the confirmed fields
});

test('RC-3 only a photo: concept pending (asked), no category; a concept the user did not write is never taken from the items', () => {
  const d = go(R({ concept: 'Aceite y gasoil' }), null);
  assert.equal(d.request.payload.concept_pending, true);
  assert.equal(d.request.payload.concept, undefined);
  assert.deepEqual(d.pending.slice(0, 2), ['concept', 'category']);
});

test('RC-4 unreadable / no total → ask for another photo; contradictory amounts → ask; nothing proposed', () => {
  assert.equal(go(R({ readable: false }), 'x').outcome, 'unreadable');
  assert.equal(go(R({ total: null }), 'x').outcome, 'unreadable');
  const d = go(R({ document_type: 'INVOICE_A', issuer_cuit: '20123456786', net: 1000, total: 2000, iva: [{ rate: 21, base: 1000, amount: 210 }] }), 'repuestos');
  assert.equal(d.outcome, 'contradictory'); assert.equal(d.request, undefined);
});

test('RC-5 invoice A to Santo Tomás with IVA discriminated: CASUAL_WITH_INVOICE, total once, IVA component (computable), percepción kept', () => {
  const d = go(R({ document_type: 'INVOICE_A', issuer_cuit: '20-12345678-6', number: '0001-00001234', net: 1000, total: 1240,
    iva: [{ rate: 21, base: 1000, amount: 210 }], other_taxes: [{ kind: 'PERCEPTION_IIBB', amount: 30 }], receiver_cuit: OWN, concept: 'Repuestos', category: 'S2' }),
    'repuestos del tractor, transferencia desde BNA');
  assert.equal(d.request.type, 'CASUAL_WITH_INVOICE');
  const f = d.request.payload.fiscal;
  assert.deepEqual([d.request.payload.total, f.total_amount, f.net_amount, f.issuer_tax_id, f.external_number, f.fiscal_period], [1240, 1240, 1000, '20123456786', '0001-00001234', '2026-10-01']);
  assert.deepEqual(f.components.map((c) => [c.tax_kind, c.rate_applied, c.tax_amount]), [['IVA', 21, 210], ['IIBB', 0, 30]]);
  assert.deepEqual([d.request.payload.method, d.request.payload.account_id], ['TRANSFER', 'acc-bna']);
});

test('RC-6 invoice A NOT addressed to Santo Tomás: fiscal document without IVA components (not computable); invoice B: no IVA invented', () => {
  const a = go(R({ document_type: 'INVOICE_A', issuer_cuit: '20123456786', net: 1000, total: 1210, iva: [{ rate: 21, base: 1000, amount: 210 }], receiver_cuit: OTHER, concept: 'Repuestos' }), 'repuestos');
  assert.deepEqual(a.request.payload.fiscal.components, []);
  const b = go(R({ document_type: 'INVOICE_B', issuer_cuit: '20123456786', total: 1210, concept: 'Repuestos' }), 'repuestos');
  assert.equal(b.request.type, 'CASUAL_WITH_INVOICE');
  assert.deepEqual([b.request.payload.fiscal.net_amount, b.request.payload.fiscal.components.length], [1210, 0]);
});

test('RC-7 "solo IVA": VAT_ONLY_DOCUMENT (no category, no payment); without CUIT / IVA → asks; not addressed → refused', () => {
  const ok = go(R({ document_type: 'INVOICE_A', issuer_cuit: '20123456786', net: 1000, total: 1210, iva: [{ rate: 21, base: 1000, amount: 210 }], receiver_cuit: OWN }), 'solo IVA, lo pagué con mi plata');
  assert.equal(ok.request.type, 'VAT_ONLY_DOCUMENT');
  assert.deepEqual([ok.request.payload.vat_only, ok.request.payload.method, ok.request.payload.category_id, ok.request.payload.fiscal.components.length], [true, undefined, undefined, 1]);
  assert.equal(go(R({ document_type: 'TICKET' }), 'solo iva').outcome, 'vat_only_incomplete');
  assert.equal(go(R({ document_type: 'INVOICE_A', issuer_cuit: '20123456786', net: 1000, total: 1210, iva: [{ rate: 21, base: 1000, amount: 210 }], receiver_cuit: OTHER }), 'solo iva').outcome, 'vat_only_not_addressed');
});

test('RC-8 an open draft, a receipt already in a draft or already registered → no new proposal', () => {
  assert.equal(go(R({}), 'x', { ctx: { ...CTX, open: { short_code: 'W-0001' } } }).outcome, 'open_draft');
  assert.equal(go(R({}), 'x', { document: { ...DOC, draft_short_code: 'W-0007' } }).outcome, 'already_in_draft');
  assert.equal(go(R({}), 'x', { document: { ...DOC, duplicate: true, links: 2 } }).outcome, 'already_registered');
});

test('RC-9 the request to OpenAI: the signed URL (image or PDF), the caption and the catalog only; strict schema', () => {
  const b = WAR.buildRequest({ caption: 'gasoil', today: TODAY, context: CTX, document: DOC, model: 'm' }).body;
  assert.equal(b.store, false); assert.equal(b.text.format.strict, true);
  assert.deepEqual(b.input[1].content[1], { type: 'input_image', image_url: DOC.signed_url, detail: 'high' });
  const pdf = WAR.buildRequest({ caption: null, today: TODAY, context: CTX, document: { ...DOC, mime: 'application/pdf' }, model: 'm' }).body;
  assert.deepEqual(pdf.input[1].content[1], { type: 'input_file', file_url: DOC.signed_url });
  assert.ok(!JSON.stringify(b).includes('acc-cash'), 'no account ids sent');
});

test('RC-10 ADR-026 a receipt "a pagar": the same expense (invoice / IVA kept), no method / account, due date only when written', () => {
  const d = go(R({ document_type: 'INVOICE_A', issuer_cuit: '20-12345678-6', number: '0001-00001234', net: 1000, total: 1240,
    iva: [{ rate: 21, base: 1000, amount: 210 }], other_taxes: [{ kind: 'PERCEPTION_IIBB', amount: 30 }], receiver_cuit: OWN, concept: 'Repuestos', category: 'S2' }),
    'repuestos del tractor, a pagar, vence el 30/11', { pendingPayment: WAI.pendingPayment, dueDate: WAI.dueDate });
  assert.equal(d.request.type, 'CASUAL_WITH_INVOICE');
  const p = d.request.payload;
  assert.deepEqual([p.pending_payment, p.due_date, p.method, p.account_id, p.fiscal.total_amount], [true, '2026-11-30', undefined, undefined, 1240]);
  assert.ok(!d.pending.includes('method') && !d.pending.includes('account'));
});

// ── Lote 4: the receiver CUIT decides; unknown → ask; an unreadable issuer CUIT never drops the invoice ──
const W7 = () => R({ document_type: 'INVOICE_A', issuer_name: 'EESS RUTA 3 DE POZZO ARDIZZI S.A.', issuer_cuit: null, number: '0110-00010999', date: '2026-10-24',
  total: 70637.06, net: 55462.5, iva: [{ rate: 21, base: null, amount: 11647.14 }],
  other_taxes: [{ kind: 'OTHER', amount: 2347.04 }, { kind: 'OTHER', amount: 596.27 }, { kind: 'OTHER', amount: 584.06 }], addressed_to_santo_tomas: true, concept: 'Gasoil', category: 'S1' });

test('L4-1 Factura A + receiver CUIT of Santo Tomás → computable; another CUIT → not computable; not identified → asked (never assumed different)', () => {
  const base = { document_type: 'INVOICE_A', issuer_cuit: '20123456786', net: 1000, total: 1210, iva: [{ rate: 21, base: 1000, amount: 210 }], concept: 'Repuestos', category: 'S2' };
  const own = go(R({ ...base, receiver_cuit: '30-71234567-1' }), 'repuestos en efectivo');
  assert.deepEqual([own.request.payload.fiscal.components.length, own.request.payload.receipt.receiver_status, own.request.payload.vat_receiver_pending], [1, 'OWN', undefined]);
  const other = go(R({ ...base, receiver_cuit: OTHER }), 'repuestos en efectivo');
  assert.deepEqual([other.request.payload.fiscal.components.length, other.request.payload.receipt.receiver_status, other.request.payload.vat_receiver_pending], [0, 'OTHER', undefined]);
  for (const unk of [R({ ...base, receiver_cuit: null, addressed_to_santo_tomas: false }), R({ ...base, receiver_cuit: '30-71234567-9' })]) {
    const u = go(unk, 'repuestos en efectivo');
    assert.deepEqual([u.request.payload.fiscal.components.length, u.request.payload.receipt.receiver_status, u.request.payload.vat_receiver_pending, u.pending.includes('receiver')], [0, 'UNKNOWN', true, true]);
  }
  // without the Santo Tomás CUIT configured nothing can be compared: asked, not "different"
  const nocfg = go(R({ ...base, receiver_cuit: OTHER }), 'repuestos en efectivo', { ownCuits: [] });
  assert.equal(nocfg.request.payload.receipt.receiver_status, 'UNKNOWN');
});

test('L4-2 W-0007: Factura A, IVA 11,647.14 discriminated, issuer CUIT unread → the invoice is kept apart (fiscal_pending), CUIT and receiver asked', () => {
  const d = go(W7(), 'gasoil, pagado con mercado pago');
  const p = d.request.payload;
  assert.equal(d.request.type, 'CASUAL_EXPENSE');
  assert.deepEqual([p.issuer_cuit_pending, p.vat_receiver_pending, p.fiscal, p.fiscal_pending.document_type, p.fiscal_pending.total_amount, p.fiscal_pending.components.length],
    [true, true, undefined, 'INVOICE_A', 70637.06, 0]);
  assert.ok(d.pending.includes('issuer_cuit') && d.pending.includes('receiver'));
  assert.deepEqual([p.method, p.account_id], ['MERCADOPAGO', 'acc-mp']);
  assert.match(WAR.line(p), /CUIT emisor: no legible/);
  assert.match(WAR.line(p), /a confirmar: no pude identificar el CUIT del receptor/);
});

test('L4-3 natural answers correct the SAME draft: receiver in words or by CUIT, issuer CUIT, "sin factura"', () => {
  const open = (p) => ({ draft_id: 'd', version: 1, state: 'DRAFT', short_code: 'W-0001', payload: p });
  const p0 = go(W7(), 'gasoil, pagado con mercado pago').request.payload;
  const yes = WAR.invoiceAnswer('Sí, es a nombre de Santo Tomás', open(p0), [OWN]);
  assert.deepEqual([yes.payload.vat_receiver_pending, yes.payload.fiscal_pending.components.map((c) => c.tax_amount), yes.payload.receipt.receiver_source, yes.changes[0]],
    [undefined, [11647.14, 2347.04, 596.27, 584.06], 'USER', { field: 'receiver', from: 'UNKNOWN', to: 'OWN' }]);
  const no = WAR.invoiceAnswer('no, está a nombre de otro', open(p0), [OWN]);
  assert.deepEqual([no.payload.fiscal_pending.components.length, no.payload.receipt.receiver_status], [0, 'OTHER']);
  const byCuit = WAR.invoiceAnswer('el receptor es 30-71234567-1', open(p0), [OWN]);
  assert.deepEqual([byCuit.payload.receipt.receiver_status, byCuit.payload.receipt.receiver_cuit, byCuit.payload.receipt.receiver_source], ['OWN', OWN, 'CUIT']);
  const iss = WAR.invoiceAnswer('cuit 30-70999888-5', open(yes.payload), [OWN]);
  assert.deepEqual([iss.payload.fiscal.issuer_tax_id, iss.payload.fiscal_pending, iss.payload.issuer_cuit_pending, iss.payload.fiscal.components.length], [OTHER, undefined, undefined, 4]);
  assert.match(WAR.invoiceAnswer('cuit emisor 30-71234567-1', open(yes.payload), [OWN]).reply, /CUIT de Santo Tomás/);
  const sin = WAR.invoiceAnswer('sin factura', open(p0), [OWN]);
  assert.deepEqual([sin.payload.fiscal_pending, sin.payload.issuer_cuit_pending, sin.payload.vat_receiver_pending], [undefined, undefined, undefined]);
  const fixed = WAR.invoiceAnswer('no es computable', open(iss.payload), [OWN]);
  assert.deepEqual([fixed.payload.fiscal.components.length, fixed.changes[0].to], [0, 'OTHER']);
  assert.equal(WAR.invoiceAnswer('eran 70 mil', open(p0), [OWN]), null);
  assert.equal(WAR.invoiceAnswer('es de Santo Tomás', open(R({})), [OWN]), null);
});

test('L4-4 Santo Tomás read as the ISSUER (parties swapped) → never the issuer: receiver Santo Tomás, issuer CUIT asked', () => {
  const d = go(R({ document_type: 'INVOICE_A', issuer_cuit: OWN, receiver_cuit: null, net: 1000, total: 1210, iva: [{ rate: 21, base: 1000, amount: 210 }], concept: 'Repuestos' }), 'repuestos');
  assert.deepEqual([d.request.payload.issuer_cuit_pending, d.request.payload.receipt.receiver_status, d.request.payload.fiscal_pending.components.length], [true, 'OWN', 1]);
});

test('L4-5 "solo IVA" with the receiver not identified → proposed with the receiver pending (asked, not refused)', () => {
  const d = go(R({ document_type: 'INVOICE_A', issuer_cuit: '20123456786', net: 1000, total: 1210, iva: [{ rate: 21, base: 1000, amount: 210 }], receiver_cuit: null }), 'solo IVA');
  assert.deepEqual([d.request.type, d.request.payload.vat_receiver_pending, d.pending], ['VAT_ONLY_DOCUMENT', true, ['receiver']]);
});

test('L4-6 the reader is told to find each party by its label, not by position; the schema asks the receiver CUIT', () => {
  assert.match(WAR.SYSTEM, /por su rótulo, no por su posición/);
  assert.ok(WAR.schema([]).required.includes('receiver_cuit'));
});
