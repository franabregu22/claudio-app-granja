/**
 * Phase 27 (F27-F) — fiscal records over the target schema (RPC_CONTRACTS_V1 fiscal: register_fiscal_document,
 * register_fiscal_obligation, pay_fiscal_obligation; PHASE_22_FISCAL). ADMIN only (in-body checks and RLS).
 *
 * The target RECORDS fiscal documents, tax obligations (optionally in installments) and their payments. It does not
 * issue documents to AFIP / ARCA and holds no fiscal-provider configuration: nothing here calls an external service.
 * The backend validates the fiscal period (first day of a month), duplicates, installment totals, overpayment and
 * obligation status, and books the payment's financial operation.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

export const FISCAL_DOCUMENT_TYPES = ['INVOICE_A', 'INVOICE_B', 'INVOICE_C', 'CREDIT_NOTE', 'DEBIT_NOTE', 'RECEIPT', 'OTHER'] as const;
export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number];
export const FISCAL_DIRECTIONS = ['DEBITO', 'CREDITO'] as const;
export type FiscalDirection = (typeof FISCAL_DIRECTIONS)[number];
export const TAX_KINDS = ['IVA', 'IIBB', 'GANANCIAS', 'RETENTION', 'PERCEPTION', 'OTHER'] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export interface FiscalDocumentRow {
  id: string; document_type: FiscalDocumentType; direction: FiscalDirection; document_date: string; fiscal_period: string;
  supplier_id: string | null; cliente_id: string | null; external_number: string | null; net_amount: number; total_amount: number;
  contraparte: string | null;
}
export interface InstallmentRow { id: string; installment_number: number; amount: number; due_date: string | null }
export interface ObligationRow {
  id: string; tax_kind: TaxKind; fiscal_period: string; amount: number; due_date: string | null;
  status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED'; installments: InstallmentRow[];
}
export interface ComponentInput { tax_kind: TaxKind; direction: FiscalDirection; base_amount: number; rate_applied: number; tax_amount: number }
export interface InstallmentInput { installment_number: number; amount: number; due_date: string | null }

const num = (v: unknown) => Number(v ?? 0);
const reasonOrNull = (r?: string | null) => (r && r.trim() !== '' ? r.trim() : null);

/** The first day of the month of a YYYY-MM-DD date (the contract's fiscal-period form; presentation helper). */
export const firstOfMonth = (date: string) => `${date.slice(0, 7)}-01`;

export async function listFiscalDocuments(client: SupabaseClient, limit = 200): Promise<FiscalDocumentRow[]> {
  const rows = await readTable<Omit<FiscalDocumentRow, 'contraparte'> & { suppliers: { nombre: string } | null; clients: { nombre: string } | null }>(
    client, 'fiscal_document', (q) => q.order('document_date', { ascending: false }).limit(limit), '*, suppliers(nombre), clients(nombre)');
  return rows.map(({ suppliers, clients, ...d }) => ({
    ...d, net_amount: num(d.net_amount), total_amount: num(d.total_amount), contraparte: suppliers?.nombre ?? clients?.nombre ?? null,
  }));
}

export async function listObligations(client: SupabaseClient, limit = 200): Promise<ObligationRow[]> {
  const rows = await readTable<Omit<ObligationRow, 'installments'> & { fiscal_obligation_installment: InstallmentRow[] }>(client, 'fiscal_obligation',
    (q) => q.order('fiscal_period', { ascending: false }).limit(limit), '*, fiscal_obligation_installment(*)');
  return rows.map(({ fiscal_obligation_installment, ...o }) => ({
    ...o, amount: num(o.amount),
    installments: (fiscal_obligation_installment ?? []).map((i) => ({ ...i, amount: num(i.amount) }))
      .sort((a, b) => a.installment_number - b.installment_number),
  }));
}

/** DEBITO needs a client, CREDITO a supplier (SUPPLIER_REQUIRED / CLIENT_REQUIRED are the backend's rules). */
export function registerFiscalDocument(client: SupabaseClient, p: {
  type: FiscalDocumentType; direction: FiscalDirection; date: string; fiscalPeriod: string; netAmount: number; totalAmount: number;
  components: ComponentInput[]; supplierId?: string | null; clienteId?: string | null; externalNumber?: string | null; reason?: string | null;
  /** ADR-024 (0098): a received document from an issuer without a registered supplier (CUIT, 11 digits) */
  issuerTaxId?: string | null; issuerName?: string | null;
}) {
  return callRpc<{ fiscal_document_id: string; component_count: number }>(client, 'register_fiscal_document', {
    p_document_type: p.type, p_direction: p.direction, p_document_date: p.date, p_fiscal_period: p.fiscalPeriod, p_net_amount: p.netAmount,
    p_total_amount: p.totalAmount, p_components: p.components, p_supplier_id: p.supplierId ?? null, p_cliente_id: p.clienteId ?? null,
    p_external_number: reasonOrNull(p.externalNumber), p_reason: reasonOrNull(p.reason),
    p_issuer_tax_id: reasonOrNull(p.issuerTaxId), p_issuer_name: reasonOrNull(p.issuerName),
  });
}

