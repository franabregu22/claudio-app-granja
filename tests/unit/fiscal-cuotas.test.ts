import { describe, expect, it } from 'vitest';
import { repartirEnCuotas, sumarCuotas } from '../../src/features/fiscal/cuotas';

describe('Fiscal — cuotas de una obligación (owner 2026-11-24)', () => {
  it('reparte el total en partes iguales al centavo; lo que sobra va a la última y la suma da exacto', () => {
    const partes = repartirEnCuotas(513302.1, 6);
    expect(partes).toEqual([85550.35, 85550.35, 85550.35, 85550.35, 85550.35, 85550.35]);
    expect(sumarCuotas(partes)).toBe(513302.1);
    const conResto = repartirEnCuotas(100, 3);
    expect(conResto).toEqual([33.33, 33.33, 33.34]);
    expect(sumarCuotas(conResto)).toBe(100);
  });
  it('sin monto o sin cuotas no reparte nada', () => {
    expect(repartirEnCuotas(0, 3)).toEqual([0, 0, 0]);
    expect(repartirEnCuotas(NaN, 2)).toEqual([0, 0]);
    expect(repartirEnCuotas(100, 0)).toEqual([]);
  });
  it('suma cuotas con decimales sin error de coma flotante', () => {
    expect(sumarCuotas([0.1, 0.2])).toBe(0.3);
    expect(sumarCuotas([85550.25, 85550.25, NaN])).toBe(171100.5);
  });
});
