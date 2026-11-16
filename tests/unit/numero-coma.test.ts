/** ERP-wide numeric fields in the Argentine format: decimal comma, «.» thousands (owner 2026-11-16). */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizarNumero } from '../../src/utils/numero';

const SRC = resolve(__dirname, '../../src');
const tsx = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? tsx(p) : p.endsWith('.tsx') ? [p] : []; });

describe('Números con coma decimal', () => {
  it('comma is the decimal separator, «.» the thousands one; what Number() reads comes out', () => {
    expect(normalizarNumero('0,290')).toBe('0.290');
    expect(normalizarNumero('1.234,56')).toBe('1234.56');
    expect(normalizarNumero('200')).toBe('200');
    expect(normalizarNumero('12,')).toBe('12.');
    expect(normalizarNumero('1,2,3')).toBe('1.23');
    expect(normalizarNumero(' 3 500 ')).toBe('3500');
    expect(normalizarNumero('abc')).toBe('');
    expect(normalizarNumero('')).toBe('');
    expect(Number(normalizarNumero('0,290'))).toBe(0.29);
  });
  it('negatives only where allowed', () => {
    expect(normalizarNumero('-5,5')).toBe('5.5');
    expect(normalizarNumero('-5,5', true)).toBe('-5.5');
  });
  it('no browser number field is left in the app: every numeric field is NumeroInput', () => {
    const bad = tsx(SRC).filter((f) => /type="number"|type=\{f\.type === 'number' \? 'number'/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
    expect(readFileSync(join(SRC, 'components/NumeroInput.tsx'), 'utf8')).toContain('type="text"');
  });
});
