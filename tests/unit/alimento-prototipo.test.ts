/** Alimento Balanceado — prototipo etapa 1: cálculos con datos ficticios y aislamiento (nada escribe en Supabase). */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  costoActualMezcla, costoInsumo, diffFabricacion, diffReceta, kgLinea, costoPromedioFabricado, costoReceta, costoRecetaAl, saldoFlete, ultimoCostoInsumo, escalarTanda, estadoInicial, hastaVersion, kgEntre, mesCerrado, opcionesFabricacion, periodoComparable,
  repartirFlete, tablaStock, variacion, versionVigente, type Compra,
} from '../../src/features/production/prototipo/datos';

const DIR = resolve(__dirname, '../../src/features/production/prototipo');
const C = (o: Partial<Compra>): Compra => ({ id: 'x', ingredienteId: 'maiz', kg: 100, proveedor: 'P', fecha: '2026-10-05', precioKg: 10, flete: 0, ...o });

describe('Alimento Balanceado — prototipo', () => {
  it('costo del insumo: ponderado por kg con flete; sin compras en el mes, el último conocido; flete pendiente = estimado', () => {
    const cs = [C({ id: 'a', kg: 100, precioKg: 10, flete: 100 }), C({ id: 'b', kg: 300, precioKg: 20, flete: 0 })];
    expect(costoInsumo(cs, 'maiz', '2026-10').costo).toBeCloseTo((1000 + 100 + 6000) / 400, 6);
    expect(costoInsumo(cs, 'maiz', '2026-11')).toEqual(costoInsumo(cs, 'maiz', '2026-10'));
    expect(costoInsumo([C({ flete: null })], 'maiz', '2026-10').estimado).toBe(true);
    expect(costoInsumo(cs, 'maiz', '2026-09').costo).toBeNull();
  });
  it('costo de la receta por kg = Σ kg × costo ÷ tanda, con la versión vigente', () => {
    const e = estadoInicial();
    const postura = e.recetas.find((r) => r.id === 'postura')!;
    expect(versionVigente(postura, '2026-08-31')!.version).toBe(1);
    expect(versionVigente(postura, '2026-09-30')!.version).toBe(2);
    const v = versionVigente(postura, '2026-10-31')!;
    const esperado = v.lineas.reduce((t, l) => t + l.kg * costoInsumo(e.compras, l.ingredienteId, '2026-10').costo!, 0) / v.tandaKg;
    expect(costoReceta(e.compras, v, '2026-10').costo).toBeCloseTo(esperado, 6);
  });
  it('tanda: el recálculo es proporcional y suma el nuevo tamaño', () => {
    const v = estadoInicial().recetas[0].versiones[1];
    const l = escalarTanda(v, 500);
    expect(l.reduce((t, x) => t + x.kg, 0)).toBeCloseTo(500, 6);
    expect(l[0].kg / 500).toBeCloseTo(v.lineas[0].kg / v.tandaKg, 6);
  });
  it('flete: proporcional por kg suma exacto (redondeo en la última); manual respeta los importes', () => {
    const p = repartirFlete(1000, [{ id: 'a', kg: 1 }, { id: 'b', kg: 1 }, { id: 'c', kg: 1 }], 'KG');
    expect(p).toEqual({ a: 333.33, b: 333.33, c: 333.34 });
    expect(repartirFlete(500, [{ id: 'a', kg: 1 }, { id: 'b', kg: 9 }], 'MANUAL', { a: 100, b: 400 })).toEqual({ a: 100, b: 400 });
  });
  it('stock: inicial = final anterior; consumo = inicial + producción − final; sin cierre no hay consumo', () => {
    const e = estadoInicial();
    const filas = tablaStock(e, 'postura');
    expect(filas[1].inicial).toBe(filas[0].final);
    for (const f of filas.filter((x) => x.final !== null)) expect(f.consumo).toBe(f.inicial + f.produccion - f.final!);
    expect(filas.at(-1)!.consumo).toBeNull();   // noviembre abierto
  });
  it('meses cerrados bloquean; el selector ofrece solo recetas activas con su versión vigente', () => {
    const e = estadoInicial();
    expect(mesCerrado(e, '2026-10-15')).toBe(true);
    expect(mesCerrado(e, '2026-11-10')).toBe(false);
    const ops = opcionesFabricacion(e, '2026-11-14');
    expect(ops.map((o) => `${o.receta.id}:v${o.version.version}`)).toEqual(['postura:v2', 'recria:v1']);
  });
  it('tarjetas: mismo período del mes anterior (14/11 → 01/10–14/10; 31/03 → 01/02–28/02) y kg por receta', () => {
    expect(periodoComparable('2026-11-14')).toMatchObject({ desde: '2026-11-01', hasta: '2026-11-14', desdeAnt: '2026-10-01', hastaAnt: '2026-10-14', mesAnt: '2026-10' });
    expect(periodoComparable('2026-03-31')).toMatchObject({ desdeAnt: '2026-02-01', hastaAnt: '2026-02-28' });
    expect(periodoComparable('2026-01-10').mesAnt).toBe('2025-12');
    const e = estadoInicial();
    const total = kgEntre(e.fabricaciones, '2026-10-01', '2026-10-14');
    expect(total).toBe(kgEntre(e.fabricaciones, '2026-10-01', '2026-10-14', 'postura') + kgEntre(e.fabricaciones, '2026-10-01', '2026-10-14', 'recria'));
    expect(variacion(110, 100)).toBeCloseTo(10, 6);
    expect(variacion(5, 0)).toBeNull();
  });
  it('costo promedio del fabricado: ponderado por kg de cada receta; vista condensada: fin = día anterior a la siguiente versión', () => {
    const e = estadoInicial();
    const c = costoPromedioFabricado(e, '2026-10').costo!;
    const recetas = ['postura', 'recria'].map((id) => {
      const r = e.recetas.find((x) => x.id === id)!;
      return { kg: kgEntre(e.fabricaciones, '2026-10-01', '2026-10-31', id), costo: costoReceta(e.compras, versionVigente(r, '2026-10-31'), '2026-10').costo! };
    });
    expect(c).toBeCloseTo(recetas.reduce((t, x) => t + x.kg * x.costo, 0) / recetas.reduce((t, x) => t + x.kg, 0), 6);
    const postura = e.recetas.find((x) => x.id === 'postura')!;
    expect(hastaVersion(postura, postura.versiones[0])).toBe('2026-08-31');
    expect(hastaVersion(postura, postura.versiones[1])).toBeNull();
    const pre = e.recetas.find((x) => x.id === 'prepostura')!;
    expect(hastaVersion(pre, pre.versiones[0])).toBe('2026-07-31');   // inactiva desde 01/08: termina el día anterior
  });
  it('tarjeta de costo: último precio hoy vs al cierre del mes anterior, misma receta y mezcla (solo efecto precio)', () => {
    const e = estadoInicial();
    expect(ultimoCostoInsumo(e.compras, 'nucleo', '2026-11-14').costo).toBeCloseTo(2800, 6);   // nov no compró núcleo: el de octubre
    const hoy = costoActualMezcla(e, '2026-11-14'); const ant = costoActualMezcla(e, '2026-10-31');
    expect(hoy.porReceta.map((x) => x.receta.id)).toEqual(ant.porReceta.map((x) => x.receta.id));
    const v = versionVigente(e.recetas[0], '2026-11-14')!;
    expect(hoy.porReceta[0].costo).toBeCloseTo(costoRecetaAl(e.compras, v, '2026-11-14').costo!, 6);
    expect(hoy.estimado).toBe(true);   // las compras de noviembre tienen el flete pendiente
  });
  it('flete de Caja: el saldo baja con lo asignado; los fletes viejos están completos', () => {
    const e = estadoInicial();
    expect(e.fletes.filter((f) => saldoFlete(f, e.compras) > 0).map((f) => f.id)).toEqual(['fl-oct-soja', 'fl-nov']);
    const f = e.fletes.find((x) => x.id === 'fl-nov')!;
    const compras = e.compras.map((c) => (c.id === 'c-2026-11-maiz' ? { ...c, flete: 70_000, fleteId: 'fl-nov' } : c));
    expect(saldoFlete(f, compras)).toBe(48_000);
  });
  it('historial de recetas: el diff lista cambios de kg, agregados, quitados y tanda', () => {
    const e = estadoInicial();
    const nombre = (id: string) => e.ingredientes.find((i) => i.id === id)!.nombre;
    const v = e.recetas[0].versiones[1];   // postura v2
    const otras = v.lineas.filter((l) => !['maiz', 'nucleo', 'sal'].includes(l.ingredienteId));
    const nueva = { tandaKg: 200, lineas: [...otras, { ingredienteId: 'maiz', kg: 118, seccion: 'MACRO' as const }, { ingredienteId: 'afrechillo', kg: 8, seccion: 'MACRO' as const },
      { ingredienteId: 'sal', kg: 0.5, seccion: 'MACRO' as const }] };
    expect(diffReceta(v, nueva, nombre)).toBe('Maíz 119.21 → 118 kg · + Afrechillo de trigo 8 kg · Sal fina pasa a Macronutrientes · − Núcleo vitamínico (6 kg)');
    expect(diffReceta(v, v, nombre)).toBe('sin cambios en los ingredientes');
    expect(e.historialRecetas.length).toBeGreaterThan(0);
  });
  it('secciones: toda receta tiene Premezcla y Macronutrientes, suma el batch; premezcla con 3 decimales', () => {
    for (const r of estadoInicial().recetas) for (const v of r.versiones) {
      expect(new Set(v.lineas.map((l) => l.seccion))).toEqual(new Set(['PREMEZCLA', 'MACRO']));
      expect(v.lineas.reduce((t, l) => t + l.kg, 0)).toBeCloseTo(v.tandaKg, 6);
    }
    expect(kgLinea(0.29, 'PREMEZCLA')).toBe('0,290 kg');
    expect(kgLinea(119.21, 'MACRO')).toBe('119,21 kg');
    expect(escalarTanda(estadoInicial().recetas[0].versiones[1], 300).find((l) => l.ingredienteId === 'metionina')).toMatchObject({ kg: 0.435, seccion: 'PREMEZCLA' });
  });
  it('rectificación de fabricación: lista solo los campos que cambiaron', () => {
    const f = estadoInicial().fabricaciones[0];
    const et = (x: { versionId: string }) => x.versionId;
    expect(diffFabricacion(f, { ...f, kg: f.kg + 50 }, et)).toEqual([`Kilos ${f.kg} → ${f.kg + 50}`]);
    expect(diffFabricacion(f, { ...f, comentario: 'x' }, et)).toEqual(['Comentario «—» → «x»']);
    expect(diffFabricacion(f, { ...f }, et)).toEqual([]);
  });
  it('aislamiento: el prototipo no importa Supabase, RPC ni hooks de datos reales', () => {
    for (const f of readdirSync(DIR)) {
      const src = readFileSync(resolve(DIR, f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) expect(['react', 'lucide-react', 'recharts', '../../caja/Modal', '../../../auth/useAuth'].includes(i) || i.startsWith('./'), `${f} importa ${i}`).toBe(true);
      expect(src, f).not.toMatch(/\.rpc\(|\.from\(['"]|useMutation|useQuery/);
    }
    expect(readFileSync(resolve(DIR, '../AlimentoApp.tsx'), 'utf8')).toContain('<FabricacionesHistorial />');   // la vista real sigue
  });
});
