/**
 * ADR-018 test helper — renders SYNTHETIC statement pages into a real PDF (Courier at exact positions, the
 * monospaced geometry of the official statements). Shared by the parser tests and the Edge Function tests.
 */
import type { TextItem } from '../../supabase/functions/_shared/bank-statement/index.ts';

// font size = advance per char / 0.6
const HEIGHT = 841.8;
const WIDTH = 700;   // the Patagonia layout reaches x ≈ 656; text outside the MediaBox is dropped by PDF.js
export function buildPdf(pages: { items: TextItem[] }[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objs: string[] = [];
  const add = (body: string) => { objs.push(body); return objs.length; };
  const widths = Array(224).fill(600).join(' ');
  const font = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${widths}] >>`);
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids: number[] = [];
  for (const p of pages) {
    const ops = p.items.map((it) => {
      const size = (it.w / it.str.length) / 0.6;
      return `BT /F1 ${size.toFixed(4)} Tf 1 0 0 1 ${it.x.toFixed(3)} ${(HEIGHT - it.top).toFixed(3)} Tm (${esc(it.str)}) Tj ET`;
    }).join('\n');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);   // WinAnsi / Latin-1 bytes
}