/** "PPPP-NNNNNNNN" from punto de venta and número (digits are zero-padded); either part alone is kept as typed. */
export function documentNumber(puntoDeVenta: string, numero: string): string | null {
  const pv = puntoDeVenta.trim();
  const n = numero.trim();
  if (pv === '' && n === '') return null;
  if (pv === '' || n === '') return pv || n;
  return `${/^\d+$/.test(pv) ? pv.padStart(4, '0') : pv}-${/^\d+$/.test(n) ? n.padStart(8, '0') : n}`;
}

/** An 11-digit CUIT (dashes / spaces ignored), or null. */
export const cuitOrNull = (v: string) => { const d = v.replace(/[\s-]/g, ''); return /^\d{11}$/.test(d) ? d : null; };

export const SOLO_IVA_NOTE = 'Solo crédito fiscal IVA: no mueve dinero de ninguna cuenta, no registra un gasto ni una deuda con el proveedor. Solo suma el IVA del comprobante como crédito fiscal del período.';

export function registerFiscalObligation(client: SupabaseClient, p: {
  taxKind: TaxKind; fiscalPeriod: string; amount: number; dueDate?: string | null; installments?: InstallmentInput[] | null; reason?: string | null;
}) {
  return callRpc<{ obligation_id: string; installment_count: number }>(client, 'register_fiscal_obligation', {
    p_tax_kind: p.taxKind, p_fiscal_period: p.fiscalPeriod, p_amount: p.amount, p_due_date: p.dueDate ?? null,
    p_installments: p.installments && p.installments.length > 0 ? p.installments : null, p_reason: reasonOrNull(p.reason),
  });
}

export function payFiscalObligation(client: SupabaseClient, p: {
  obligationId: string; date: string; amount: number; accountId: string; idempotencyKey: string; installmentId?: string | null; reason?: string | null;
}) {
  return callRpc<{ payment_id: string; financial_operation_id: number }>(client, 'pay_fiscal_obligation', {
    p_obligation_id: p.obligationId, p_effective_date: p.date, p_amount: p.amount, p_financial_account_id: p.accountId,
    p_idempotency_key: p.idempotencyKey, p_installment_id: p.installmentId ?? null, p_reason: reasonOrNull(p.reason),
  });
}

// ── consolidated fiscal position (ADR-015) ──────────────────────────────────

export interface FiscalPeriodRow {
  period: string; tax_kind: string; debit_amount: number; credit_amount: number; debit_documents: number; credit_documents: number;
  period_difference: number;
}
/**
 * report_fiscal_period exactly as reported: loaded tax amounts by period / tax kind / direction, credit notes already
 * reversed by the backend, and the backend's informational period_difference (debit − credit). Not a payable amount and
 * nothing is carried forward; nothing is summed or derived here.
 */
export async function listFiscalPeriods(client: SupabaseClient, limit = 120): Promise<FiscalPeriodRow[]> {
  const rows = await readView<FiscalPeriodRow>(client, 'report_fiscal_period', (q) => q.order('period', { ascending: false }).order('tax_kind').limit(limit));
  return rows.map((r) => ({
    ...r, debit_amount: num(r.debit_amount), credit_amount: num(r.credit_amount), debit_documents: num(r.debit_documents),
    credit_documents: num(r.credit_documents), period_difference: num(r.period_difference),
  }));
}

