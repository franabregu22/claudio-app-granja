/**
 * ADR-018 — bank statement parser entry point (shared library; the Edge Function wires HTTP, auth and Storage).
 *
 * parseStatementPdf(bytes, config) → ParseResult, mapping 1:1 onto fin_import_bank_statement (0075):
 *   ok    → format_code, parser_version, coverage_from / coverage_to, source_meta, rows (p_rows contract)
 *   !ok   → reject_reason ("CODE: detail"), parser_version (never null), format_code (null when not recognised)
 * The adapter is selected by the account's configured format_code — never detected from the file.
 * The only runtime dependency is the pinned unpdf (PDF.js 6.1.200), ADR-018 §7.5.
 */
// deno-lint-ignore no-import-prefix -- exact pin approved by ADR-018 §7.5 (no deno.json in this repository)
import * as unpdf from 'npm:unpdf@1.8.1';
import { BNA_PARSER_VERSION, parseBnaMonthlyPdfV1 } from './adapters/bna-monthly-pdf-v1.ts';
import { PATAGONIA_PARSER_VERSION, parsePatagoniaStatementPdfV1 } from './adapters/patagonia-statement-pdf-v1.ts';
import {
  type ExtractLimits, FORMAT_CODES, type FormatCode, type PageText, type ParsedStatement, type ParseResult, StatementReject,
  type StatementAccountConfig,
} from './types.ts';
import { DEFAULT_LIMITS, extractText, type PdfLibrary } from './unpdf.ts';

export * from './types.ts';
export { DEFAULT_LIMITS, extractText, pageRows, type PdfLibrary } from './unpdf.ts';

/** parser_version recorded when no adapter recognised the file (the attempt's version is never null, ADR-018 §6.1). */
export const DETECTOR_VERSION = 'bank-statement/1.0.0 unpdf-1.8.1';
export const PARSER_VERSIONS: Record<FormatCode, string> = {
  BNA_MONTHLY_PDF_V1: BNA_PARSER_VERSION,
  PATAGONIA_STATEMENT_PDF_V1: PATAGONIA_PARSER_VERSION,
};
const ADAPTERS: Record<FormatCode, (pages: PageText[], cfg: StatementAccountConfig) => ParsedStatement> = {
  BNA_MONTHLY_PDF_V1: parseBnaMonthlyPdfV1,
  PATAGONIA_STATEMENT_PDF_V1: parsePatagoniaStatementPdfV1,
};

export const PINNED_PDF_LIBRARY: PdfLibrary = unpdf as unknown as PdfLibrary;

/** Runs the configured adapter on already extracted pages (exposed for tests and tooling). */
export function parseStatementPages(pages: PageText[], cfg: StatementAccountConfig): ParsedStatement {
  if (!FORMAT_CODES.includes(cfg.format_code)) throw new StatementReject('FORMAT_NOT_RECOGNISED', `unknown format_code ${cfg.format_code}`);
  return ADAPTERS[cfg.format_code](pages, cfg);
}

export async function parseStatementPdf(
  bytes: Uint8Array, cfg: StatementAccountConfig,
  opts: { lib?: PdfLibrary; limits?: ExtractLimits } = {},
): Promise<ParseResult> {
  const known = FORMAT_CODES.includes(cfg.format_code);
  try {
    const pages = await extractText(bytes, opts.lib ?? PINNED_PDF_LIBRARY, opts.limits ?? DEFAULT_LIMITS);
    return { ok: true, statement: parseStatementPages(pages, cfg) };
  } catch (e) {
    if (!(e instanceof StatementReject)) throw e;
    // a file the adapter could not even recognise is recorded with format_code NULL and the detector's version
    const recognised = known && !['NOT_A_PDF', 'INVALID_PDF', 'FILE_TOO_LARGE', 'TOO_MANY_PAGES', 'EXTRACTION_TIMEOUT', 'TEXT_NOT_EXTRACTABLE', 'FORMAT_NOT_RECOGNISED'].includes(e.code);
    return {
      ok: false, code: e.code, detail: e.detail,
      parser_version: recognised ? PARSER_VERSIONS[cfg.format_code] : DETECTOR_VERSION,
      format_code: recognised ? cfg.format_code : null,
      reject_reason: e.message,
    };
  }
}
