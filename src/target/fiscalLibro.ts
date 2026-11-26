/**
 * Fiscal (owner 2026-11-26, etapa 1) — presentation over what is recorded: the IVA position month by month (with the carried balance in
 * favour), the Libro IVA Compras / Ventas of a period (one row per document, IVA by rate, perceptions) and the debits / credits tax.
 * Sources: report_fiscal_period, fiscal_document + fiscal_document_component, report_bank_tax_period, the obligations; annulled
 * expenses leave their documents out (as report_fiscal_period does). Nothing is written.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';
import { documentNumber, firstOfMonth, registerFiscalDocument, type FiscalDirection, type FiscalDocumentType, type FiscalPeriodRow, type ObligationRow } from './fiscal';
import { createMaster } from './masters';
import { listDocumentLinks, uploadErpDocument, type ViewableDocument } from './documents';
import { removeAttachments } from './attachments';
import { listAnulaciones } from './expenses';

const num = (v: unknown) => Number(v ?? 0);
const cent = (v: number) => Math.round(v * 100);
const pesos = (c: number) => c / 100;

// ── Posición IVA ────────────────────────────────────────────────────────────
export interface MesIva {
  period: string;            // YYYY-MM-01
  debito: number;            // IVA de ventas (notas de crédito ya restadas)
  credito: number;           // IVA de compras
  percepciones: number;      // percepciones de IVA sufridas (en compras)
  saldoMes: number;          // débito − crédito
  arrastre: number;          // saldo a favor que viene del mes anterior
  aPagar: number;            // débito − crédito − arrastre − percepciones, si es positivo
  aFavor: number;            // lo que pasa al mes siguiente, si es negativo
  documentos: number;
  obligacion: ObligationRow | null;   // la obligación de IVA de ese mes, si se cargó
}

/**
 * Month by month, oldest first: the saldo técnico a favor carries to the next month (owner 2026-11-26); the IVA perceptions suffered
 * reduce what is to pay. Months without documents in between still carry the balance.
 */
export function posicionIva(filas: FiscalPeriodRow[], obligaciones: ObligationRow[] = []): MesIva[] {
  const porMes = new Map<string, { d: number; c: number; p: number; n: number }>();
  for (const f of filas) {
    const m = porMes.get(f.period) ?? { d: 0, c: 0, p: 0, n: 0 };
    if (f.tax_kind === 'IVA') { m.d += cent(f.debit_amount); m.c += cent(f.credit_amount); m.n += f.debit_documents + f.credit_documents; }
    if (f.tax_kind === 'PERCEPTION') m.p += cent(f.credit_amount);
    porMes.set(f.period, m);
  }
  const meses = [...porMes.keys()].sort();
  if (meses.length === 0) return [];
  const out: MesIva[] = [];
  let arrastre = 0;
  for (let p = meses[0]; p <= meses[meses.length - 1]; p = siguienteMes(p)) {
    const m = porMes.get(p) ?? { d: 0, c: 0, p: 0, n: 0 };
    const neto = m.d - m.c - arrastre - m.p;
    out.push({
      period: p, debito: pesos(m.d), credito: pesos(m.c), percepciones: pesos(m.p), saldoMes: pesos(m.d - m.c), arrastre: pesos(arrastre),
      aPagar: pesos(Math.max(0, neto)), aFavor: pesos(Math.max(0, -neto)), documentos: m.n,
      obligacion: obligaciones.find((o) => o.tax_kind === 'IVA' && o.fiscal_period === p && o.status !== 'CANCELLED') ?? null,
    });
    arrastre = Math.max(0, -neto);
  }
  return out;
}
export function siguienteMes(p: string): string {
  const [a, m] = p.split('-').map(Number);
  return m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
}

