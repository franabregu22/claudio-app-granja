import type { InputHTMLAttributes } from 'react';
import { normalizarNumero } from '../utils/numero';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: string | number | null | undefined;
  /** receives the number with a «.» decimal point (what Number() reads), whatever the owner typed */
  onChange: (e: { target: { value: string } }) => void;
};

/**
 * Numeric field of the whole ERP in the Argentine format: decimal COMMA («0,290»), «.» as thousands separator (ignored: «1.234,5» =
 * 1234.5). It shows the value with a comma and hands the caller a dot-decimal string, so the callers keep reading Number(value).
 * min / max / step are not enforced by the browser here (a text field): every form already validates the parsed value.
 */
export function NumeroInput({ value, onChange, min, inputMode = 'decimal', ...rest }: Props) {
  const negativo = min === undefined || Number(min) < 0;
  const mostrar = value === null || value === undefined ? '' : String(value).replace('.', ',');
  return (
    <input {...rest} type="text" inputMode={inputMode} autoComplete="off" value={mostrar}
      onChange={(e) => onChange({ target: { value: normalizarNumero(e.target.value, negativo) } })} />
  );
}
