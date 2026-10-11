/**
 * ADR-018 — production bank statement parser tests (supabase/functions/_shared/bank-statement). Deno.
 *
 * No real statement is used: the versioned SYNTHETIC fixtures (scripts/adr018/fixtures/unpdf-synthetic-statements.json)
 * are rendered into real PDF files (Courier, the monospaced geometry of the official statements) and parsed end to
 * end through the pinned unpdf 1.8.1, the common extractor and the frozen adapters.
 *
 *   deno test --node-modules-dir=none --allow-read scripts/adr018/bank-statement.test.ts
 */
// deno-lint-ignore no-import-prefix -- pinned test-only dependency (no deno.json in this repository)
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13';
import {
  DETECTOR_VERSION, type EconomicRow, extractText, type ImportRow, PARSER_VERSIONS, PINNED_PDF_LIBRARY, type ParseResult,
  parseStatementPdf, type StatementAccountConfig, StatementReject, type TextItem,
} from '../../supabase/functions/_shared/bank-statement/index.ts';
import { referenceNormDescription } from '../../supabase/functions/_shared/bank-statement/normalize.ts';
import { buildPdf } from './synthetic-pdf.ts';

type Fixture = { name: string; format: StatementAccountConfig['format_code']; config: Omit<StatementAccountConfig, 'format_code'>;
  pages: { n: number; items: TextItem[] }[]; expect: Record<string, unknown> & { lines: Record<string, unknown>[] } };
const FIXTURES: Fixture[] = JSON.parse(await Deno.readTextFile(new URL('./fixtures/unpdf-synthetic-statements.json', import.meta.url))).fixtures;
const fx = (name: string) => structuredClone(FIXTURES.find((f) => f.name === name) as Fixture);
const cfgOf = (f: Fixture): StatementAccountConfig => ({ format_code: f.format, ...f.config });

const pdfOf = (f: Fixture) => buildPdf(f.pages);
const reject = (r: ParseResult) => { assert(!r.ok, 'expected a rejection'); return r; };
const parsed = (r: ParseResult) => { assert(r.ok, r.ok ? '' : r.reject_reason); return r.statement; };
const economic = (rows: ImportRow[]) => rows.filter((r): r is EconomicRow => r.kind === 'ECONOMIC');
type LineLike = { value_date?: unknown; description_raw?: unknown; bank_reference?: unknown; fecha_valor?: unknown; signed_amount?: unknown; running_balance?: unknown };
const pick = (l: LineLike) => [l.value_date, l.description_raw, l.bank_reference, l.fecha_valor ?? null, l.signed_amount, l.running_balance ?? null];

// ── 0075 contract shape (what fin_import_bank_statement validates) ───────────────────────────────────────────
function assertContract(rows: ImportRow[]) {
  const amount = /^-?[0-9]{1,13}\.[0-9]{2}$/; const date = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  assertEquals(rows.map((r) => r.row_number), rows.map((_, i) => i + 1), 'row_number 1..n in physical order');
  let pos = 0;
  for (const r of rows) {
    for (const k of ['description_norm', 'fingerprint', 'outcome', 'statement_line_id', 'mp_source_record_id']) assert(!(k in r), `${k} must not be sent`);
    assert(typeof r.raw_row === 'object' && typeof r.appearance_meta === 'object');
    if (r.kind === 'ECONOMIC') {
      pos += 1; assertEquals(r.statement_position, pos);
      assertMatch(r.value_date, date); assertMatch(r.signed_amount, amount);
      if (r.running_balance !== null) assertMatch(r.running_balance, amount);
      if (r.fecha_valor !== null) assertMatch(r.fecha_valor, date);
      assert(r.description_raw.trim() !== '');
    } else {
      assert(!('statement_position' in r));
      if (r.kind === 'CONTROL') { assert(r.control_type.trim() !== ''); if (r.balance !== null) assertMatch(r.balance, amount); }
    }
  }
}

