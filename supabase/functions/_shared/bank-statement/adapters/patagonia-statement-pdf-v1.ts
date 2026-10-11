/**
 * ADR-018 §7.3 — PATAGONIA_STATEMENT_PDF_V1 (frozen, G-2, deliberately narrow V1).
 *
 * One CUENTA CORRIENTE EN PESOS section; one movement table on one page (header … SALDO ACTUAL); REFER. and
 * FECHA VALOR optional; the running balance printed only on the last line of a day (nullable); dates with a one-digit
 * day; the first statement's SALDO ANTERIOR dated 0/00/00. Anything else fails closed (UNSUPPORTED_STRUCTURE).
 *
 * TRANSFERENCIAS RECIBIDAS rows never create an economic line. Each detail is associated with a main line when the
 * date matches, IMP.ORIGINAL equals the line's positive signed amount, and the candidate is unique both ways; the
 * detail is then recorded on the main line's appearance (transfer_detail) and kept as a DETAIL row (detail_of_row).
 * Otherwise the DETAIL row carries review_code TRANSFER_DETAIL_UNMATCHED; this alone never rejects the file.
 * Balance chain, coverage and duplicate content are validated by fin_import_bank_statement (PostgreSQL).
 */
import {
  type ControlRow, type DetailRow, type EconomicRow, type PageText, type ParsedStatement, type Row, StatementReject,
  type StatementAccountConfig, type TransferDetailMeta,
} from '../types.ts';
import { pageRows } from '../unpdf.ts';
import { canonicalAmount, findHeader, isAmount, isoDate, metaOf, nearestColumn, negate, rawOf } from './shared.ts';

export const PATAGONIA_PARSER_VERSION = 'PATAGONIA_STATEMENT_PDF_V1/1.0.0 unpdf-1.8.1';
const DATE = /^\d{1,2}\/\d{2}\/\d{2}$/;
type Pending = { kind: 'ECONOMIC'; data: Omit<EconomicRow, 'row_number'> } | { kind: 'CONTROL'; data: Omit<ControlRow, 'row_number'> }
  | { kind: 'DETAIL'; data: Omit<DetailRow, 'row_number'>; detail: TransferDetailMeta };