// ── Libro IVA ───────────────────────────────────────────────────────────────
export interface ComponenteLibro { tax_kind: string; direction: FiscalDirection; base_amount: number; rate_applied: number; tax_amount: number }
export interface DocumentoLibro {
  id: string; document_type: FiscalDocumentType; direction: FiscalDirection; document_date: string; fiscal_period: string;
  external_number: string | null; net_amount: number; total_amount: number; contraparte: string | null; cuit: string | null;
  pedido_id: string | null; componentes: ComponenteLibro[];
}
export interface FilaLibro {
  id: string; fecha: string; tipo: string; numero: string; contraparte: string; cuit: string;
  neto: number; iva21: number; iva105: number; iva27: number; ivaOtras: number; percIva: number; percIibb: number; otros: number; total: number;
  avisos: string[];
}
export const TIPO_DOC: Record<FiscalDocumentType, string> = {
  INVOICE_A: 'Factura A', INVOICE_B: 'Factura B', INVOICE_C: 'Factura C', CREDIT_NOTE: 'Nota de crédito', DEBIT_NOTE: 'Nota de débito', RECEIPT: 'Recibo', OTHER: 'Otro',
};
const formatoCuit = (c: string | null) => (c && /^\d{11}$/.test(c) ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c ?? '');

/** One row of the book: IVA split by rate, perceptions apart; a credit note subtracts (negative amounts). Warnings for what is missing. */
export function filaLibro(d: DocumentoLibro): FilaLibro {
  const s = d.document_type === 'CREDIT_NOTE' ? -1 : 1;
  const sum = (f: (c: ComponenteLibro) => boolean) => s * pesos(d.componentes.filter(f).reduce((t, c) => t + cent(c.tax_amount), 0));
  const iva = (r: number) => sum((c) => c.tax_kind === 'IVA' && Math.abs(c.rate_applied - r) < 0.001);
  const avisos: string[] = [];
  if (!d.external_number) avisos.push('sin número');
  if (d.document_type === 'INVOICE_A' && !(d.cuit && /^\d{11}$/.test(d.cuit))) avisos.push('sin CUIT');
  return {
    id: d.id, fecha: d.document_date, tipo: TIPO_DOC[d.document_type] ?? d.document_type, numero: d.external_number ?? '', contraparte: d.contraparte ?? '',
    cuit: formatoCuit(d.cuit), neto: s * d.net_amount, iva21: iva(21), iva105: iva(10.5), iva27: iva(27),
    ivaOtras: sum((c) => c.tax_kind === 'IVA' && ![21, 10.5, 27].some((r) => Math.abs(c.rate_applied - r) < 0.001)),
    percIva: sum((c) => c.tax_kind === 'PERCEPTION'), percIibb: sum((c) => c.tax_kind === 'IIBB'),
    otros: sum((c) => !['IVA', 'PERCEPTION', 'IIBB'].includes(c.tax_kind)), total: s * d.total_amount, avisos,
  };
}
export const COLUMNAS_LIBRO: [keyof FilaLibro, string][] = [
  ['fecha', 'Fecha'], ['tipo', 'Tipo'], ['numero', 'Número'], ['contraparte', 'Contraparte'], ['cuit', 'CUIT'], ['neto', 'Neto gravado'],
  ['iva21', 'IVA 21%'], ['iva105', 'IVA 10,5%'], ['iva27', 'IVA 27%'], ['ivaOtras', 'IVA otras alícuotas'], ['percIva', 'Percepción IVA'],
  ['percIibb', 'Percepción IIBB'], ['otros', 'Otros impuestos'], ['total', 'Total'],
];
export function totalesLibro(filas: FilaLibro[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k] of COLUMNAS_LIBRO) {
    if (typeof filas[0]?.[k] !== 'number' && filas.length > 0) continue;
    out[k] = pesos(filas.reduce((t, f) => t + cent(Number(f[k]) || 0), 0));
  }
  return out;
}

