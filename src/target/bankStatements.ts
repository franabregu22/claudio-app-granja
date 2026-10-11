/**
 * ADR-018 — bank statement import (ADMIN). Presentation / transport only: the Edge Function `fin-statement-import`
 * is the only write path (it derives the actor, format, identifiers, parser version, hash and storage path server-side)
 * and fin_import_run is read under RLS (ADMIN policy). The browser never uploads to Storage and never writes fin_* tables.
 *
 * The request carries exactly:
 *   upload    → multipart: financial_account_id + one PDF file
 *   reprocess → JSON: { action: 'reprocess', previous_run_id }
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readTable, TargetDbError } from './db';

export const IMPORT_FUNCTION = 'fin-statement-import';
export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

export interface StatementAccount { id: string; nombre: string }
export type ImportRunStatus = 'PARSED' | 'VALIDATED' | 'REJECTED';
export interface ImportCounters {
  rows_total: number; lines_new: number; lines_known: number; rows_ignored: number; rows_invalid: number; rows_captured: number;
}
export interface ImportRun extends ImportCounters {
  id: string; created_at: string; financial_account_id: string; cuenta: string; file_name: string; file_sha256: string;
  source_kind: string; mode: string; status: ImportRunStatus; parser_version: string; reject_reason: string | null;
  previous_run_id: string | null;
}
/** The Edge Function's response (HTTP 200). */
export interface ImportResult {
  run_id: string; status: ImportRunStatus; replayed: boolean; financial_account_id: string; file_sha256: string;
  parser_version: string; format_code: string | null; counters: ImportCounters; reject_reason: string | null;
}

/** Active bank accounts with an active statement configuration. Only id and name are read (no CBU / account number). */
export async function listStatementAccounts(client: SupabaseClient): Promise<StatementAccount[]> {
  const configs = await readTable<{ financial_account_id: string }>(client, 'fin_statement_account_config',
    (q) => q.eq('activo', true), 'financial_account_id');
  const ids = configs.map((c) => c.financial_account_id);
  if (ids.length === 0) return [];
  const accounts = await readTable<StatementAccount>(client, 'financial_account',
    (q) => q.eq('activo', true).eq('account_type', 'BANK_ACCOUNT').in('id', ids).order('nombre'), 'id, nombre');
  return accounts.map(({ id, nombre }) => ({ id, nombre }));
}

const RUN_COLUMNS = 'id, created_at, financial_account_id, file_name, file_sha256, source_kind, mode, status, parser_version, reject_reason, '
  + 'previous_run_id, rows_total, lines_new, lines_known, rows_ignored, rows_invalid, rows_captured, financial_account(nombre)';

/** Recent bank statement runs, newest first (bounded). */
export async function listImportRuns(client: SupabaseClient, limit = 50): Promise<ImportRun[]> {
  const rows = await readTable<Omit<ImportRun, 'cuenta'> & { financial_account: { nombre: string } | null }>(client, 'fin_import_run',
    (q) => q.eq('source_kind', 'BANK_STATEMENT').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit),
    RUN_COLUMNS);
  return rows.map(({ financial_account, ...r }) => ({ ...r, cuenta: financial_account?.nombre ?? '—' }));
}

/**
 * Reprocess is offered for a REJECTED bank run that is still the latest attempt of its file (the backend accepts only
 * the latest attempt as previous_run_id). `runs` is the loaded history; the backend stays the authority.
 */
export function canReprocess(run: ImportRun, runs: ImportRun[]): boolean {
  if (run.status !== 'REJECTED' || run.source_kind !== 'BANK_STATEMENT') return false;
  return !runs.some((r) => r.id !== run.id && r.financial_account_id === run.financial_account_id && r.file_sha256 === run.file_sha256
    && (r.created_at > run.created_at || r.previous_run_id === run.id));
}

/** UX validation before any request (the Edge Function validates the same and more, server-side). */
export function validateStatementFile(file: { name: string; type: string; size: number } | null | undefined): void {
  if (!file) throw new TargetDbError('FILE_REQUIRED', '');
  const pdf = file.type === 'application/pdf' || (file.type === '' && /\.pdf$/i.test(file.name));
  if (!pdf) throw new TargetDbError('NOT_A_PDF', '');
  if (file.size <= 0) throw new TargetDbError('EMPTY_FILE', '');
  if (file.size > MAX_STATEMENT_BYTES) throw new TargetDbError('FILE_TOO_LARGE', '');
}

