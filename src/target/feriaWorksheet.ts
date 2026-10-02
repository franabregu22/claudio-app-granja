/**
 * ADR-016 — Feria worksheets in the PRIVATE Storage bucket `feria-worksheets` (migration 0070: ADMIN-only SELECT /
 * INSERT / DELETE, own-folder INSERT, 10 MB, PDF / JPEG / PNG / WebP; no public URL; never `purchase-attachments`).
 * The worksheet is optional and never blocks a closing; no OCR.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { attachmentPath, validateAttachments, type AttachmentFile, type AttachmentMeta } from './attachments';
import { TargetDbError } from './db';

export const FERIA_WORKSHEET_BUCKET = 'feria-worksheets';

const worksheets = (client: SupabaseClient) => client.storage.from(FERIA_WORKSHEET_BUCKET);

/** Short-lived link for an ADMIN (private bucket: no public URL exists). */
export async function worksheetSignedUrl(client: SupabaseClient, path: string, seconds = 60): Promise<string> {
  const { data, error } = await worksheets(client).createSignedUrl(path, seconds);
  if (error || !data) throw new TargetDbError('ATTACHMENT_NOT_AVAILABLE', error?.message ?? '');
  return data.signedUrl;
}

/**
 * Optional worksheet → backend call, with compensation (ADR-008 pattern on `feria-worksheets`): the file is uploaded
 * under `<auth-user-id>/<uuid>.<ext>`; if the backend call fails the uploaded object is deleted and the ORIGINAL
 * error is thrown. A failed cleanup is reported through onCleanupFailure (object key only) and never replaces it.
 */
export async function withWorksheet<T>(client: SupabaseClient, p: {
  userId: string; file: (AttachmentFile & Blob) | null; onCleanupFailure?: (paths: string[]) => void;
}, call: (worksheet: AttachmentMeta | null) => Promise<T>): Promise<T> {
  if (!p.file) return call(null);
  validateAttachments([p.file]);
  const path = attachmentPath(p.userId, p.file.type);
  const { error } = await worksheets(client).upload(path, p.file, { contentType: p.file.type, upsert: false });
  if (error) throw new TargetDbError('WORKSHEET_UPLOAD_FAILED', error.message);
  try {
    return await call({ storage_path: path, file_name: p.file.name.slice(0, 255), content_type: p.file.type, byte_size: p.file.size });
  } catch (err) {
    let removed = false;
    try { removed = !(await worksheets(client).remove([path])).error; } catch { removed = false; }
    if (!removed) p.onCleanupFailure?.([path]);
    throw err;
  }
}