/** The documents of a fiscal period (both directions), without those of annulled expenses. */
export async function listDocumentosPeriodo(client: SupabaseClient, period: string): Promise<DocumentoLibro[]> {
  type Row = {
    id: string; document_type: FiscalDocumentType; direction: FiscalDirection; document_date: string; fiscal_period: string; external_number: string | null;
    net_amount: number | string; total_amount: number | string; issuer_tax_id: string | null; issuer_name: string | null; pedido_id: string | null;
    suppliers: { nombre: string; fiscal_id: string | null } | null; clients: { nombre: string; fiscal_id: string | null } | null;
    fiscal_document_component: ComponenteLibro[] | null;
  };
  const rows = await readTable<Row>(client, 'fiscal_document', (q) => q.eq('fiscal_period', period).order('document_date'),
    'id, document_type, direction, document_date, fiscal_period, external_number, net_amount, total_amount, issuer_tax_id, issuer_name, pedido_id, '
    + 'suppliers(nombre, fiscal_id), clients(nombre, fiscal_id), fiscal_document_component(tax_kind, direction, base_amount, rate_applied, tax_amount)');
  const anulados = await documentosAnulados(client, rows.map((r) => r.id));
  return rows.filter((r) => !anulados.has(r.id)).map((r) => ({
    id: r.id, document_type: r.document_type, direction: r.direction, document_date: r.document_date, fiscal_period: r.fiscal_period,
    external_number: r.external_number, net_amount: num(r.net_amount), total_amount: num(r.total_amount), pedido_id: r.pedido_id,
    contraparte: r.suppliers?.nombre ?? r.clients?.nombre ?? r.issuer_name ?? null,
    cuit: (r.suppliers?.fiscal_id ?? r.clients?.fiscal_id ?? r.issuer_tax_id ?? '').replace(/\D/g, '') || null,
    componentes: (r.fiscal_document_component ?? []).map((c) => ({ ...c, base_amount: num(c.base_amount), rate_applied: num(c.rate_applied), tax_amount: num(c.tax_amount) })),
  }));
}
/** The documents of annulled expenses (fin_expense_annulments → the purchase versions → their fiscal document). */
async function documentosAnulados(client: SupabaseClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const anul = await listAnulaciones(client);
  if (anul.length === 0) return new Set();
  const out = new Set<string>();
  const roots = anul.map((a) => a.purchase_root_id);
  for (let i = 0; i < ids.length; i += 80) {
    // the document hangs from the expense's first version (the chain root the annulment names)
    const compras = await readTable<{ fiscal_document_id: string | null; id: string }>(client, 'purchases', (q) => q.in('fiscal_document_id', ids.slice(i, i + 80)), 'id, fiscal_document_id');
    for (const c of compras) if (c.fiscal_document_id && roots.includes(c.id)) out.add(c.fiscal_document_id);
  }
  return out;
}

/** The files of the period's documents: the purchase's attachments (ERP / WhatsApp) and the documents linked to it, by fiscal document. */
export type ArchivoComprobante = ViewableDocument;
export async function listArchivosDocumentos(client: SupabaseClient, ids: string[]): Promise<Map<string, ArchivoComprobante[]>> {
  const out = new Map<string, ArchivoComprobante[]>();
  const add = (k: string, a: ArchivoComprobante) => out.set(k, [...(out.get(k) ?? []), a]);
  for (let i = 0; i < ids.length; i += 80) {
    const parte = ids.slice(i, i + 80);
    const compras = await readTable<{ id: string; fiscal_document_id: string }>(client, 'purchases', (q) => q.in('fiscal_document_id', parte), 'id, fiscal_document_id');
    const docDe = new Map(compras.map((c) => [c.id, c.fiscal_document_id]));
    const pids = [...docDe.keys()];
    const [adjuntos, linksCompra, linksDoc] = await Promise.all([
      pids.length ? readTable<ArchivoComprobante & { purchase_id: string }>(client, 'purchase_attachment', (q) => q.in('purchase_id', pids), 'purchase_id, storage_path, file_name, content_type') : Promise.resolve([]),
      listDocumentLinks(client, 'PURCHASE', pids),
      listDocumentLinks(client, 'FISCAL_DOCUMENT', parte),
    ]);
    for (const a of adjuntos) add(docDe.get(a.purchase_id)!, a);
    for (const [pid, ds] of linksCompra) for (const d of ds) add(docDe.get(pid)!, d);
    for (const [did, ds] of linksDoc) for (const d of ds) add(did, d);
  }
  for (const [k, v] of out) out.set(k, v.filter((a, i) => v.findIndex((b) => b.storage_path === a.storage_path) === i));
  return out;
}