/** The import button is enabled only with an account, one valid PDF and no import in flight. */
export function canSubmitImport(p: { accountId: string; file: { name: string; type: string; size: number } | null; pending: boolean }): boolean {
  if (p.pending || !p.accountId || !p.file) return false;
  try { validateStatementFile(p.file); return true; } catch { return false; }
}

/** Edge errors arrive as HTTP status + {"error": CODE}; anything else is a transport failure. */
async function invoke(client: SupabaseClient, body: FormData | Record<string, unknown>): Promise<ImportResult> {
  const { data, error } = await client.functions.invoke<ImportResult>(IMPORT_FUNCTION, { method: 'POST', body });
  if (!error) {
    if (!data || typeof data !== 'object' || typeof data.run_id !== 'string') throw new TargetDbError('IMPORT_FAILED', 'unexpected response');
    return data;
  }
  const response = (error as { context?: unknown }).context;
  if (response instanceof Response) {
    const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    const code = typeof payload?.error === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(payload.error) ? payload.error : null;
    if (code) throw new TargetDbError(code, `HTTP ${response.status}`);
    if (response.status === 401) throw new TargetDbError('NOT_AUTHENTICATED', 'HTTP 401');
    throw new TargetDbError('IMPORT_FAILED', `HTTP ${response.status}`);
  }
  throw new TargetDbError('IMPORT_UNREACHABLE', '');
}

/** Upload one PDF for one account. Nothing else is sent: the Edge Function derives every other field. */
export async function importStatement(client: SupabaseClient, p: { accountId: string; file: Blob & { name: string; type: string; size: number } }) {
  validateStatementFile(p.file);
  if (!p.accountId) throw new TargetDbError('ACCOUNT_REQUIRED', '');
  const form = new FormData();
  form.append('financial_account_id', p.accountId);
  form.append('file', p.file, p.file.name);
  return invoke(client, form);
}

/** Re-parse the stored bytes of a REJECTED run with the current parser version. Only the run id is sent. */
export async function reprocessRun(client: SupabaseClient, previousRunId: string) {
  return invoke(client, { action: 'reprocess', previous_run_id: previousRunId });
}

/** Contract code of a reject reason ("CODE: detail" → CODE); only the code is ever shown. */
export function rejectCode(reason: string | null | undefined): string | null {
  return /^([A-Z][A-Z0-9_]{2,})/.exec(reason ?? '')?.[1] ?? null;
}

const REJECT_MESSAGES: Record<string, string> = {
  NOT_A_PDF: 'El archivo seleccionado no es un PDF válido.',
  INVALID_PDF: 'El PDF está dañado o no puede leerse.',
  FILE_TOO_LARGE: 'El archivo supera el límite permitido de 10 MB.',
  TOO_MANY_PAGES: 'El extracto tiene más páginas de las admitidas.',
  EXTRACTION_TIMEOUT: 'El PDF tardó demasiado en procesarse.',
  TEXT_NOT_EXTRACTABLE: 'No se pudo extraer texto del PDF.',
  FORMAT_NOT_RECOGNISED: 'El archivo no corresponde al formato esperado para esta cuenta.',
  ACCOUNT_MISMATCH: 'Los datos del extracto no coinciden con la cuenta seleccionada.',
  UNSUPPORTED_STRUCTURE: 'El banco cambió el formato del extracto o el archivo tiene una estructura no compatible.',
  UNCLASSIFIABLE_ROW: 'Hay una fila del extracto que no puede clasificarse de forma segura.',
  REISSUE_SUSPECTED: 'El extracto parece ser una reemisión con diferencias respecto de uno ya importado.',
  DUPLICATE_CONTENT_IN_STATEMENT: 'El extracto contiene movimientos duplicados que no pueden resolverse automáticamente.',
};

export function rejectMessage(reason: string | null | undefined): string {
  return REJECT_MESSAGES[rejectCode(reason) ?? ''] ?? 'No se pudo procesar el extracto.';
}

export const RUN_STATUS_LABEL: Record<ImportRunStatus, string> = { PARSED: 'Importado', REJECTED: 'Rechazado', VALIDATED: 'Validado' };