export interface FiscalPaymentRow {
  id: string; fiscal_obligation_id: string; effective_date: string; amount: number; tax_kind: string | null; fiscal_period: string | null; cuenta: string | null;
}
export async function listFiscalPayments(client: SupabaseClient, limit = 200): Promise<FiscalPaymentRow[]> {
  const rows = await readTable<{ id: string; fiscal_obligation_id: string; effective_date: string; amount: number | string;
    fiscal_obligation: { tax_kind: string; fiscal_period: string } | null; financial_account: { nombre: string } | null }>(client, 'fiscal_payment',
    (q) => q.order('effective_date', { ascending: false }).limit(limit),
    'id, fiscal_obligation_id, effective_date, amount, fiscal_obligation(tax_kind, fiscal_period), financial_account(nombre)');
  return rows.map((p) => ({
    id: p.id, fiscal_obligation_id: p.fiscal_obligation_id, effective_date: p.effective_date, amount: num(p.amount),
    tax_kind: p.fiscal_obligation?.tax_kind ?? null, fiscal_period: p.fiscal_obligation?.fiscal_period ?? null, cuenta: p.financial_account?.nombre ?? null,
  }));
}

/** Optional fiscal data of a purchase (D-FISCAL-4): amounts exactly as typed; nothing is derived here. */
export interface PurchaseFiscalInput {
  documentType: FiscalDocumentType; fiscalPeriod: string; netAmount: number; totalAmount: number;
  components: Omit<ComponentInput, 'direction'>[];
}

export type ComponenteForm = { tax_kind: TaxKind; base: string; alicuota: string; importe: string };
export interface FiscalForm { tipo: FiscalDocumentType | ''; periodo: string; neto: string; total: string; componentes: ComponenteForm[]; /** Factura A: the computed field */ auto?: 'NETO' | 'IVA' }
export const FISCAL_VACIO: FiscalForm = { tipo: '', periodo: '', neto: '', total: '', componentes: [{ tax_kind: 'IVA', base: '', alicuota: '', importe: '' }] };

/** IVA rates printed on a Factura A (the first one is the default of a new row). */
export const ALICUOTAS_IVA = ['21', '10.5', '27'] as const;
/** The other taxes a Factura A may print (base / rate not on the form, stored 0 like the WhatsApp bot does). */
export const OTROS_IMPUESTOS: [TaxKind, string][] = [['PERCEPTION', 'Percepción IVA'], ['IIBB', 'Percepción IIBB'], ['OTHER', 'Otro impuesto']];
const centavos = (v: string | number) => Math.round(Number(v) * 100);

/**
 * Factura A of an expense (owner 2026-11-25): the difference in cents between the expense total and neto + every tax typed, or null
 * while the neto is missing or a tax row is invalid (an IVA row with an amount needs its rate). Rows without an amount are ignored.
 */
export function diferenciaFacturaA(f: FiscalForm, total: number): number | null {
  if (f.neto === '' || !(Number(f.neto) >= 0)) return null;
  let suma = centavos(f.neto);
  for (const c of f.componentes) {
    if (c.importe === '') continue;   // a blank row is ignored
    if (!(Number(c.importe) >= 0) || (c.tax_kind === 'IVA' && !(Number(c.alicuota) > 0))) return null;
    suma += centavos(c.importe);
  }
  return centavos(total) - suma;
}

/**
 * Factura A autocompletion (owner 2026-11-25): the expense total is known, so the neto and the first IVA amount complete each other —
 * neto = total − every tax; IVA = total − neto − the other taxes. The field the user did NOT type is the computed one (f.auto); typing in
 * it makes it manual. Any change (neto, a tax, the total) recomputes the computed field. A negative result leaves it empty.
 */
const deCentavos = (c: number) => (c < 0 ? '' : (c / 100).toFixed(2));
export function recalcularFacturaA(f: FiscalForm, total: number): FiscalForm {
  if (f.tipo !== 'INVOICE_A' || !f.auto || !(total > 0) || f.componentes[0]?.tax_kind !== 'IVA') return f;
  const imp = (c: ComponenteForm) => (c.importe === '' ? 0 : centavos(c.importe));
  if (f.auto === 'NETO') {
    const v = deCentavos(centavos(total) - f.componentes.reduce((t, c) => t + imp(c), 0));
    return v === f.neto ? f : { ...f, neto: v };
  }
  if (f.neto === '') return f;
  const v = deCentavos(centavos(total) - centavos(f.neto) - f.componentes.slice(1).reduce((t, c) => t + imp(c), 0));
  return v === f.componentes[0].importe ? f : { ...f, componentes: f.componentes.map((c, i) => (i === 0 ? { ...c, importe: v } : c)) };
}
/** The user typed the neto (campo 'NETO') or the amount of tax row i: the other one of the pair becomes the computed field. */
export function editarFacturaA(f: FiscalForm, total: number, campo: 'NETO' | number, valor: string): FiscalForm {
  let g: FiscalForm;
  if (campo === 'NETO') {
    g = { ...f, neto: valor, auto: f.auto === 'NETO' ? undefined : f.auto };
    if (!g.auto && (g.componentes[0]?.importe ?? '') === '') g = { ...g, auto: 'IVA' };
  } else {
    g = { ...f, componentes: f.componentes.map((c, i) => (i === campo ? { ...c, importe: valor } : c)), auto: campo === 0 && f.auto === 'IVA' ? undefined : f.auto };
    if (campo === 0 && !g.auto && g.neto === '') g = { ...g, auto: 'NETO' };
  }
  return recalcularFacturaA(g, total);
}