export function parsePatagoniaStatementPdfV1(pages: PageText[], cfg: StatementAccountConfig): ParsedStatement {
  const all: Row[][] = pages.map(pageRows);
  const text = all.flat().map((r) => r.text).join('\n');
  if (!/bancopatagonia/i.test(text)) throw new StatementReject('FORMAT_NOT_RECOGNISED', 'Banco Patagonia');
  const est = /ESTADO DE CUENTAS UNIFICADO CLIENTE N\S*: (\d+) AL (\d{2}\/\d{2}\/\d{2})/.exec(text);
  const acc = /CUENTA CORRIENTE EN PESOS (\d+) SUBCTA (\d+) SUC (\d+) CBU: (\d{8}) (\d{14})/.exec(text);
  if (!est || !acc) throw new StatementReject('FORMAT_NOT_RECOGNISED', 'statement header');
  const extra = cfg.expected_extra ?? {};
  if (acc[1] !== cfg.expected_account_number || `${acc[4]}${acc[5]}` !== cfg.expected_cbu
      || (extra.subcta !== undefined && acc[2] !== extra.subcta) || (extra.suc !== undefined && acc[3] !== extra.suc)) {
    throw new StatementReject('ACCOUNT_MISMATCH');
  }
  if ((text.match(/CUENTA CORRIENTE EN PESOS \d+/g) ?? []).length !== 1) throw new StatementReject('UNSUPPORTED_STRUCTURE', 'account sections');

  const pending: Pending[] = [];
  let opening: string | null = null;
  let openingDate: string | null = null;
  let closing: string | null = null;
  let movementTables = 0;
  let position = 0;

  for (const rows of all) {
    const h = findHeader(rows, ['FECHA', 'CONCEPTO', 'REFER.', 'FECHA', 'VALOR', 'DEBITOS', 'CREDITOS', 'SALDO']);
    if (h) {
      movementTables += 1;
      const [, CON, REF, FV, VAL, DEB, CRED, SAL] = h.cols;
      const amountCols = [{ key: 'debit' as const, x1: DEB.x1 }, { key: 'credit' as const, x1: CRED.x1 }, { key: 'balance' as const, x1: SAL.x1 }];
      let ended = false;
      for (const r of rows.filter((x) => x.top > h.row.top + 1)) {
        const first = r.words[0];
        if (!DATE.test(first.text) || first.x1 >= CON.x0) continue;
        const rest = r.words.slice(1);
        const label = rest.filter((w) => w.x1 < REF.x0).map((w) => w.text).join(' ');
        if (label === 'SALDO ANTERIOR' || label === 'SALDO ACTUAL') {
          const a = rest.filter((w) => isAmount(w.text));
          if (!a.length) throw new StatementReject('UNCLASSIFIABLE_ROW', `${label} without amount`);
          const balance = canonicalAmount(a[a.length - 1].text);
          if (label === 'SALDO ANTERIOR') { opening = balance; openingDate = first.text === '0/00/00' ? null : isoDate(first.text); }
          else closing = balance;
          pending.push({ kind: 'CONTROL', data: { kind: 'CONTROL', control_type: label.replace(' ', '_'), balance, raw_row: rawOf(r), appearance_meta: metaOf(r) } });
          if (label === 'SALDO ACTUAL') { ended = true; break; }
          continue;
        }
        const desc: string[] = []; const ref: string[] = []; const fv: string[] = []; const bad: string[] = [];
        const amt: { debit?: string; credit?: string; balance?: string } = {};
        for (const w of rest) {
          if (isAmount(w.text) && w.x0 > VAL.x1) {
            const k = nearestColumn(w.x1, amountCols);
            if (amt[k] !== undefined) bad.push(w.text); else amt[k] = canonicalAmount(w.text);
          } else if (w.x1 < REF.x0) desc.push(w.text);
          else if (w.x0 >= REF.x0 - 2 && w.x1 < FV.x0) ref.push(w.text);
          else if (w.x0 >= FV.x0 - 5 && w.x1 <= VAL.x1 + 10 && DATE.test(w.text)) fv.push(w.text);
          else bad.push(w.text);
        }
        if (bad.length || fv.length > 1 || (amt.debit === undefined) === (amt.credit === undefined)) {
          throw new StatementReject('UNCLASSIFIABLE_ROW', `page ${r.page}: ${r.text}`);
        }
        position += 1;
        pending.push({ kind: 'ECONOMIC', data: {
          kind: 'ECONOMIC', statement_position: position, value_date: isoDate(first.text), description_raw: desc.join(' '),
          bank_reference: ref.join(' '), fecha_valor: fv.length ? isoDate(fv[0]) : null,
          signed_amount: amt.credit !== undefined ? amt.credit : negate(amt.debit as string), running_balance: amt.balance ?? null,
          raw_row: rawOf(r), appearance_meta: metaOf(r) } });
      }
      if (!ended) throw new StatementReject('UNSUPPORTED_STRUCTURE', 'movement table does not end with SALDO ACTUAL on its page');
    }
    const d = findHeader(rows, ['FECHA', 'NOMBRE', 'ORIG', 'DOC.ORIG.', 'SERVICIO', 'REFERENCIA', 'CBU', 'ORIGEN', 'BANCO', 'SUC', 'IMP.ORIGINAL']);
    if (d) {
      const [, NOM, , DOC, , , , , , , IMP] = d.cols;
      for (const r of rows.filter((x) => x.top > d.row.top + 1)) {
        const first = r.words[0];
        if (/^_+$/.test(first.text)) break;
        if (!DATE.test(first.text) || first.x1 >= NOM.x0) continue;
        const imp = r.words.filter((w) => isAmount(w.text) && Math.abs(w.x1 - IMP.x1) < 15);
        const detail: TransferDetailMeta = {
          date: isoDate(first.text), imp_original: imp.length === 1 ? canonicalAmount(imp[0].text) : null,
          nombre_orig: r.words.filter((w) => w.x0 >= NOM.x0 - 3 && w.x1 < DOC.x0).map((w) => w.text).join(' '),
        };
        pending.push({ kind: 'DETAIL', detail, data: { kind: 'DETAIL', raw_row: rawOf(r), appearance_meta: metaOf(r) } });
      }
    }
  }
  if (movementTables !== 1) throw new StatementReject(movementTables ? 'UNSUPPORTED_STRUCTURE' : 'FORMAT_NOT_RECOGNISED', `${movementTables} movement tables`);
  if (opening === null || closing === null) throw new StatementReject('FORMAT_NOT_RECOGNISED', 'SALDO ANTERIOR / SALDO ACTUAL');

  // number every row in physical order, then associate each detail with a unique main line
  const numbered = pending.map((p, i) => ({ ...p, row_number: i + 1 }));
  const economic = numbered.filter((p) => p.kind === 'ECONOMIC') as (Extract<Pending, { kind: 'ECONOMIC' }> & { row_number: number })[];
  const details = numbered.filter((p) => p.kind === 'DETAIL') as (Extract<Pending, { kind: 'DETAIL' }> & { row_number: number })[];
  for (const dt of details) {
    const cands = economic.filter((e) => e.data.value_date === dt.detail.date && dt.detail.imp_original !== null
      && !e.data.signed_amount.startsWith('-') && e.data.signed_amount === dt.detail.imp_original);
    const rivals = details.filter((o) => o.detail.date === dt.detail.date && o.detail.imp_original === dt.detail.imp_original);
    if (cands.length === 1 && rivals.length === 1) {
      cands[0].data.appearance_meta.transfer_detail = dt.detail;
      dt.data.appearance_meta.detail_of_row = cands[0].row_number;
      dt.data.appearance_meta.transfer_detail = dt.detail;
      dt.data.note = 'TRANSFER_DETAIL';
    } else {
      dt.data.appearance_meta.transfer_detail = dt.detail;
      dt.data.review_code = 'TRANSFER_DETAIL_UNMATCHED';
      dt.data.note = 'TRANSFER_DETAIL';
    }
  }

  return {
    format_code: 'PATAGONIA_STATEMENT_PDF_V1', parser_version: PATAGONIA_PARSER_VERSION,
    coverage_from: openingDate, coverage_to: isoDate(est[2]),
    source_meta: { opening_balance: opening, closing_balance: closing, statement_date: est[2], pages: pages.length },
    rows: numbered.map((p) => ({ ...p.data, row_number: p.row_number }) as EconomicRow | ControlRow | DetailRow),
  };
}