// ── Impuesto a los débitos y créditos ──────────────────────────────────────
export interface MesDebCred { period: string; porCuenta: { cuenta: string; monto: number; cargos: number }[]; total: number }
/** Month by month (newest first): by account and the total. PyME: 100 % computable as pago a cuenta de Ganancias (owner 2026-11-26). */
export function debitosCreditosPorMes(filas: { period: string; tax_kind: string; account_name: string; amount_paid: number; charges: number }[]): MesDebCred[] {
  const porMes = new Map<string, MesDebCred>();
  for (const f of filas) {
    if (f.tax_kind !== 'DEBITOS_CREDITOS') continue;
    const m = porMes.get(f.period) ?? { period: f.period, porCuenta: [], total: 0 };
    const c = m.porCuenta.find((x) => x.cuenta === f.account_name);
    if (c) { c.monto = pesos(cent(c.monto) + cent(num(f.amount_paid))); c.cargos += num(f.charges); }
    else m.porCuenta.push({ cuenta: f.account_name, monto: num(f.amount_paid), cargos: num(f.charges) });
    m.total = pesos(cent(m.total) + cent(num(f.amount_paid)));
    porMes.set(f.period, m);
  }
  return [...porMes.values()].sort((a, b) => b.period.localeCompare(a.period)).map((m) => ({ ...m, porCuenta: m.porCuenta.sort((a, b) => a.cuenta.localeCompare(b.cuenta)) }));
}

// ── Ingresos de Mercado Pago a facturar (0143) ─────────────────────────────
export interface FacturarMes { period: string; cobrado: number; cobros: number; facturado_b: number; facturas_b: number; cobrado_factura_a: number; pendiente: number }
export interface FacturarDia { business_date: string; period: string; cobrado: number; cobros: number; facturado_b: number; facturas_b: number }
export async function listFacturarMes(client: SupabaseClient): Promise<FacturarMes[]> {
  const rows = await readView<FacturarMes>(client, 'report_mp_facturar_mes', (q) => q.order('period', { ascending: false }).limit(60));
  return rows.map((r) => ({ ...r, cobrado: num(r.cobrado), cobros: num(r.cobros), facturado_b: num(r.facturado_b), facturas_b: num(r.facturas_b), cobrado_factura_a: num(r.cobrado_factura_a), pendiente: num(r.pendiente) }));
}
export async function listFacturarDia(client: SupabaseClient, period: string): Promise<FacturarDia[]> {
  const rows = await readView<FacturarDia>(client, 'report_mp_facturar_dia', (q) => q.eq('period', period).order('business_date'));
  return rows.map((r) => ({ ...r, cobrado: num(r.cobrado), cobros: num(r.cobros), facturado_b: num(r.facturado_b), facturas_b: num(r.facturas_b) }));
}

/** Factura B to consumidor final: the price includes IVA 21 % — neto = total ÷ 1,21 (to the cent), IVA = total − neto. */
export function desglosarFacturaB(total: number): { neto: number; iva: number } {
  const t = cent(total);
  const n = Math.round(t / 1.21);
  return { neto: pesos(n), iva: pesos(t - n) };
}
export const CONSUMIDOR_FINAL = 'Consumidor final';
/** Registers an issued Factura B (DEBITO) to «Consumidor final» (the client is created the first time). */
export async function registrarFacturaB(client: SupabaseClient, p: {
  fecha: string; periodo?: string | null; puntoVenta: string; numero: string; total: number; clienteId: string | null; reason?: string | null;
}): Promise<{ fiscal_document_id: string }> {
  let clienteId = p.clienteId;
  if (!clienteId) clienteId = (await createMaster<{ id: string }>(client, 'clients', { nombre: CONSUMIDOR_FINAL })).id;
  const { neto, iva } = desglosarFacturaB(p.total);
  return registerFiscalDocument(client, {
    type: 'INVOICE_B', direction: 'DEBITO', date: p.fecha, fiscalPeriod: firstOfMonth(p.periodo || p.fecha), netAmount: neto, totalAmount: p.total,
    components: [{ tax_kind: 'IVA', direction: 'DEBITO', base_amount: neto, rate_applied: 21, tax_amount: iva }],
    clienteId, externalNumber: documentNumber(p.puntoVenta, p.numero), reason: p.reason ?? 'Factura B a consumidor final (cobros de Mercado Pago)',
  });
}

/** The PDF / photo of a fiscal document (a sales invoice) from the ERP; on failure the uploaded object is removed. */
export async function attachFiscalDocumentFile(client: SupabaseClient, p: { userId: string; fiscalDocumentId: string; file: File }): Promise<string> {
  const doc = await uploadErpDocument(client, p.userId, p.file);
  try {
    return await callRpc<string>(client, 'attach_fiscal_document_file', { p_fiscal_document_id: p.fiscalDocumentId, p_document: doc });
  } catch (err) {
    await removeAttachments(client, [doc.storage_path]);
    throw err;
  }
}