// ── COMMON ───────────────────────────────────────────────────────────────────────────────────────────────────
const bnaCfg = cfgOf(fx('bna-synthetic'));
Deno.test('common: non-PDF bytes → NOT_A_PDF, detector version, no format_code', async () => {
  const r = reject(await parseStatementPdf(new TextEncoder().encode('FECHA MOVIMIENTOS SALDO'), bnaCfg));
  assertEquals([r.code, r.format_code, r.parser_version], ['NOT_A_PDF', null, DETECTOR_VERSION]);
});
Deno.test('common: corrupt PDF → INVALID_PDF', async () => {
  assertEquals(reject(await parseStatementPdf(new TextEncoder().encode('%PDF-1.4\n%garbage without objects'), bnaCfg)).code, 'INVALID_PDF');
});
Deno.test('common: truncated PDF → INVALID_PDF', async () => {
  const bytes = pdfOf(fx('bna-synthetic'));
  assertEquals(reject(await parseStatementPdf(bytes.slice(0, Math.floor(bytes.length / 3)), bnaCfg)).code, 'INVALID_PDF');
});
Deno.test('common: over the size limit → FILE_TOO_LARGE (limit is checked before parsing)', async () => {
  const bytes = pdfOf(fx('bna-synthetic'));
  assertEquals(reject(await parseStatementPdf(bytes, bnaCfg, { limits: { maxBytes: bytes.length - 1, maxPages: 20, timeoutMs: 10_000 } })).code, 'FILE_TOO_LARGE');
});
Deno.test('common: over the page limit → TOO_MANY_PAGES', async () => {
  const bytes = buildPdf([{ items: [{ str: 'A', x: 50, top: 50, w: 4.86 }] }, { items: [{ str: 'B', x: 50, top: 50, w: 4.86 }] }, { items: [{ str: 'C', x: 50, top: 50, w: 4.86 }] }]);
  assertEquals(reject(await parseStatementPdf(bytes, bnaCfg, { limits: { maxBytes: 1e7, maxPages: 2, timeoutMs: 10_000 } })).code, 'TOO_MANY_PAGES');
});
Deno.test('common: extraction exceeding the timeout → EXTRACTION_TIMEOUT', async () => {
  const stuck = { getDocumentProxy: () => new Promise<never>(() => {}) };
  const r = reject(await parseStatementPdf(pdfOf(fx('bna-synthetic')), bnaCfg, { lib: stuck, limits: { maxBytes: 1e7, maxPages: 20, timeoutMs: 50 } }));
  assertEquals(r.code, 'EXTRACTION_TIMEOUT');
});
Deno.test('common: a PDF without text → TEXT_NOT_EXTRACTABLE (no OCR)', async () => {
  assertEquals(reject(await parseStatementPdf(buildPdf([{ items: [] }]), bnaCfg)).code, 'TEXT_NOT_EXTRACTABLE');
});
Deno.test('common: unrecognised structure → FORMAT_NOT_RECOGNISED for both adapters', async () => {
  const bytes = buildPdf([{ items: [{ str: 'FACTURA SINTETICA 0001 TOTAL $ 100,00', x: 50, top: 100, w: 37 * 4.86 }] }]);
  for (const f of ['bna-synthetic', 'patagonia-synthetic']) {
    const r = reject(await parseStatementPdf(bytes, cfgOf(fx(f))));
    assertEquals([r.code, r.format_code, r.parser_version], ['FORMAT_NOT_RECOGNISED', null, DETECTOR_VERSION]);
  }
});
Deno.test('common: unknown format_code → FORMAT_NOT_RECOGNISED (no detection)', async () => {
  const r = reject(await parseStatementPdf(pdfOf(fx('bna-synthetic')), { ...bnaCfg, format_code: 'BNA_CSV_V1' as never }));
  assertEquals([r.code, r.format_code], ['FORMAT_NOT_RECOGNISED', null]);
});
Deno.test('common: the extractor keeps page and physical order and never returns partial data', async () => {
  const pages = await extractText(pdfOf(fx('bna-synthetic')), PINNED_PDF_LIBRARY);
  assertEquals(pages.map((p) => p.n), [1, 2]);
  assert(pages.every((p) => p.items.length > 0));
});

