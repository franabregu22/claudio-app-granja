/**
 * ADR-025 stage 4 (0103 / 0104) — the original receipts, invoices and cheque PDFs.
 *
 * Files live in two PRIVATE buckets: `wa-media` (received by WhatsApp, key `wa/<sha256>.<ext>`) and `purchase-attachments`
 * (uploaded from the ERP, key `<user>/<uuid>.<ext>`). Both are read by an ADMIN through short-lived signed URLs only.
 * `fin_document_links` says which file belongs to which record; nothing here decides or changes a link except
 * the contract RPCs (register_erp_document / attach_instrument_document / issue_purchase_instruments).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { attachmentPath, PURCHASE_ATTACHMENT_BUCKET, removeAttachments, validateAttachments } from './attachments';
import { callRpc, readView, TargetDbError } from './db';

export const WA_MEDIA_BUCKET = 'wa-media';
export type DocumentTargetKind = 'PURCHASE' | 'EXPENSE_PENDING' | 'MP_PENDING_OUTFLOW' | 'FISCAL_DOCUMENT' | 'FINANCIAL_INSTRUMENT';

export interface DocumentLinkRow {
  target_kind: DocumentTargetKind; target_id: string; document_file_id: string; storage_bucket: string; storage_path: string;
  file_name: string; content_type: string; byte_size: number; origin: 'WHATSAPP' | 'ERP'; received_at: string; linked_at: string;
  read_document_type: string | null; read_number: string | null; read_issuer_name: string | null; read_issuer_cuit: string | null;
}
/** A file as viewed: the bucket is explicit (document_file) or follows from the key (a purchase_attachment row). */
export interface ViewableDocument { storage_bucket?: string | null; storage_path: string; file_name: string; content_type: string }
/** The metadata the RPCs take for an ERP upload. */
export interface ErpDocumentInput { storage_path: string; sha256: string; content_type: string; byte_size: number; file_name: string }

export const bucketOf = (d: ViewableDocument) => d.storage_bucket || (d.storage_path.startsWith('wa/') ? WA_MEDIA_BUCKET : PURCHASE_ATTACHMENT_BUCKET);

/** The links of a set of records (one request per screen page). */
export async function listDocumentLinks(client: SupabaseClient, kind: DocumentTargetKind, ids: string[]): Promise<Map<string, DocumentLinkRow[]>> {
  const out = new Map<string, DocumentLinkRow[]>();
  if (ids.length === 0) return out;
  const rows = await readView<DocumentLinkRow>(client, 'fin_document_links', (q) => q.eq('target_kind', kind).in('target_id', ids).order('linked_at'));
  for (const r of rows) out.set(r.target_id, [...(out.get(r.target_id) ?? []), r]);
  return out;
}

/** A short-lived link to view one file (no public URL exists for either bucket). */
export async function documentSignedUrl(client: SupabaseClient, d: ViewableDocument, seconds = 120): Promise<string> {
  const { data, error } = await client.storage.from(bucketOf(d)).createSignedUrl(d.storage_path, seconds);
  if (error || !data) throw new TargetDbError('ATTACHMENT_NOT_AVAILABLE', error?.message ?? '');
  return data.signedUrl;
}

/** Hex SHA-256 of a file (the database dedupes by it). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Upload one file to the caller's folder of purchase-attachments; returns the metadata for the RPC. */
export async function uploadErpDocument(client: SupabaseClient, userId: string, file: File): Promise<ErpDocumentInput> {
  validateAttachments([file]);
  const path = attachmentPath(userId, file.type);
  const { error } = await client.storage.from(PURCHASE_ATTACHMENT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new TargetDbError('ATTACHMENT_UPLOAD_FAILED', error.message);
  return { storage_path: path, sha256: await sha256Hex(file), content_type: file.type, byte_size: file.size, file_name: file.name.slice(0, 255) };
}

/** A PDF / photo of an own cheque or eCheq after it was issued. On failure the uploaded object is removed. */
export async function attachInstrumentDocument(client: SupabaseClient, p: { userId: string; instrumentId: string; file: File }): Promise<string> {
  const doc = await uploadErpDocument(client, p.userId, p.file);
  try {
    return await callRpc<string>(client, 'attach_instrument_document', { p_instrument_id: p.instrumentId, p_document: doc });
  } catch (err) {
    await removeAttachments(client, [doc.storage_path]);
    throw err;
  }
}
