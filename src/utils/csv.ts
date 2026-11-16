/**
 * CSV for a spreadsheet in Spanish (Argentina): «;» as separator and decimal comma, so Excel opens it directly in columns;
 * UTF-8 with BOM (accents), CRLF line ends. A text with «;», quotes or a line break is quoted ("" doubles a quote).
 */
export type Celda = string | number | null | undefined;

const celda = (v: Celda): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v).replace('.', ',') : v;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function aCsv(cabecera: string[], filas: Celda[][]): string {
  return `﻿${[cabecera, ...filas].map((f) => f.map(celda).join(';')).join('\r\n')}\r\n`;
}

/** Saves the text as a file in the browser (no server involved). */
export function descargarCsv(nombre: string, contenido: string) {
  const url = URL.createObjectURL(new Blob([contenido], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
