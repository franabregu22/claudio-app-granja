/**
 * ADR-018 §7.2 — BNA_MONTHLY_PDF_V1 (frozen, G-1), with the owner-approved §7.5 clarification:
 * the economic table ends at SALDO FINAL; the totals block after it (TOTAL … lines and their continuation lines,
 * e.g. "- INTERESES $ …", "REINTEGRO GRAV. LEY 25413 … $ …") is control and never creates a line; a date-led,
 * movement-shaped row after SALDO FINAL rejects the file (UNCLASSIFIABLE_ROW).
 *
 * Detection is document-level and fail closed; identity is checked against the selected account's configuration.
 * Columns are assigned relative to the column headers: description left of COMPROB.; COMPROB. by its right edge
 * inside the COMPROB. header span; amounts by the nearest DEBITOS / CREDITOS / SALDO header right edge.
 * Balance chain, coverage, TRANSPORTE and duplicates are validated by fin_import_bank_statement (PostgreSQL).
 */
import { type ImportRow, type NewImportRow, type PageText, type ParsedStatement, type Row, StatementReject, type StatementAccountConfig } from '../types.ts';
import { pageRows } from '../unpdf.ts';
import { canonicalAmount, findHeader, isAmount, isoDate, metaOf, nearestColumn, negate, rawOf } from './shared.ts';

export const BNA_PARSER_VERSION = 'BNA_MONTHLY_PDF_V1/1.0.0 unpdf-1.8.1';
const SIGNALS = ['BANCO DE LA', 'NACION ARGENTINA', 'RESUMEN DE CUENTA', 'CUENTA CORRIENTE - PESOS', '<--- FIN DE RESUMEN'];
const DATE = /^\d{2}\/\d{2}\/\d{2}$/;

