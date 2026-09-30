/**
 * Phase 27 (F27-D, ADR-008) — purchase attachments in the PRIVATE Storage bucket `purchase-attachments`
 * (migration 0058: ADMIN-only SELECT / INSERT / DELETE, 10 MB, PDF / JPEG / PNG / WebP; no public URL).
 *
 * Sequence for a new purchase (ADR-008 §4):
 *   1. validate the files (UX; the bucket enforces the same limits);
 *   2. upload each under a generated key `<auth-user-id>/<uuid>.<ext>` (the original name is metadata only);
 *   3. call register_purchase (RPC 13) with the object metadata — the backend stays the only accounting authority;
 *   4. if the upload or the RPC fails, delete the objects this attempt uploaded (compensation) and surface the
 *      ORIGINAL error; a failed cleanup is reported safely and never replaces it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TargetDbError } from './db';
import { registerPurchase } from './treasury';

export const PURCHASE_ATTACHMENT_BUCKET = 'purchase-attachments';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

export interface AttachmentFile { name: string; type: string; size: number }
export interface AttachmentMeta { storage_path: string; file_name: string; content_type: string; byte_size: number }

/** UX validation, before any request. The bucket refuses the same cases server-side. */
export function validateAttachments(files: AttachmentFile[]): void {
  if (files.length === 0) throw new TargetDbError('ATTACHMENT_REQUIRED', 'at least one attachment');
  for (const f of files) {
    if (!ATTACHMENT_TYPES[f.type]) throw new TargetDbError('ATTACHMENT_TYPE_NOT_ALLOWED', f.type || 'unknown');
    if (f.size <= 0 || f.size > MAX_ATTACHMENT_BYTES) throw new TargetDbError('ATTACHMENT_TOO_LARGE', String(f.size));
  }
}

/** Generated, collision-safe object key; the first segment must be the uploader (INSERT policy of 0058). */
export function attachmentPath(userId: string, contentType: string, uuid: string = crypto.randomUUID()): string {
  return `${userId}/${uuid}.${ATTACHMENT_TYPES[contentType]}`;
}

const bucket = (client: SupabaseClient) => client.storage.from(PURCHASE_ATTACHMENT_BUCKET);

/** Delete objects this attempt uploaded. Returns false if the cleanup itself failed (never throws). */
export async function removeAttachments(client: SupabaseClient, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await bucket(client).remove(paths);
    return !error;
  } catch {
    return false;
  }
}

/** Short-lived authenticated link for an ADMIN to view one attachment (private bucket: no public URL exists). */
export async function attachmentSignedUrl(client: SupabaseClient, path: string, seconds = 60): Promise<string> {
  const { data, error } = await bucket(client).createSignedUrl(path, seconds);
  if (error || !data) throw new TargetDbError('ATTACHMENT_NOT_AVAILABLE', error?.message ?? '');
  return data.signedUrl;
}

type PurchaseInput = Omit<Parameters<typeof registerPurchase>[1], 'attachments'>;

/**
 * Upload → register_purchase, with compensation. `onCleanupFailure` receives only the object keys (no secrets)
 * so the caller can report them; the thrown error is always the original upload / purchase error.
 */
export async function createPurchaseWithAttachments(client: SupabaseClient, p: PurchaseInput & {
  userId: string; files: (AttachmentFile & Blob)[]; onCleanupFailure?: (paths: string[]) => void;
}) {
  validateAttachments(p.files);
  const { userId, files, onCleanupFailure, ...purchase } = p;
  const uploaded: AttachmentMeta[] = [];
  const compensate = async () => {
    const paths = uploaded.map((a) => a.storage_path);
    if (!(await removeAttachments(client, paths))) onCleanupFailure?.(paths);
  };

  for (const f of files) {
    const path = attachmentPath(userId, f.type);
    const { error } = await bucket(client).upload(path, f, { contentType: f.type, upsert: false });
    if (error) {
      await compensate();
      throw new TargetDbError('ATTACHMENT_UPLOAD_FAILED', error.message);
    }
    uploaded.push({ storage_path: path, file_name: f.name.slice(0, 255), content_type: f.type, byte_size: f.size });
  }

  try {
    return await registerPurchase(client, { ...purchase, attachments: uploaded });
  } catch (err) {
    await compensate();
    throw err;
  }
}
