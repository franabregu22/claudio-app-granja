/**
 * ADR-018 — bank statement parser types (shared library; no HTTP, no database).
 *
 * The parser turns one original statement file into the p_rows / source_meta contract of
 * fin_import_bank_statement (migration 0075). It never computes the authoritative description_norm, fingerprint,
 * NEW / ALREADY_KNOWN, or any content rule the database owns (balance chain, coverage, TRANSPORTE, duplicates,
 * reissue): PostgreSQL is the single authority for those.
 */

/** Frozen adapters (ADR-018 §7.2 / §7.3). Selected from fin_statement_account_config.format_code, never detected. */
export type FormatCode = 'BNA_MONTHLY_PDF_V1' | 'PATAGONIA_STATEMENT_PDF_V1';
export const FORMAT_CODES: readonly FormatCode[] = ['BNA_MONTHLY_PDF_V1', 'PATAGONIA_STATEMENT_PDF_V1'];

/** Parser-level rejection codes; sent to fin_import_bank_statement as p_reject_reason ("CODE: detail"). */
export type RejectCode =
  | 'NOT_A_PDF' | 'INVALID_PDF' | 'FILE_TOO_LARGE' | 'TOO_MANY_PAGES' | 'EXTRACTION_TIMEOUT' | 'TEXT_NOT_EXTRACTABLE'
  | 'FORMAT_NOT_RECOGNISED' | 'ACCOUNT_MISMATCH' | 'UNSUPPORTED_STRUCTURE' | 'UNCLASSIFIABLE_ROW';

export class StatementReject extends Error {
  readonly code: RejectCode;
  readonly detail: string;
  constructor(code: RejectCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

/** Expected identifiers of the selected account (fin_statement_account_config, K-1). */
export interface StatementAccountConfig {
  format_code: FormatCode;
  expected_account_number: string;
  expected_cbu: string;
  expected_extra: Record<string, string>;
}

/** One text item as extracted (PDF.js text content): string, left x, distance of the baseline from the page top, width. */
export interface TextItem { str: string; x: number; top: number; w: number }
export interface PageText { n: number; items: TextItem[] }

/** A word recovered from an item, and a physical row (words sharing a baseline), in page order. */
export interface Word { text: string; x0: number; x1: number; top: number }
export interface Row { page: number; index: number; top: number; words: Word[]; text: string }

/** Evidence of one physical row, stored verbatim as fin_import_run_line.raw_row. */
export interface RawRow { page: number; physical_row: number; text: string; words: { t: string; x0: number; x1: number }[] }

/** Appearance metadata (fin_import_run_line.appearance_meta): position in the file, never part of the fact. */
export interface AppearanceMeta {
  page: number;
  physical_row: number;
  transfer_detail?: TransferDetailMeta;
  detail_of_row?: number;
  [k: string]: unknown;
}
export interface TransferDetailMeta { date: string; imp_original: string | null; nombre_orig: string }

interface RowBase { row_number: number; raw_row: RawRow; appearance_meta: AppearanceMeta; review_code?: string | null; note?: string | null }
/** A statement movement. description_raw is as printed; amounts are canonical strings ('-?d+.dd'). */
export interface EconomicRow extends RowBase {
  kind: 'ECONOMIC';
  statement_position: number;
  value_date: string;
  description_raw: string;
  bank_reference: string;
  fecha_valor: string | null;
  signed_amount: string;
  running_balance: string | null;
}
/** SALDO ANTERIOR / TRANSPORTE / SALDO FINAL / SALDO ACTUAL / TOTAL (the totals block): evidence, never a fact. */
export interface ControlRow extends RowBase { kind: 'CONTROL'; control_type: string; balance: string | null }
/** Secondary detail (Patagonia TRANSFERENCIAS RECIBIDAS): evidence, never a fact. */
export interface DetailRow extends RowBase { kind: 'DETAIL' }
export type ImportRow = EconomicRow | ControlRow | DetailRow;
/** A row before its row_number is assigned (distributive over the three kinds). */
export type NewImportRow = Omit<EconomicRow, 'row_number'> | Omit<ControlRow, 'row_number'> | Omit<DetailRow, 'row_number'>;

/** p_source_meta of fin_import_bank_statement. */
export interface SourceMeta { opening_balance: string; closing_balance: string; [k: string]: unknown }

/** Everything fin_import_bank_statement needs from the parser (the file metadata comes from the caller). */
export interface ParsedStatement {
  format_code: FormatCode;
  parser_version: string;
  coverage_from: string | null;
  coverage_to: string;
  source_meta: SourceMeta;
  rows: ImportRow[];
}

export type ParseResult =
  | { ok: true; statement: ParsedStatement }
  | { ok: false; code: RejectCode; detail: string; parser_version: string; format_code: FormatCode | null; reject_reason: string };

export interface ExtractLimits { maxBytes: number; maxPages: number; timeoutMs: number }