export function parseBnaMonthlyPdfV1(pages: PageText[], cfg: StatementAccountConfig): ParsedStatement {
  const all: Row[][] = pages.map(pageRows);
  const text = all.flat().map((r) => r.text).join('\n');
  for (const s of SIGNALS) if (!text.includes(s)) throw new StatementReject('FORMAT_NOT_RECOGNISED', `missing "${s}"`);
  const period = /PERIODO: (\d{2}\/\d{2}\/\d{4}) AL (\d{2}\/\d{2}\/\d{4})/.exec(text);
  if (!period) throw new StatementReject('FORMAT_NOT_RECOGNISED', 'PERIODO');
  const cbus = [...new Set(text.match(/\b\d{22}\b/g) ?? [])];
  if (cbus.length !== 1 || cbus[0] !== cfg.expected_cbu) throw new StatementReject('ACCOUNT_MISMATCH', 'CBU');
  if (!new RegExp(`(^|\\s)${cfg.expected_account_number}(\\s|$)`, 'm').test(text)) throw new StatementReject('ACCOUNT_MISMATCH', 'account number');

  const rows: ImportRow[] = [];
  let opening: string | null = null;
  let closing: string | null = null;
  let position = 0;
  let headerPages = 0;
  let totalsBlock = false;
  const push = (row: NewImportRow) => rows.push({ ...row, row_number: rows.length + 1 } as ImportRow);

  for (const pageRowsList of all) {
    const h = findHeader(pageRowsList, ['FECHA', 'MOVIMIENTOS', 'COMPROB.', 'DEBITOS', 'CREDITOS', 'SALDO']);
    if (!h) continue;
    headerPages += 1;
    const [, MOV, COMP, DEB, CRED, SAL] = h.cols;
    const amountCols = [{ key: 'debit' as const, x1: DEB.x1 }, { key: 'credit' as const, x1: CRED.x1 }, { key: 'balance' as const, x1: SAL.x1 }];
    const inAmountArea = (x1: number) => x1 > COMP.x1 + 10;

    for (const r of pageRowsList.filter((x) => x.top > h.row.top + 1)) {
      const first = r.words[0];
      const dateLed = DATE.test(first.text) && first.x1 < MOV.x0;
      const label = r.words.filter((w) => w.x0 < MOV.x1 + 60).map((w) => w.text).join(' ');
      const amounts = r.words.filter((w) => isAmount(w.text) && inAmountArea(w.x1));

      if (totalsBlock) {
        if (dateLed) throw new StatementReject('UNCLASSIFIABLE_ROW', `movement-shaped row after SALDO FINAL (page ${r.page}): ${r.text}`);
        if (amounts.length) push({ kind: 'CONTROL', control_type: 'TOTAL', balance: null, raw_row: rawOf(r), appearance_meta: metaOf(r) });
        continue;
      }
      if (dateLed) {
        const desc: string[] = []; const comp: string[] = []; const extra: string[] = [];
        const amt: { debit?: string; credit?: string; balance?: string } = {};
        for (const w of r.words.slice(1)) {
          if (w.text === '$') continue;
          if (isAmount(w.text) && inAmountArea(w.x1)) {
            const k = nearestColumn(w.x1, amountCols);
            if (amt[k] !== undefined) extra.push(w.text); else amt[k] = canonicalAmount(w.text);
          } else if (w.x1 <= COMP.x1 + 10 && w.x1 > COMP.x0) comp.push(w.text);
          else if (w.x1 <= COMP.x0) desc.push(w.text);
          else extra.push(w.text);
        }
        if (extra.length || comp.length > 1 || amt.balance === undefined || (amt.debit === undefined) === (amt.credit === undefined)) {
          throw new StatementReject('UNCLASSIFIABLE_ROW', `page ${r.page}: ${r.text}`);
        }
        position += 1;
        push({
          kind: 'ECONOMIC', statement_position: position, value_date: isoDate(first.text), description_raw: desc.join(' '),
          bank_reference: comp.join(''), fecha_valor: null,
          signed_amount: amt.credit !== undefined ? amt.credit : negate(amt.debit as string), running_balance: amt.balance,
          raw_row: rawOf(r), appearance_meta: metaOf(r),
        });
        continue;
      }
      const control = /^(SALDO ANTERIOR|SALDO FINAL|TRANSPORTE)\b/.exec(label);
      if (control) {
        const balance = amounts.length ? canonicalAmount(amounts[amounts.length - 1].text) : null;
        if (balance === null) throw new StatementReject('UNCLASSIFIABLE_ROW', `${control[1]} without amount (page ${r.page})`);
        const type = control[1].replace(' ', '_');
        if (type === 'SALDO_ANTERIOR') { if (opening !== null) throw new StatementReject('UNSUPPORTED_STRUCTURE', 'two SALDO ANTERIOR'); opening = balance; }
        if (type === 'SALDO_FINAL') { closing = balance; totalsBlock = true; }
        push({ kind: 'CONTROL', control_type: type, balance, raw_row: rawOf(r), appearance_meta: metaOf(r) });
        continue;
      }
      if (/^TOTAL\b/.test(r.text)) {
        push({ kind: 'CONTROL', control_type: 'TOTAL', balance: null, raw_row: rawOf(r), appearance_meta: metaOf(r) });
        continue;
      }
      if (amounts.length) throw new StatementReject('UNCLASSIFIABLE_ROW', `page ${r.page}: ${r.text}`);
      // headers, page / sheet markers and legal text: no amount in the amount columns, not evidence of a fact
    }
  }
  if (!headerPages) throw new StatementReject('FORMAT_NOT_RECOGNISED', 'column header');
  if (opening === null || closing === null) throw new StatementReject('FORMAT_NOT_RECOGNISED', 'SALDO ANTERIOR / SALDO FINAL');

  return {
    format_code: 'BNA_MONTHLY_PDF_V1', parser_version: BNA_PARSER_VERSION,
    coverage_from: isoDate(period[1]), coverage_to: isoDate(period[2]),
    source_meta: { opening_balance: opening, closing_balance: closing, period: `${period[1]} AL ${period[2]}`, pages: pages.length },
    rows,
  };
}