// ── BNA_MONTHLY_PDF_V1 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test('BNA: statement parsed end to end (negative balance, separate $, 8-digit COMPROB. shift, TRANSPORTE, page break)', async () => {
  const f = fx('bna-synthetic');
  const s = parsed(await parseStatementPdf(pdfOf(f), cfgOf(f)));
  assertEquals([s.format_code, s.parser_version, s.coverage_from, s.coverage_to], ['BNA_MONTHLY_PDF_V1', PARSER_VERSIONS.BNA_MONTHLY_PDF_V1, '2026-07-31', '2026-08-31']);
  assertEquals([s.source_meta.opening_balance, s.source_meta.closing_balance], ['-100.00', '-100.00']);
  assertEquals(economic(s.rows).map(pick), f.expect.lines.map(pick));
  assertEquals(s.rows.filter((r) => r.kind === 'CONTROL').map((r) => (r as { control_type: string }).control_type),
    ['SALDO_ANTERIOR', 'TRANSPORTE', 'TRANSPORTE', 'SALDO_FINAL', 'TOTAL', 'TOTAL']);
  assertEquals(economic(s.rows).map((l) => l.appearance_meta.page), [1, 1, 1, 2]);
  assertContract(s.rows);
});
Deno.test('BNA: the totals block after SALDO FINAL is control and never creates a line', async () => {
  const f = fx('bna-synthetic');
  const s = parsed(await parseStatementPdf(pdfOf(f), cfgOf(f)));
  const finalAt = s.rows.findIndex((r) => r.kind === 'CONTROL' && r.control_type === 'SALDO_FINAL');
  assert(s.rows.slice(finalAt + 1).every((r) => r.kind === 'CONTROL'));
  assert(s.rows.slice(finalAt + 1).some((r) => r.raw_row.text.startsWith('- INTERESES')));
});
Deno.test('BNA: a movement-shaped row after SALDO FINAL rejects the file (UNCLASSIFIABLE_ROW)', async () => {
  const f = fx('bna-synthetic');
  f.pages[1].items.push({ str: '31/08/26 DEBIN', x: 65.1, top: 392, w: 14 * 4.86 }, { str: '999', x: 276.8 - 3 * 4.86, top: 392, w: 3 * 4.86 },
    { str: '10,00', x: 469 - 5 * 4.86, top: 392, w: 5 * 4.86 }, { str: '90,00-', x: 565.2 + 4.86 - 6 * 4.86, top: 392, w: 6 * 4.86 });
  const r = reject(await parseStatementPdf(pdfOf(f), cfgOf(f)));
  assertEquals([r.code, r.format_code], ['UNCLASSIFIABLE_ROW', 'BNA_MONTHLY_PDF_V1']);
});
Deno.test('BNA: a row with an amount that fits no column rejects the file', async () => {
  const f = fx('bna-synthetic');
  f.pages[0].items.push({ str: 'TEXTO CON IMPORTE', x: 65.1, top: 600, w: 17 * 4.86 }, { str: '1,00', x: 565.2 - 4 * 4.86, top: 600, w: 4 * 4.86 });
  assertEquals(reject(await parseStatementPdf(pdfOf(f), cfgOf(f))).code, 'UNCLASSIFIABLE_ROW');
});
Deno.test('BNA: another account (CBU / account number) → ACCOUNT_MISMATCH', async () => {
  const f = fx('bna-synthetic');
  assertEquals(reject(await parseStatementPdf(pdfOf(f), { ...cfgOf(f), expected_cbu: '1'.repeat(22) })).code, 'ACCOUNT_MISMATCH');
  assertEquals(reject(await parseStatementPdf(pdfOf(f), { ...cfgOf(f), expected_account_number: '9876543210' })).code, 'ACCOUNT_MISMATCH');
});
Deno.test('BNA: a Patagonia statement through the BNA adapter → FORMAT_NOT_RECOGNISED', async () => {
  assertEquals(reject(await parseStatementPdf(pdfOf(fx('patagonia-synthetic')), bnaCfg)).code, 'FORMAT_NOT_RECOGNISED');
});

