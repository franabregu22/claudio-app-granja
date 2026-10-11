/** Helpers shared by the frozen adapters: amounts, dates, column headers, row evidence. */
import type { AppearanceMeta, RawRow, Row, Word } from '../types.ts';

/** Statement amount: "1.234,56", optional trailing "-" for negatives, optional leading "$". */
export const AMOUNT = /^\$?(\d{1,3}(?:\.\d{3})*,\d{2})(-?)$/;
export const isAmount = (t: string): boolean => AMOUNT.test(t);

/** Canonical amount string ('-?d+.dd', no thousands separator), as fin_import_bank_statement expects. */
export function canonicalAmount(t: string): string {
  const m = AMOUNT.exec(t);
  if (!m) throw new Error(`not an amount: ${t}`);
  const digits = m[1].replace(/\./g, '').replace(',', '.').replace(/^0+(?=\d)/, '');
  return m[2] === '-' && !/^0\.00$/.test(digits) ? `-${digits}` : digits;
}
export const negate = (canonical: string): string => (canonical.startsWith('-') ? canonical.slice(1) : `-${canonical}`);

/** 'd/mm/yy', 'dd/mm/yy' or 'dd/mm/yyyy' → 'YYYY-MM-DD'. */
export function isoDate(d: string): string {
  const [dd, mm, yy] = d.split('/');
  return `${yy.length === 2 ? `20${yy}` : yy}-${mm}-${dd.padStart(2, '0')}`;
}

/** The first row containing the given header words in order; returns the row and the matched words. */
export function findHeader(rows: Row[], names: string[]): { row: Row; cols: Word[] } | null {
  for (const row of rows) {
    const cols: Word[] = [];
    for (const w of row.words) if (cols.length < names.length && w.text === names[cols.length]) cols.push(w);
    if (cols.length === names.length) return { row, cols };
  }
  return null;
}

/** The amount column whose header right edge is nearest to the word's right edge. */
export function nearestColumn<K extends string>(x1: number, cols: { key: K; x1: number }[]): K {
  return cols.reduce((best, c) => (Math.abs(x1 - c.x1) < Math.abs(x1 - best.x1) ? c : best)).key;
}

export const rawOf = (r: Row): RawRow => ({
  page: r.page, physical_row: r.index, text: r.text,
  words: r.words.map((w) => ({ t: w.text, x0: Math.round(w.x0 * 10) / 10, x1: Math.round(w.x1 * 10) / 10 })),
});
export const metaOf = (r: Row): AppearanceMeta => ({ page: r.page, physical_row: r.index });
