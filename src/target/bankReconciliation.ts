/**
 * ADR-018 — bank statement reconciliation and cut (ADMIN). Presentation / transport only.
 *
 * Reads: fin_statement_line_status (0076: derived cut classification + active match; RLS / ADMIN filter),
 *        fin_statement_cutover and fin_statement_match (ADMIN SELECT policies), financial_posting / financial_operation.
 * Writes: only the three contract RPCs of 0075 — fin_match_statement_line, fin_reverse_statement_match and
 *        fin_resolve_statement_cutover. The database decides the classification, the 1:1 rule and the K-4 balance;
 *        the UI only mirrors the contract (which actions it offers) and never writes a fin_* table.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, normalizeDbError, readTable, readView, TargetDbError } from './db';
import { messageFor } from './messages';

export const CUTOVER_CLASSES = ['POST_CUTOVER', 'PRE_CUTOVER', 'CUTOVER_UNRESOLVED', 'CUTOVER_AMBIGUOUS_DAY'] as const;
export type CutoverClass = (typeof CUTOVER_CLASSES)[number];
export type ReconciliationStatus = 'MATCHED' | 'UNMATCHED';

export const CUTOVER_LABEL: Record<CutoverClass, string> = {
  CUTOVER_UNRESOLVED: 'Corte pendiente',
  PRE_CUTOVER: 'Incluido en saldo inicial',
  POST_CUTOVER: 'A conciliar',
  CUTOVER_AMBIGUOUS_DAY: 'Día ambiguo',
};
export const RECONCILIATION_LABEL: Record<ReconciliationStatus, string> = { MATCHED: 'Conciliado', UNMATCHED: 'Sin conciliar' };

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export interface StatementLine {
  statement_line_id: number; financial_account_id: string; value_date: string; description_raw: string; bank_reference: string;
  fecha_valor: string | null; signed_amount: number; running_balance: number | null;
  active_cutover_id: number | null; cutoff_statement_line_id: number | null; opening_balance: number | null;
  cutover_classification: CutoverClass | null; active_match_id: number | null; financial_operation_id: number | null;
  financial_posting_id: number | null; matched_at: string | null; match_reason: string | null; reconciliation_status: ReconciliationStatus;
}
const LINE_COLUMNS = 'statement_line_id, financial_account_id, value_date, description_raw, bank_reference, fecha_valor, signed_amount, '
  + 'running_balance, active_cutover_id, cutoff_statement_line_id, opening_balance, cutover_classification, active_match_id, '
  + 'financial_operation_id, financial_posting_id, matched_at, match_reason, reconciliation_status';
const toLine = (r: StatementLine): StatementLine => ({
  ...r, signed_amount: Number(r.signed_amount), running_balance: num(r.running_balance), opening_balance: num(r.opening_balance),
});

export interface LineFilters {
  accountId: string; cutover: CutoverClass | 'ALL'; reconciliation: ReconciliationStatus | 'ALL'; from?: string; to?: string; search?: string;
}
export const DEFAULT_FILTERS: Omit<LineFilters, 'accountId'> = { cutover: 'POST_CUTOVER', reconciliation: 'UNMATCHED' };

/** Characters with a meaning in a PostgREST or() / ilike filter are dropped from the free-text search. */
export function searchTerm(raw: string | undefined): string {
  return (raw ?? '').replace(/[,()*%\\:"']/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Statement lines of one account with their derived classification and match state, newest first (bounded). */
export async function listStatementLines(client: SupabaseClient, f: LineFilters, limit = 200): Promise<StatementLine[]> {
  if (!f.accountId) return [];
  const term = searchTerm(f.search);
  const rows = await readView<StatementLine>(client, 'fin_statement_line_status', (q) => {
    let x = q.eq('financial_account_id', f.accountId);
    if (f.cutover !== 'ALL') x = x.eq('cutover_classification', f.cutover);
    if (f.reconciliation !== 'ALL') x = x.eq('reconciliation_status', f.reconciliation);
    if (f.from) x = x.gte('value_date', f.from);
    if (f.to) x = x.lte('value_date', f.to);
    if (term) x = x.or(`description_raw.ilike.*${term}*,bank_reference.ilike.*${term}*`);
    return x.order('value_date', { ascending: false }).order('statement_line_id', { ascending: false }).limit(limit);
  }, LINE_COLUMNS);
  return rows.map(toLine);
}

/** The contract mirrored by the UI: only an unmatched POST_CUTOVER line is reconcilable; a matched one is reversible. */
export const canMatch = (l: Pick<StatementLine, 'cutover_classification' | 'reconciliation_status'>) =>
  l.cutover_classification === 'POST_CUTOVER' && l.reconciliation_status === 'UNMATCHED';
export const canReverse = (l: Pick<StatementLine, 'reconciliation_status' | 'active_match_id'>) =>
  l.reconciliation_status === 'MATCHED' && l.active_match_id !== null;

// ── bank history in Caja (read-only evidence; never money) ───────────────────────────────────────────────────────
/** Status of an imported bank line as shown in Caja → account → Movimientos bancarios. */
export function bankHistoryStatus(l: Pick<StatementLine, 'cutover_classification' | 'reconciliation_status'>): string {
  switch (l.cutover_classification) {
    case 'CUTOVER_UNRESOLVED': return 'Corte pendiente';
    case 'PRE_CUTOVER': return 'Histórico';
    case 'POST_CUTOVER': return l.reconciliation_status === 'MATCHED' ? 'Conciliado' : 'Pendiente de conciliar';
    case 'CUTOVER_AMBIGUOUS_DAY': return 'Revisar corte';
    default: return 'Sin clasificar';
  }
}
/** The discreet notice of an account whose statement cut is not defined yet (its lines are shown anyway). */
export const needsCutoverNotice = (lines: Pick<StatementLine, 'cutover_classification'>[]) =>
  lines.some((l) => l.cutover_classification === 'CUTOVER_UNRESOLVED');
export const CUTOVER_NOTICE = 'Estos movimientos provienen del extracto bancario. Todavía no se definió desde qué punto comienza la conciliación.';

/**
 * Every imported line of one bank account, whatever its cut classification (historical statements before the ERP start
 * included). Reads only fin_statement_line_status: bank evidence, never financial_posting, so the ERP balance is untouched.
 */
export function listBankHistory(client: SupabaseClient, accountId: string, limit = 2000) {
  return listStatementLines(client, { accountId, cutover: 'ALL', reconciliation: 'ALL' }, limit);
}

// ── manual 1:1 match ─────────────────────────────────────────────────────────────────────────────────────────────
export interface PostingCandidate {
  id: number; financial_operation_id: number; signed_amount: number; effective_date: string; operation_type: string;
  external_ref: string | null; reason: string | null; source_entity_type: string | null;
  already_matched: boolean; days_from_line: number;
}
const daysBetween = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * Candidates for a line: postings of the SAME account with EXACTLY the line's signed amount. Postings that already
 * have an active match are returned flagged (shown disabled; the RPC stays the final defence). The date distance is a
 * visual ordering aid only — never a rule. Nothing is selected automatically.
 */
export async function listPostingCandidates(client: SupabaseClient, line: Pick<StatementLine, 'financial_account_id' | 'signed_amount' | 'value_date'>,
  limit = 100): Promise<PostingCandidate[]> {
  type Raw = { id: number; financial_operation_id: number; signed_amount: number | string; effective_date: string;
    financial_operation: { operation_type: string; external_ref: string | null; reason: string | null; source_entity_type: string | null } | null };
  const postings = await readTable<Raw>(client, 'financial_posting',
    (q) => q.eq('financial_account_id', line.financial_account_id).eq('signed_amount', line.signed_amount.toFixed(2))
      .order('effective_date', { ascending: false }).limit(limit),
    'id, financial_operation_id, signed_amount, effective_date, financial_operation(operation_type, external_ref, reason, source_entity_type)');
  const ids = postings.map((p) => p.id);
  const active = ids.length === 0 ? [] : await readTable<{ financial_posting_id: number }>(client, 'fin_statement_match',
    (q) => q.in('financial_posting_id', ids).is('reversed_at', null), 'financial_posting_id');
  const taken = new Set(active.map((m) => Number(m.financial_posting_id)));
  return postings
    // defensive: only exact same-account, same-amount rows are ever offered
    .filter((p) => Number(p.signed_amount) === line.signed_amount)
    .map((p) => ({
      id: p.id, financial_operation_id: p.financial_operation_id, signed_amount: Number(p.signed_amount), effective_date: p.effective_date,
      operation_type: p.financial_operation?.operation_type ?? '—', external_ref: p.financial_operation?.external_ref ?? null,
      reason: p.financial_operation?.reason ?? null, source_entity_type: p.financial_operation?.source_entity_type ?? null,
      already_matched: taken.has(Number(p.id)), days_from_line: daysBetween(p.effective_date, line.value_date),
    }))
    .sort((a, b) => Number(a.already_matched) - Number(b.already_matched) || a.days_from_line - b.days_from_line || b.id - a.id);
}

/** fin_match_statement_line: the line and the ONE posting the user chose; the operation is derived by the database. */
export function matchStatementLine(client: SupabaseClient, p: { statementLineId: number; postingId: number; reason?: string | null }) {
  return callRpc<{ match_id: number; financial_operation_id: number; replayed: boolean }>(client, 'fin_match_statement_line', {
    p_statement_line_id: p.statementLineId, p_financial_posting_id: p.postingId, p_reason: p.reason?.trim() ? p.reason.trim() : null,
  });
}

export interface MatchDetail {
  id: number; matched_at: string; reason: string | null; financial_posting_id: number; financial_operation_id: number;
  posting_date: string | null; posting_amount: number | null; operation_type: string | null; external_ref: string | null; operation_reason: string | null;
}
export async function getMatchDetail(client: SupabaseClient, matchId: number): Promise<MatchDetail | null> {
  type Raw = { id: number; matched_at: string; reason: string | null; financial_posting_id: number; financial_operation_id: number;
    financial_posting: { effective_date: string; signed_amount: number | string } | null;
    financial_operation: { operation_type: string; external_ref: string | null; reason: string | null } | null };
  const [m] = await readTable<Raw>(client, 'fin_statement_match', (q) => q.eq('id', matchId).limit(1),
    'id, matched_at, reason, financial_posting_id, financial_operation_id, financial_posting(effective_date, signed_amount), '
    + 'financial_operation(operation_type, external_ref, reason)');
  if (!m) return null;
  return {
    id: m.id, matched_at: m.matched_at, reason: m.reason, financial_posting_id: m.financial_posting_id, financial_operation_id: m.financial_operation_id,
    posting_date: m.financial_posting?.effective_date ?? null, posting_amount: num(m.financial_posting?.signed_amount),
    operation_type: m.financial_operation?.operation_type ?? null, external_ref: m.financial_operation?.external_ref ?? null,
    operation_reason: m.financial_operation?.reason ?? null,
  };
}

/** fin_reverse_statement_match: the reason is mandatory (checked here for UX and again by the database). */
export function reverseStatementMatch(client: SupabaseClient, p: { matchId: number; reason: string }) {
  if (!p.reason?.trim()) throw new TargetDbError('REASON_REQUIRED', '');
  return callRpc<{ match_id: number; reversed: boolean }>(client, 'fin_reverse_statement_match', { p_match_id: p.matchId, p_reason: p.reason.trim() });
}

// ── statement cut ────────────────────────────────────────────────────────────────────────────────────────────────
export interface CutoverRow {
  id: number; opening_balance: number; cutoff_statement_line_id: number; resolved_at: string; evidence_note: string;
  superseded_by: number | null; superseded_at: string | null; supersede_reason: string | null;
  anchor: Pick<StatementLine, 'value_date' | 'description_raw' | 'signed_amount' | 'running_balance'> | null;
}
/** Every cut of the account (active first, then superseded history, newest first) with its anchor line. */
export async function listCutovers(client: SupabaseClient, accountId: string): Promise<CutoverRow[]> {
  if (!accountId) return [];
  type Raw = Omit<CutoverRow, 'anchor'>;
  const cuts = await readTable<Raw>(client, 'fin_statement_cutover', (q) => q.eq('financial_account_id', accountId).order('id', { ascending: false }),
    'id, opening_balance, cutoff_statement_line_id, resolved_at, evidence_note, superseded_by, superseded_at, supersede_reason');
  const anchorIds = [...new Set(cuts.map((c) => c.cutoff_statement_line_id))];
  const anchors = anchorIds.length === 0 ? [] : await readView<StatementLine>(client, 'fin_statement_line_status',
    (q) => q.in('statement_line_id', anchorIds), 'statement_line_id, value_date, description_raw, signed_amount, running_balance');
  return cuts
    .map((c) => {
      const a = anchors.find((x) => Number(x.statement_line_id) === Number(c.cutoff_statement_line_id));
      return { ...c, opening_balance: Number(c.opening_balance),
        anchor: a ? { value_date: a.value_date, description_raw: a.description_raw, signed_amount: Number(a.signed_amount), running_balance: num(a.running_balance) } : null };
    })
    .sort((a, b) => Number(a.superseded_at !== null) - Number(b.superseded_at !== null) || b.id - a.id);
}
export const activeCutover = (cuts: CutoverRow[]) => cuts.find((c) => c.superseded_at === null) ?? null;

export interface AnchorCandidate extends Pick<StatementLine, 'statement_line_id' | 'value_date' | 'description_raw' | 'signed_amount'> {
  running_balance: number; same_day_lines: number;
}
/**
 * Lines that can be proposed as the cut anchor: same account and a bank-reported running balance (K-4). For
 * Patagonia, `same_day_lines` > 0 warns that the database will refuse an anchor that shares its date
 * (ANCHOR_AMBIGUOUS_DAY); the function remains the authority.
 */
export async function listAnchorCandidates(client: SupabaseClient, accountId: string, limit = 500): Promise<AnchorCandidate[]> {
  if (!accountId) return [];
  const rows = await readView<StatementLine>(client, 'fin_statement_line_status',
    (q) => q.eq('financial_account_id', accountId).order('value_date', { ascending: false }).order('statement_line_id', { ascending: false }).limit(limit),
    'statement_line_id, value_date, description_raw, signed_amount, running_balance');
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.value_date, (perDay.get(r.value_date) ?? 0) + 1);
  return rows
    .filter((r) => r.running_balance !== null && r.running_balance !== undefined)
    .map((r) => ({ statement_line_id: r.statement_line_id, value_date: r.value_date, description_raw: r.description_raw,
      signed_amount: Number(r.signed_amount), running_balance: Number(r.running_balance), same_day_lines: (perDay.get(r.value_date) ?? 1) - 1 }));
}

/**
 * Lines of the account with an active match (0077: a cut change is refused if any of them would stop being
 * POST_CUTOVER). Used only for a warning; which ones conflict is decided by the database.
 */
export async function countMatchedLines(client: SupabaseClient, accountId: string): Promise<number> {
  if (!accountId) return 0;
  const rows = await readView<{ statement_line_id: number }>(client, 'fin_statement_line_status',
    (q) => q.eq('financial_account_id', accountId).eq('reconciliation_status', 'MATCHED').limit(1000), 'statement_line_id');
  return rows.length;
}

/** Format of the account's statement (only the format code is read from the configuration). */
export async function accountStatementFormat(client: SupabaseClient, accountId: string): Promise<string | null> {
  if (!accountId) return null;
  const [r] = await readTable<{ format_code: string }>(client, 'fin_statement_account_config',
    (q) => q.eq('financial_account_id', accountId).eq('activo', true).limit(1), 'format_code');
  return r?.format_code ?? null;
}

/**
 * fin_resolve_statement_cutover. The opening balance is NOT user input: it is the anchor's bank-reported running
 * balance, sent unchanged (K-4). First cut → supersede reason null; changing an active cut → reason mandatory.
 */
export function resolveStatementCutover(client: SupabaseClient, p: {
  accountId: string; anchor: { statement_line_id: number; running_balance: number | null }; evidenceNote: string; hasActiveCut: boolean;
  supersedeReason?: string | null;
}) {
  if (p.anchor.running_balance === null || p.anchor.running_balance === undefined) throw new TargetDbError('ANCHOR_WITHOUT_BALANCE', '');
  if (!p.evidenceNote?.trim()) throw new TargetDbError('EVIDENCE_REQUIRED', '');
  if (p.hasActiveCut && !p.supersedeReason?.trim()) throw new TargetDbError('SUPERSEDE_REASON_REQUIRED', '');
  return callRpc<{ cutover_id: number; superseded_id: number | null }>(client, 'fin_resolve_statement_cutover', {
    p_account_id: p.accountId, p_cutoff_statement_line_id: p.anchor.statement_line_id, p_opening_balance: p.anchor.running_balance,
    p_evidence_note: p.evidenceNote.trim(), p_supersede_reason: p.hasActiveCut ? p.supersedeReason!.trim() : null,
  });
}

// ── messages (fail closed) ───────────────────────────────────────────────────────────────────────────────────────
const RECON_MESSAGES: Record<string, string> = {
  CUTOVER_UNRESOLVED: 'Primero tenés que definir el corte de esta cuenta.',
  PRE_CUTOVER_LINE: 'Este movimiento ya está incluido en el saldo inicial.',
  CUTOVER_AMBIGUOUS_DAY: 'No se puede determinar con seguridad el orden de los movimientos de ese día.',
  CUTOVER_ORDER_UNAVAILABLE: 'No se puede determinar con seguridad el orden de este movimiento respecto del corte.',
  ACCOUNT_MISMATCH: 'El movimiento elegido no corresponde a esta cuenta.',
  AMOUNT_MISMATCH: 'El importe del movimiento elegido no coincide exactamente con el del extracto.',
  LINE_ALREADY_MATCHED: 'Esta línea del extracto ya fue conciliada.',
  POSTING_ALREADY_MATCHED: 'Ese movimiento ya fue conciliado.',
  MATCH_CONFLICT: 'Ese movimiento ya fue conciliado.',
  STATEMENT_LINE_NOT_FOUND: 'La línea del extracto no existe.',
  POSTING_NOT_FOUND: 'El movimiento elegido no existe.',
  MATCH_NOT_FOUND: 'La conciliación no existe.',
  MATCH_ALREADY_REVERSED: 'Esa conciliación ya fue revertida.',
  REASON_REQUIRED: 'Indicá el motivo.',
  EVIDENCE_REQUIRED: 'Indicá la evidencia o nota del corte.',
  ANCHOR_NOT_FOUND: 'La línea elegida como corte no existe.',
  ANCHOR_NOT_IN_ACCOUNT: 'La línea elegida no pertenece a esta cuenta.',
  ANCHOR_WITHOUT_BALANCE: 'La línea elegida no tiene saldo informado por el banco: no puede ser el corte.',
  OPENING_BALANCE_MISMATCH: 'El saldo inicial debe ser exactamente el saldo informado por el banco en la línea elegida.',
  ANCHOR_AMBIGUOUS_DAY: 'Hay otros movimientos el mismo día que la línea elegida: no se puede usar como corte.',
  SUPERSEDE_REASON_REQUIRED: 'Indicá el motivo del cambio de corte.',
  SUPERSEDE_REASON_NOT_ALLOWED: 'La cuenta no tiene un corte activo para reemplazar.',
  CUTOVER_ACTIVE_MATCH_CONFLICT: 'No se puede cambiar el corte porque hay movimientos conciliados que dejarían de quedar posteriores al nuevo corte. Revertí primero esas conciliaciones.',
  ACCOUNT_NOT_FOUND_OR_NOT_BANK: 'La cuenta no existe, está inactiva o no es una cuenta bancaria.',
  STATEMENT_CONFIG_MISSING: 'La cuenta no tiene configurada la importación de extractos.',
  FORBIDDEN: 'Solo un administrador puede realizar esta acción.',
};
export function reconciliationErrorMessage(err: unknown): string {
  const code = normalizeDbError(err).code;
  return RECON_MESSAGES[code] ?? messageFor(err) ?? 'Esta operación no pudo completarse.';
}

/** Money with cents and visible sign (bank reconciliation is exact to the cent). */
export function importe(n: number | null | undefined, signed = false): string {
  if (n === null || n === undefined) return '—';
  const s = Math.abs(n).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `−${s}` : signed && n > 0 ? `+${s}` : s;
}
