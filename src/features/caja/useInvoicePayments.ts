import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { readTable } from '../../target/db';
import { attachInstrumentDocument, listDocumentLinks, uploadErpDocument, type DocumentTargetKind, type ErpDocumentInput, type ViewableDocument } from '../../target/documents';
import { removeAttachments } from '../../target/attachments';
import {
  allocatePurchasePayment, issuePurchaseInstruments, listDebitedInstruments, listInvoicePaymentDetail, listInvoicePaymentStatus, listScheduledPayments,
  listSupplierInvoices, listSupplierPayments, monthRange, type InstrumentToIssue,
} from '../../target/invoicePayments';

/** ADR-025 stage 4: documents of the visible records (one request per list). */
export function useDocumentLinks(kind: DocumentTargetKind, ids: string[]) {
  return useQuery({ queryKey: ['documents', kind, [...ids].sort().join(',')], queryFn: () => listDocumentLinks(supabase, kind, ids), enabled: ids.length > 0 });
}
/** The files of purchases (purchase_attachment: ERP uploads and WhatsApp receipts alike). */
export function usePurchaseAttachments(purchaseIds: string[]) {
  return useQuery({
    queryKey: ['documents', 'purchase_attachment', [...purchaseIds].sort().join(',')], enabled: purchaseIds.length > 0,
    queryFn: async () => {
      const rows = await readTable<ViewableDocument & { purchase_id: string }>(supabase, 'purchase_attachment',
        (q) => q.in('purchase_id', purchaseIds), 'purchase_id, storage_path, file_name, content_type');
      const out = new Map<string, ViewableDocument[]>();
      for (const r of rows) out.set(r.purchase_id, [...(out.get(r.purchase_id) ?? []), r]);
      return out;
    },
  });
}

export function useInvoicePaymentStatus(onlyPending: boolean) {
  return useQuery({ queryKey: ['treasury', 'invoice-payments', onlyPending], queryFn: () => listInvoicePaymentStatus(supabase, onlyPending) });
}
export function useInvoicePaymentDetail(rootId: string | null) {
  return useQuery({ queryKey: ['treasury', 'invoice-payments', 'detail', rootId], queryFn: () => listInvoicePaymentDetail(supabase, rootId!), enabled: !!rootId });
}
/** Lote 3A: the invoices of one supplier with their payment status (supplier ficha). */
export function useSupplierInvoices(supplierId: string) {
  return useQuery({ queryKey: ['treasury', 'invoice-payments', 'supplier', supplierId], queryFn: () => listSupplierInvoices(supabase, supplierId), enabled: supplierId !== '' });
}
export function useSupplierPayments(supplierId: string) {
  return useQuery({ queryKey: ['treasury', 'supplier-payments', supplierId], queryFn: () => listSupplierPayments(supabase, supplierId), enabled: supplierId !== '' });
}
/** The month of the maturity calendar: scheduled (to be debited) and real (debited) own instruments. */
export function useMaturities(ym: string) {
  const { from, to } = monthRange(ym);
  return useQuery({
    queryKey: ['treasury', 'maturities', ym],
    queryFn: async () => ({ scheduled: await listScheduledPayments(supabase, from, to), debited: await listDebitedInstruments(supabase, from, to) }),
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([['treasury'], ['documents'], ['commercial', 'balances'], ['fiscal'], ['pnl']].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** Instruments with an optional file each: upload first, then ONE RPC; on failure the uploaded objects are removed. */
export function useIssuePurchaseInstruments() {
  const onSuccess = useRefresh();
  return useMutation({
    mutationFn: async (p: { userId: string; purchaseId: string; idempotencyKey: string; reason: string; rows: (Omit<InstrumentToIssue, 'document'> & { file: File | null })[] }) => {
      const uploaded: string[] = [];
      try {
        const instruments: InstrumentToIssue[] = [];
        for (const { file, ...r } of p.rows) {
          let document: ErpDocumentInput | null = null;
          if (file) { document = await uploadErpDocument(supabase, p.userId, file); uploaded.push(document.storage_path); }
          instruments.push({ ...r, document });
        }
        return await issuePurchaseInstruments(supabase, { purchaseId: p.purchaseId, instruments, idempotencyKey: p.idempotencyKey, reason: p.reason });
      } catch (err) {
        await removeAttachments(supabase, uploaded);
        throw err;
      }
    },
    onSuccess,
  });
}
export function useAllocatePurchasePayment() {
  const onSuccess = useRefresh();
  return useMutation({ mutationFn: (p: Parameters<typeof allocatePurchasePayment>[1]) => allocatePurchasePayment(supabase, p), onSuccess });
}
export function useAttachInstrumentDocument() {
  const onSuccess = useRefresh();
  return useMutation({ mutationFn: (p: { userId: string; instrumentId: string; file: File }) => attachInstrumentDocument(supabase, p), onSuccess });
}
