/**
 * A minimal .xlsx writer (owner 2026-11-26: «exportalo en Excel»): one or more sheets of rows, a bold header row and numbers with two
 * decimals. An .xlsx is a ZIP of XML parts — fflate zips it in the browser; nothing leaves the page.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

export type Celda = string | number | null;
export interface Hoja { nombre: string; filas: Celda[][]; anchos?: number[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i: number) => { let s = ''; let n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const nombreHoja = (s: string) => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Hoja';

function hojaXml(h: Hoja): string {
  const filas = h.filas.map((fila, r) => {
    const celdas = fila.map((v, c) => {
      const ref = `${col(c)}${r + 1}`;
      const estilo = r === 0 ? ' s="1"' : typeof v === 'number' ? ' s="2"' : '';
      if (v === null || v === '') return `<c r="${ref}"${estilo}/>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${estilo}><v>${v}</v></c>`;
      return `<c r="${ref}"${estilo} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${celdas}</row>`;
  }).join('');
  const cols = h.anchos?.length ? `<cols>${h.anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `${cols}<sheetData>${filas}</sheetData></worksheet>`;
}

/** The .xlsx bytes of the given sheets. */
export function libroXlsx(hojas: Hoja[]): Uint8Array {
  const files: Zippable = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
      + hojas.map((h, i) => `<sheet name="${esc(nombreHoja(h.nombre))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'),
  };
  hojas.forEach((h, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(hojaXml(h)); });
  return zipSync(files, { level: 6 });
}

/** Hands the bytes to the browser as a download. */
export function descargar(bytes: Uint8Array, nombre: string, tipo: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: tipo }));
  const a = document.createElement('a');
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
