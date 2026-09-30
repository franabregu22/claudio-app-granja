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
import { callRpc, readTable } from './db';

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