/**
 * Nuevo gasto (owner 2026-11-26): with Factura A the total is NOT typed — it is neto + every tax. While the first IVA amount is the
 * computed one (auto 'IVA') and it is the only IVA row, it is neto × its rate (to the cent); typing it makes it manual. With two or
 * more IVA rates each amount is typed as printed. Returns the same object when nothing changes.
 */
export function completarFacturaA(f: FiscalForm): FiscalForm {
  if (f.tipo !== 'INVOICE_A' || f.auto !== 'IVA' || f.componentes.filter((c) => c.tax_kind === 'IVA').length !== 1) return f;
  const c0 = f.componentes[0];
  if (c0?.tax_kind !== 'IVA') return f;
  const v = f.neto === '' || !(Number(f.neto) >= 0) || !(Number(c0.alicuota) > 0) ? '' : (Math.round((centavos(f.neto) * Number(c0.alicuota)) / 100) / 100).toFixed(2);
  return v === c0.importe ? f : { ...f, componentes: f.componentes.map((c, i) => (i === 0 ? { ...c, importe: v } : c)) };
}
/** The total of a Factura A typed in Nuevo gasto: neto + every tax (null while the neto is missing or a tax row is invalid). */
export function totalFacturaA(f: FiscalForm): number | null {
  const resto = diferenciaFacturaA(f, 0);   // 0 − (neto + taxes), in cents
  return resto === null ? null : -resto / 100;
}

/**
 * The fiscal data of an expense from its invoice block, or null while incomplete:
 *   * no invoice ('') → null (nothing fiscal is recorded);
 *   * Factura A → the neto and the taxes as printed, only when they add up to the expense total to the cent. An IVA row stores
 *     base = amount × 100 / rate (the bot's rule); another tax stores base and rate 0;
 *   * any other document (B, C, receipt, other) → neto = total = the expense total, no taxes.
 */
export function fiscalDeGasto(f: FiscalForm, total: number, fecha: string): PurchaseFiscalInput | null {
  if (f.tipo === '' || !(total > 0)) return null;
  const fiscalPeriod = f.periodo !== '' ? `${f.periodo}-01` : firstOfMonth(fecha);
  if (f.tipo !== 'INVOICE_A') return { documentType: f.tipo, fiscalPeriod, netAmount: total, totalAmount: total, components: [] };
  if (diferenciaFacturaA(f, total) !== 0) return null;
  return {
    documentType: 'INVOICE_A', fiscalPeriod, netAmount: Number(f.neto), totalAmount: total,
    components: f.componentes.filter((c) => c.importe !== '').map((c) => (c.tax_kind === 'IVA'
      ? { tax_kind: 'IVA' as const, base_amount: Math.round(Number(c.importe) * 10000 / Number(c.alicuota)) / 100, rate_applied: Number(c.alicuota), tax_amount: Number(c.importe) }
      : { tax_kind: c.tax_kind, base_amount: 0, rate_applied: 0, tax_amount: Number(c.importe) })),
  };
}

/**
 * The typed fiscal data, or null while incomplete. Every amount is exactly what the user typed: no rate, base or tax
 * is derived here (the backend stores them as supplied). Components left completely blank are ignored.
 */
export function fiscalInput(f: FiscalForm, fecha: string): PurchaseFiscalInput | null {
  if (f.tipo === '' || f.neto === '' || f.total === '') return null;
  const usados = f.componentes.filter((c) => c.base !== '' || c.alicuota !== '' || c.importe !== '');
  if (usados.some((c) => c.base === '' || c.alicuota === '' || c.importe === '')) return null;
  return {
    documentType: f.tipo, fiscalPeriod: f.periodo !== '' ? `${f.periodo}-01` : firstOfMonth(fecha), netAmount: Number(f.neto), totalAmount: Number(f.total),
    components: usados.map((c) => ({ tax_kind: c.tax_kind, base_amount: Number(c.base), rate_applied: Number(c.alicuota), tax_amount: Number(c.importe) })),
  };
}

