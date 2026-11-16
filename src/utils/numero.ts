/**
 * What the owner typed in a numeric field (Argentine format) → a dot-decimal string Number() reads.
 * Comma = decimal separator (the first one counts; later ones are dropped); «.» = thousands separator (dropped); spaces dropped;
 * a leading «-» only where negatives are allowed; anything else is ignored. '' stays '' (an empty field).
 */
export function normalizarNumero(texto: string, negativo = false): string {
  const t = texto.replace(/\s/g, '');
  const signo = negativo && t.startsWith('-') ? '-' : '';
  let entero = ''; let decimal: string | null = null;
  for (const ch of t) {
    if (ch >= '0' && ch <= '9') { if (decimal === null) entero += ch; else decimal += ch; }
    else if (ch === ',' && decimal === null) decimal = '';
  }
  return signo + entero + (decimal === null ? '' : `.${decimal}`);
}