// ── PATAGONIA_STATEMENT_PDF_V1 ───────────────────────────────────────────────────────────────────────────────
Deno.test('Patagonia: statement parsed end to end (0/00/00, one-digit day, nullable balance, empty / present REFER. and FECHA VALOR)', async () => {
  const f = fx('patagonia-synthetic');
  const s = parsed(await parseStatementPdf(pdfOf(f), cfgOf(f)));
  assertEquals([s.format_code, s.coverage_from, s.coverage_to], ['PATAGONIA_STATEMENT_PDF_V1', null, '2026-09-30']);
  assertEquals([s.source_meta.opening_balance, s.source_meta.closing_balance], ['0.00', '597.00']);
  assertEquals(economic(s.rows).map(pick), f.expect.lines.map(pick));
  assertContract(s.rows);
});
Deno.test('Patagonia: daily balance — printed only on the last line of the day', async () => {
  const f = fx('patagonia-synthetic');
  const lines = economic(parsed(await parseStatementPdf(pdfOf(f), cfgOf(f))).rows);
  assertEquals(lines.map((l) => l.running_balance), [null, '497.00', '597.00']);
});
Deno.test('Patagonia: transfer details matched 1:1 never create lines; unmatched detail kept with TRANSFER_DETAIL_UNMATCHED', async () => {
  const f = fx('patagonia-synthetic');
  const s = parsed(await parseStatementPdf(pdfOf(f), cfgOf(f)));
  const details = s.rows.filter((r) => r.kind === 'DETAIL');
  assertEquals(economic(s.rows).length, 3);
  assertEquals(details.map((d) => [d.appearance_meta.transfer_detail?.date, d.appearance_meta.transfer_detail?.imp_original, d.review_code ?? null]),
    [['2026-09-05', '500.00', null], ['2026-09-16', '100.00', null], ['2026-09-20', '50.00', 'TRANSFER_DETAIL_UNMATCHED']]);
  const byRow = new Map(s.rows.map((r) => [r.row_number, r]));
  for (const d of details.slice(0, 2)) {
    const main = byRow.get(d.appearance_meta.detail_of_row as number) as EconomicRow;
    assertEquals([main.kind, main.signed_amount, main.appearance_meta.transfer_detail?.imp_original], ['ECONOMIC', d.appearance_meta.transfer_detail?.imp_original, d.appearance_meta.transfer_detail?.imp_original]);
  }
  assertEquals(details[2].appearance_meta.detail_of_row, undefined);
});
Deno.test('Patagonia: another account (account / CBU / subcta / suc) → ACCOUNT_MISMATCH', async () => {
  const f = fx('patagonia-synthetic');
  for (const cfg of [{ expected_account_number: '222222222' }, { expected_cbu: '1'.repeat(22) }, { expected_extra: { subcta: '9', suc: '1' } }, { expected_extra: { subcta: '0', suc: '7' } }]) {
    assertEquals(reject(await parseStatementPdf(pdfOf(f), { ...cfgOf(f), ...cfg })).code, 'ACCOUNT_MISMATCH');
  }
});
Deno.test('Patagonia: a BNA statement through the Patagonia adapter → FORMAT_NOT_RECOGNISED', async () => {
  assertEquals(reject(await parseStatementPdf(pdfOf(fx('bna-synthetic')), cfgOf(fx('patagonia-synthetic')))).code, 'FORMAT_NOT_RECOGNISED');
});

// ── normalize.ts is a reference only ─────────────────────────────────────────────────────────────────────────
Deno.test('normalize: reference mirrors the frozen §7.1 rule (authority stays in PostgreSQL)', () => {
  assertEquals(referenceNormDescription('Transferéncia  Recibida'), 'TRANSFERENCIA RECIBIDA');
  let code = '';
  try { referenceNormDescription('a\u007fb'); } catch (e) { code = (e as Error).message; }
  assertEquals(code, 'DESCRIPTION_CONTROL_CHAR');
  assert(new StatementReject('NOT_A_PDF') instanceof Error);
});
