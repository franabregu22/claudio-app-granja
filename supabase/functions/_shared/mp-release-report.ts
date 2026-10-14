/**
 * ADR-018 §9.3 — Mercado Pago release report (Liberaciones), VALIDATION mode: pure helpers shared by the
 * mp-report-ingest Edge Function and its tests. No I/O here.
 *
 *   checkReleaseConfig  GET /v1/account/release_report/config → compatible with the frozen ADR-003 D1 layout?
 *                       Only a whitelist of fields is ever returned or stored (no e-mail list, no file prefix).
 *   businessDayWindow   one America/Argentina/Buenos_Aires calendar day → the UTC begin_date / end_date of the request.
 *   parseReleaseReport  the downloaded bytes → header + one raw_row per data line (every value the exact exported
 *                       string), or a file-level reject reason. Row-level validity (descriptions, amounts, dates,
 *                       SOURCE_ID) is decided by the database with the frozen D1 parser, not here.
 *
 * Fail closed: anything not exactly understood (columns, separator, quoting, encoding, line endings, field counts)
 * rejects the whole file; the parser is never adapted silently.
 */

// 1.1.0 (0080): a valid report with only CONTROL rows is a day without activity (VALIDATED / PARSED, 0 effects), not a
// rejection; CONTROL rows must themselves be well-formed. File-level parsing is unchanged.
export const PARSER_VERSION = 'mp-release-report-csv/1.1.0';
export const FORMAT_CODE = 'MP_RELEASE_REPORT_CSV_V1';
export const BUSINESS_TZ = 'America/Argentina/Buenos_Aires';

/** ADR-003 D1: the exact 15 keys of a Liberaciones row (order is taken from the file header). */
export const EXPECTED_COLUMNS: readonly string[] = Object.freeze([
  'BALANCE_AMOUNT', 'BUSINESS_UNIT', 'DATE', 'DESCRIPTION', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'NET_CREDIT_AMOUNT',
  'NET_DEBIT_AMOUNT', 'PAYMENT_METHOD', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID', 'SOURCE_ID', 'SUB_UNIT', 'TAXES_AMOUNT',
  'TRANSACTION_APPROVAL_DATE',
]);
const SEPARATORS = [';', ','] as const;

/** Configuration fields recorded as evidence (values copied as is). Everything else: key name only. */
const RECORDED_FIELDS = [
  'separator', 'format', 'file_format', 'display_timezone', 'frequency', 'scheduled', 'include_withdrawal_at_end',
  'detailed', 'execute_after_withdrawal', 'check_available_balance', 'compensate_detail', 'refund_detailed',
  'coupon_detailed', 'shipping_detail', 'report_translation', 'header_language',
] as const;

export interface ConfigCheck {
  compatible: boolean;
  problems: string[];
  /** separator to read the file with: the configured one, or null to detect it unambiguously from the header */
  separator: ';' | ',' | null;
  /** sanitized evidence: configured column keys in order, whitelisted fields, names of the other fields */
  evidence: { columns: string[]; fields: Record<string, unknown>; other_keys: string[] };
}

export function checkReleaseConfig(config: unknown): ConfigCheck {
  const problems: string[] = [];
  const evidence: ConfigCheck['evidence'] = { columns: [], fields: {}, other_keys: [] };
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { compatible: false, problems: ['CONFIG_NOT_AN_OBJECT'], separator: null, evidence };
  }
  const c = config as Record<string, unknown>;
  for (const k of Object.keys(c).sort()) {
    if ((RECORDED_FIELDS as readonly string[]).includes(k)) evidence.fields[k] = c[k];
    else if (k !== 'columns') evidence.other_keys.push(k);
  }

  if (!Array.isArray(c.columns)) {
    problems.push('COLUMNS_MISSING');
  } else {
    for (const col of c.columns) {
      const key = col !== null && typeof col === 'object' ? (col as Record<string, unknown>).key : undefined;
      if (typeof key !== 'string' || key === '') { problems.push('COLUMN_MALFORMED'); continue; }
      evidence.columns.push(key);
    }
    const seen = new Set<string>();
    for (const k of evidence.columns) {
      if (seen.has(k)) problems.push(`COLUMN_DUPLICATED:${k}`);
      seen.add(k);
      if (!EXPECTED_COLUMNS.includes(k)) problems.push(`COLUMN_UNEXPECTED:${k}`);
    }
    for (const k of EXPECTED_COLUMNS) if (!seen.has(k)) problems.push(`COLUMN_MISSING:${k}`);
  }

  let separator: ';' | ',' | null = null;
  if (c.separator !== undefined) {
    if (typeof c.separator === 'string' && (SEPARATORS as readonly string[]).includes(c.separator)) separator = c.separator as ';' | ',';
    else problems.push('SEPARATOR_UNSUPPORTED');
  }
  for (const f of ['format', 'file_format']) {
    if (c[f] !== undefined && !(typeof c[f] === 'string' && (c[f] as string).toLowerCase() === 'csv')) problems.push('FORMAT_UNSUPPORTED');
  }
  return { compatible: problems.length === 0, problems, separator, evidence };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset (minutes east of UTC) of the business time zone at an instant. */
function tzOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((local - at.getTime()) / 60000);
}

/** UTC instant of local midnight starting `date` in the business time zone. */
function localMidnightUtc(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMinutes(new Date(guess)) * 60000;
  t = guess - tzOffsetMinutes(new Date(t)) * 60000;   // second pass settles an offset change near midnight
  return t;
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * One complete business day. Returns null for an invalid date, today or a future day (the day must be over).
 * end_date is the last second of the day (begin of the next day minus 1 s).
 */
export function businessDayWindow(date: string, nowMs: number): { begin_date: string; end_date: string } | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const begin = localMidnightUtc(y, mo, d);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  if (end > nowMs) return null;
  return { begin_date: iso(begin), end_date: iso(end - 1000) };
}

export interface ParsedReport {
  ok: true;
  separator: ';' | ',';
  line_ending: 'LF' | 'CRLF';
  has_bom: boolean;
  header: string[];
  rows: { row_number: number; raw_row: Record<string, string> }[];
  summary: { data_rows: number; descriptions: Record<string, number> };
}
export type ParseOutcome = ParsedReport | { ok: false; reject_reason: string };

const reject = (reason: string): ParseOutcome => ({ ok: false, reject_reason: reason });

export function parseReleaseReport(bytes: Uint8Array, configured: ';' | ',' | null): ParseOutcome {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return reject('ENCODING_INVALID: the file is not valid UTF-8');
  }
  const has_bom = text.startsWith('﻿');
  if (has_bom) text = text.slice(1);
  // deno-lint-ignore no-control-regex -- control characters inside a CSV are a defect we refuse
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return reject('CONTROL_CHARACTER: unexpected control character in the file');
  if (text.includes('"')) return reject('QUOTED_FIELDS_UNSUPPORTED: the frozen layout has no quoted fields');

  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (text.replace(/\r\n/g, '').includes('\r')) return reject('LINE_ENDING_INVALID: bare CR');
  if (crlf !== 0 && crlf !== lf) return reject('LINE_ENDING_AMBIGUOUS: mixed LF and CRLF');
  const line_ending = crlf > 0 ? 'CRLF' : 'LF';
  const lines = text.split(line_ending === 'CRLF' ? '\r\n' : '\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();   // one final line terminator
  if (lines.length === 0 || lines[0] === '') return reject('EMPTY_FILE: no header');

  const head = lines[0];
  let separator: ';' | ',';
  if (configured !== null) {
    separator = configured;
  } else {
    const fits = SEPARATORS.filter((s) => {
      const h = head.split(s);
      return h.length === EXPECTED_COLUMNS.length && h.every((k) => EXPECTED_COLUMNS.includes(k));
    });
    if (fits.length !== 1) return reject('SEPARATOR_AMBIGUOUS: the header does not identify one separator');
    separator = fits[0];
  }
  const header = head.split(separator);
  const missing = EXPECTED_COLUMNS.filter((k) => !header.includes(k));
  const unexpected = header.filter((k) => !EXPECTED_COLUMNS.includes(k));
  if (missing.length || unexpected.length || new Set(header).size !== header.length) {
    return reject(`HEADER_MISMATCH: missing [${missing.join(',')}] unexpected [${unexpected.join(',')}]` +
      (new Set(header).size !== header.length ? ' duplicated' : ''));
  }

  const rows: ParsedReport['rows'] = [];
  const descriptions: Record<string, number> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') return reject(`EMPTY_LINE: line ${i + 1}`);
    const f = lines[i].split(separator);
    if (f.length !== header.length) return reject(`FIELD_COUNT_MISMATCH: line ${i + 1} has ${f.length} fields, expected ${header.length}`);
    const raw_row: Record<string, string> = {};
    header.forEach((k, j) => { raw_row[k] = f[j]; });
    rows.push({ row_number: i, raw_row });
    descriptions[raw_row.DESCRIPTION] = (descriptions[raw_row.DESCRIPTION] ?? 0) + 1;
  }
  if (rows.length === 0) return reject('EMPTY_FILE: header only');
  return { ok: true, separator, line_ending, has_bom, header, rows, summary: { data_rows: rows.length, descriptions } };
}
