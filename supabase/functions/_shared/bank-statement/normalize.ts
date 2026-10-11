/**
 * NON-AUTHORITATIVE reference of ADR-018 §7.1 — tests and debugging only.
 *
 * PostgreSQL `fin_norm_description` and `fin_statement_fingerprint` (migration 0075) are the ONLY production
 * authority for description_norm and fingerprints; fin_import_bank_statement computes both from description_raw.
 * The parser never sends either. This module mirrors them so tests can prove byte-for-byte parity.
 */
import type { EconomicRow, FormatCode } from './types.ts';

export function referenceNormDescription(s: string): string {
  const v = s.normalize('NFKD');
  // deno-lint-ignore no-control-regex -- detecting these control characters IS the frozen §7.1 rule
  if (/[\x00-\x08\x0E-\x1F\x7F]/.test(v)) throw new Error('DESCRIPTION_CONTROL_CHAR');
  // deno-lint-ignore no-control-regex -- removing every code point above U+007F (§7.1 step 3)
  return v.replace(/[^\x00-\x7F]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/[\t\n\v\f\r ]+/g, ' ').replace(/^ +| +$/g, '');
}

/** The canonical string hashed by fin_statement_fingerprint (fields joined with U+001F). */
export function referenceFingerprintInput(format: FormatCode, l: Pick<EconomicRow, 'value_date' | 'description_raw' | 'bank_reference' | 'fecha_valor' | 'signed_amount' | 'running_balance'>): string {
  const norm = referenceNormDescription(l.description_raw);
  return (format === 'BNA_MONTHLY_PDF_V1'
    ? [l.value_date, norm, l.bank_reference, l.signed_amount, l.running_balance ?? '']
    : [l.value_date, norm, l.bank_reference, l.fecha_valor ?? '', l.signed_amount, l.running_balance ?? '']).join('\x1f');
}

export async function referenceFingerprint(format: FormatCode, l: Parameters<typeof referenceFingerprintInput>[1]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(referenceFingerprintInput(format, l)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
