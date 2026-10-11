/**
 * ADR-018 §7.5 — common extractor (no bank knowledge, no OCR).
 *
 * The PDF library (unpdf 1.8.1, PDF.js 6.1.200) is injected, so this module has no runtime dependency and can be
 * exercised with any compatible implementation; index.ts wires the pinned `npm:unpdf@1.8.1`.
 *
 * Output: per page, the text items (string, left x, baseline distance from the page top, width) in PDF.js order;
 * then rows of words: each item is split into words by its own per-character advance (width / length) — the
 * statements are printed in monospaced fonts — and words sharing a baseline form a physical row.
 * Any failure rejects the whole file: no partial result is ever returned.
 */
import { type ExtractLimits, type PageText, type Row, StatementReject, type TextItem, type Word } from './types.ts';

/** Initial operational limits (ADR-018 §7.5); not part of any fingerprint or adapter contract. */
export const DEFAULT_LIMITS: ExtractLimits = { maxBytes: 10 * 1024 * 1024, maxPages: 20, timeoutMs: 10_000 };

/** The subset of the unpdf / PDF.js API the extractor uses. */
export interface PdfLibrary {
  getDocumentProxy(data: Uint8Array): Promise<{
    numPages: number;
    getPage(n: number): Promise<{
      getViewport(o: { scale: number }): { height: number };
      getTextContent(): Promise<{ items: unknown[] }>;
    }>;
  }>;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export async function extractText(bytes: Uint8Array, lib: PdfLibrary, limits: ExtractLimits = DEFAULT_LIMITS): Promise<PageText[]> {
  if (bytes.length > limits.maxBytes) throw new StatementReject('FILE_TOO_LARGE', `${bytes.length} bytes`);
  if (bytes.length < PDF_MAGIC.length || PDF_MAGIC.some((b, i) => bytes[i] !== b)) throw new StatementReject('NOT_A_PDF');

  const work = (async (): Promise<PageText[]> => {
    // PDF.js may take ownership of the buffer: pass a copy so the caller's bytes stay intact
    const doc = await lib.getDocumentProxy(bytes.slice());
    if (doc.numPages > limits.maxPages) throw new StatementReject('TOO_MANY_PAGES', String(doc.numPages));
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const height = page.getViewport({ scale: 1 }).height;
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const raw of content.items) {
        const it = raw as { str?: unknown; transform?: unknown; width?: unknown };
        if (typeof it.str !== 'string' || it.str.trim() === '' || !Array.isArray(it.transform) || typeof it.width !== 'number') continue;
        items.push({ str: it.str, x: Number(it.transform[4]), top: height - Number(it.transform[5]), w: it.width });
      }
      pages.push({ n, items });
    }
    return pages;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StatementReject('EXTRACTION_TIMEOUT', `${limits.timeoutMs} ms`)), limits.timeoutMs);
  });
  try {
    const pages = await Promise.race([work, timeout]);
    if (pages.every((p) => p.items.length === 0)) throw new StatementReject('TEXT_NOT_EXTRACTABLE');
    return pages;
  } catch (e) {
    if (e instanceof StatementReject) throw e;
    throw new StatementReject('INVALID_PDF', String((e as Error)?.message ?? e).slice(0, 160));
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined); // a timed-out extraction must not surface as an unhandled rejection
  }
}

/** Words of one page, split by each item's per-character advance, grouped into rows by baseline (tolerance 1.5 pt). */
export function pageRows(page: PageText): Row[] {
  const words: Word[] = [];
  for (const it of page.items) {
    const advance = it.w / it.str.length;
    for (const m of it.str.matchAll(/\S+/g)) {
      const start = m.index ?? 0;
      words.push({ text: m[0], x0: it.x + start * advance, x1: it.x + (start + m[0].length) * advance, top: it.top });
    }
  }
  words.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const rows: Row[] = [];
  for (const w of words) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(w.top - last.top) <= 1.5) last.words.push(w);
    else rows.push({ page: page.n, index: rows.length + 1, top: w.top, words: [w], text: '' });
  }
  for (const r of rows) {
    r.words.sort((a, b) => a.x0 - b.x0);
    r.text = r.words.map((w) => w.text).join(' ');
  }
  return rows;
}
