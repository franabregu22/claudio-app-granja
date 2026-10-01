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
}) {
  return callRpc<{ fiscal_document_id: string; component_count: number }>(client, 'register_fiscal_document', {
    p_document_type: p.type, p_direction: p.direction, p_document_date: p.date, p_fiscal_period: p.fiscalPeriod, p_net_amount: p.netAmount,
    p_total_amount: p.totalAmount, p_components: p.components, p_supplier_id: p.supplierId ?? null, p_cliente_id: p.clienteId ?? null,
    p_external_number: reasonOrNull(p.externalNumber), p_reason: reasonOrNull(p.reason),
  });
}

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
export interface FiscalForm { tipo: FiscalDocumentType | ''; periodo: string; neto: string; total: string; componentes: ComponenteForm[] }
export const FISCAL_VACIO: FiscalForm = { tipo: '', periodo: '', neto: '', total: '', componentes: [{ tax_kind: 'IVA', base: '', alicuota: '', importe: '' }] };

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

