/**
 * PROTOTIPO Alimento Balanceado (etapa 1) — datos FICTICIOS y cálculos puros. Nada de este archivo lee ni escribe en
 * Supabase: el estado vive en memoria (useState) y se pierde al recargar.
 *
 * Método de costo (simulado): costo/kg de un insumo en el mes = promedio ponderado por kg de sus compras del mes,
 * con flete incluido ((precio × kg + flete) / kg); sin compras en el mes se usa el último costo conocido. Costo/kg de
 * una receta = Σ(kg del insumo en la tanda × costo/kg del insumo) / kg de la tanda, con la versión vigente al cierre
 * del mes. Consumo del mes = stock inicial + producción − stock final (requiere el cierre). Costo del consumo =
 * consumo × costo/kg de la receta del mes.
 */

export type Mes = string;   // 'YYYY-MM'
export interface Ingrediente { id: string; nombre: string; nuevo?: boolean }
/** Toda receta se divide en dos secciones; la premezcla va en cantidades chicas y se muestra con 3 decimales (0,290 kg = 290 g). */
export type Seccion = 'PREMEZCLA' | 'MACRO';
export const SECCIONES: { id: Seccion; label: string }[] = [{ id: 'PREMEZCLA', label: 'Premezcla' }, { id: 'MACRO', label: 'Macronutrientes' }];
export interface Linea { ingredienteId: string; kg: number; seccion: Seccion }
export const kgLinea = (n: number, s: Seccion) =>
  `${n.toLocaleString('es-AR', s === 'PREMEZCLA' ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : { maximumFractionDigits: 2 })} kg`;
export const pctLinea = (kg: number, total: number, s: Seccion) =>
  `${((kg / total) * 100).toLocaleString('es-AR', { minimumFractionDigits: s === 'PREMEZCLA' ? 3 : 1, maximumFractionDigits: s === 'PREMEZCLA' ? 3 : 1 })} %`;
export const lineasDe = (lineas: Linea[], s: Seccion) => lineas.filter((l) => l.seccion === s);
/** tandaKg = batch estándar (predeterminado en «Ver recetas»); las líneas son los kg para ese batch. */
export interface Version { id: string; version: number; desde: string; tandaKg: number; lineas: Linea[]; comentario?: string }
export interface Receta { id: string; nombre: string; activa: boolean; inactivaDesde?: string; versiones: Version[]; nuevo?: boolean }
export interface Compra {
  id: string; ingredienteId: string; kg: number; proveedor: string; fecha: string; precioKg: number;
  flete: number | null;        // null = flete pendiente
  fleteId?: string;            // flete de Caja al que está asignada (null/undefined con flete $0 confirmado)
  vinculoSimulado?: boolean;   // vinculado durante esta sesión del prototipo
}
/** Flete registrado en Caja (gasto de flete, pagado o pendiente de pago). Se asigna a compras; lo no asignado queda como saldo. */
export interface Flete { id: string; fecha: string; transportista: string; monto: number; pagado: boolean; comprobante: string }
/** Rectificación de una fabricación: quién, cuándo y qué cambió (texto «antes → después» por campo). */
export interface Rectificacion { cuando: string; quien: string; cambios: string[] }
export interface Fabricacion {
  id: string; fecha: string; recetaId: string; versionId: string; kg: number; responsable: string; comentario: string; nuevo?: boolean;
  rectificaciones?: Rectificacion[];
}

/** Cambios campo a campo entre dos versiones de una fabricación; vacío si no cambió nada. */
export function diffFabricacion(a: Fabricacion, b: Fabricacion, etiqueta: (f: Fabricacion) => string): string[] {
  const out: string[] = [];
  if (a.fecha !== b.fecha) out.push(`Fecha ${fechaDMA(a.fecha)} → ${fechaDMA(b.fecha)}`);
  if (a.versionId !== b.versionId) out.push(`Tipo ${etiqueta(a)} → ${etiqueta(b)}`);
  if (a.kg !== b.kg) out.push(`Kilos ${a.kg} → ${b.kg}`);
  if (a.comentario !== b.comentario) out.push(`Comentario «${a.comentario || '—'}» → «${b.comentario || '—'}»`);
  return out;
}
export interface Cierre { mes: Mes; finales: Record<string, number>; comentario: string; responsable: string; fecha: string; estado: 'CERRADO' | 'ABIERTO' }
export interface Auditoria { cuando: string; quien: string; que: string }
/** Historial de modificaciones de recetas: quién, cuándo, qué receta y qué cambió. */
export interface CambioReceta { cuando: string; quien: string; receta: string; cambio: string }
export interface Estado {
  ingredientes: Ingrediente[]; recetas: Receta[]; compras: Compra[]; fletes: Flete[]; fabricaciones: Fabricacion[]; cierres: Cierre[];
  stockInicial: Record<string, number>; auditoria: Auditoria[]; historialRecetas: CambioReceta[];
}

/** Diferencias entre dos formulaciones, en texto: cambios de kg, ingredientes agregados y quitados, y tanda. */
export function diffReceta(antes: Version | undefined, despues: Pick<Version, 'tandaKg' | 'lineas'>, nombre: (id: string) => string): string {
  const out: string[] = [];
  const previo = new Map((antes?.lineas ?? []).map((l) => [l.ingredienteId, l.kg]));
  for (const l of despues.lineas) {
    const k = previo.get(l.ingredienteId);
    if (k === undefined) out.push(`+ ${nombre(l.ingredienteId)} ${l.kg} kg`);
    else if (k !== l.kg) out.push(`${nombre(l.ingredienteId)} ${k} → ${l.kg} kg`);
    const antesSec = antes?.lineas.find((x) => x.ingredienteId === l.ingredienteId)?.seccion;
    if (antesSec && antesSec !== l.seccion) out.push(`${nombre(l.ingredienteId)} pasa a ${SECCIONES.find((s) => s.id === l.seccion)!.label}`);
    previo.delete(l.ingredienteId);
  }
  for (const [id, k] of previo) out.push(`− ${nombre(id)} (${k} kg)`);
  if (antes && antes.tandaKg !== despues.tandaKg) out.push(`tanda ${antes.tandaKg} → ${despues.tandaKg} kg`);
  return out.length ? out.join(' · ') : 'sin cambios en los ingredientes';
}

export const HOY = '2026-11-14';
export const MESES: Mes[] = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const NOMBRE_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const etiquetaMes = (m: Mes) => `${NOMBRE_MES[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
export const mesDe = (fecha: string): Mes => fecha.slice(0, 7);
export const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Datos iniciales ficticios ───────────────────────────────────────────────────────────────────────────────────
const ING: Ingrediente[] = [
  { id: 'maiz', nombre: 'Maíz' }, { id: 'soja', nombre: 'Expeller de soja' }, { id: 'conchilla', nombre: 'Conchilla' },
  { id: 'nucleo', nombre: 'Núcleo vitamínico' }, { id: 'afrechillo', nombre: 'Afrechillo de trigo' },
  { id: 'metionina', nombre: 'Metionina' }, { id: 'sal', nombre: 'Sal fina' },
];
const M = (ingredienteId: string, kg: number): Linea => ({ ingredienteId, kg, seccion: 'MACRO' });
const P = (ingredienteId: string, kg: number): Linea => ({ ingredienteId, kg, seccion: 'PREMEZCLA' });
const RECETAS: Receta[] = [
  { id: 'postura', nombre: 'Ponedoras postura', activa: true, versiones: [
    { id: 'postura-1', version: 1, desde: '2026-03-01', tandaKg: 200, lineas: [P('nucleo', 6), P('metionina', 0.29), P('sal', 0.5), M('maiz', 123.21), M('soja', 50), M('conchilla', 20)] },
    { id: 'postura-2', version: 2, desde: '2026-09-01', tandaKg: 200, comentario: 'Más conchilla por cáscara fina (ficticio)',
      lineas: [P('nucleo', 6), P('metionina', 0.29), P('sal', 0.5), M('maiz', 119.21), M('soja', 52), M('conchilla', 22)] },
  ] },
  { id: 'recria', nombre: 'Recría', activa: true, versiones: [
    { id: 'recria-1', version: 1, desde: '2026-03-01', tandaKg: 200, lineas: [P('nucleo', 6), P('metionina', 0.29), P('sal', 0.5), M('maiz', 115.21), M('soja', 60), M('afrechillo', 18)] },
  ] },
  { id: 'prepostura', nombre: 'Pre-postura', activa: false, inactivaDesde: '2026-08-01', versiones: [
    { id: 'prepostura-1', version: 1, desde: '2026-04-01', tandaKg: 150, lineas: [P('nucleo', 4.5), P('metionina', 0.2), P('sal', 0.2), M('maiz', 89.6), M('soja', 42), M('conchilla', 9), M('afrechillo', 4.5)] },
  ] },
];
const PRECIOS: Record<string, number[]> = {   // precio/kg por mes (jun→nov), ficticio
  maiz: [245, 252, 260, 268, 275, 281], soja: [410, 415, 428, 436, 445, 452], conchilla: [95, 95, 98, 102, 102, 105],
  nucleo: [2600, 2600, 2700, 2750, 2800, 2900], afrechillo: [180, 182, 188, 190, 196, 199],
  metionina: [9500, 9500, 9800, 9800, 10100, 10100], sal: [300, 300, 310, 310, 320, 320],
};
const KG_COMPRA: Record<string, number> = { maiz: 6000, soja: 2500, conchilla: 1000, nucleo: 300, afrechillo: 600, metionina: 25, sal: 50 };
const PROVEEDOR: Record<string, string> = {
  maiz: 'Acopio Ficticio SA', soja: 'Aceitera Demo SRL', conchilla: 'Canteras Ejemplo', nucleo: 'Nutrición Prueba SA', afrechillo: 'Molino Simulado',
  metionina: 'Nutrición Prueba SA', sal: 'Nutrición Prueba SA',
};

function comprasIniciales(): Compra[] {
  const out: Compra[] = [];
  MESES.forEach((m, i) => {
    for (const ing of ING) {
      if (ing.id === 'nucleo' && i % 2 === 1) continue;   // el núcleo se compra cada dos meses
      const kg = KG_COMPRA[ing.id];
      const pendiente = m === '2026-11' || (m === '2026-10' && ing.id === 'soja');
      out.push({ id: `c-${m}-${ing.id}`, ingredienteId: ing.id, kg, proveedor: PROVEEDOR[ing.id], fecha: `${m}-0${3 + (i % 5)}`,
        precioKg: PRECIOS[ing.id][i], flete: pendiente ? null : ing.id === 'nucleo' ? 0 : Math.round(kg * 12) });
    }
  });
  return out;
}

function fabricacionesIniciales(): Fabricacion[] {
  const out: Fabricacion[] = [];
  const quien = ['Juan (ficticio)', 'Marta (ficticia)'];
  MESES.forEach((m, i) => {
    const dias = m === '2026-11' ? [3, 6, 10, 13] : [2, 5, 9, 12, 16, 19, 23, 26];
    dias.forEach((d, j) => {
      const fecha = `${m}-${String(d).padStart(2, '0')}`;
      const receta = j % 3 === 2 ? 'recria' : 'postura';
      const versionId = receta === 'recria' ? 'recria-1' : fecha >= '2026-09-01' ? 'postura-2' : 'postura-1';
      out.push({ id: `f-${fecha}-${j}`, fecha, recetaId: receta, versionId, kg: j % 4 === 3 ? 400 : 200, responsable: quien[(i + j) % 2], comentario: '' });
    });
    if (m <= '2026-07') out.push({ id: `f-${m}-pp`, fecha: `${m}-20`, recetaId: 'prepostura', versionId: 'prepostura-1', kg: 150, responsable: quien[0], comentario: 'Última tanda antes de desactivar' });
  });
  return out.sort((a, b) => b.fecha.localeCompare(a.fecha));
}

const FINALES: Record<Mes, Record<string, number>> = {
  '2026-06': { postura: 420, recria: 180, prepostura: 60 }, '2026-07': { postura: 380, recria: 210, prepostura: 20 },
  '2026-08': { postura: 450, recria: 160, prepostura: 0 }, '2026-09': { postura: 400, recria: 190, prepostura: 0 },
  '2026-10': { postura: 430, recria: 170, prepostura: 0 },
};

/** Fletes de Caja: los de meses anteriores ya asignados a sus compras; dos sin asignar (uno pagado, uno pendiente de pago). */
function fletesYCompras(): { compras: Compra[]; fletes: Flete[] } {
  const compras = comprasIniciales();
  const fletes: Flete[] = [];
  MESES.forEach((m, i) => {
    const conFlete = compras.filter((c) => mesDe(c.fecha) === m && (c.flete ?? 0) > 0);
    if (conFlete.length === 0) return;
    const id = `fl-${m}`;
    conFlete.forEach((c) => { c.fleteId = id; });
    fletes.push({ id, fecha: `${m}-0${3 + (i % 5)}`, transportista: 'Transportes Ficticios SRL', monto: conFlete.reduce((t, c) => t + (c.flete ?? 0), 0), pagado: true, comprobante: `R-00${i + 1}` });
  });
  fletes.push({ id: 'fl-oct-soja', fecha: '2026-10-08', transportista: 'Fletes Demo', monto: 30_000, pagado: true, comprobante: 'R-0101' });
  fletes.push({ id: 'fl-nov', fecha: '2026-11-07', transportista: 'Transportes Ficticios SRL', monto: 118_000, pagado: false, comprobante: 'R-0102' });
  return { compras, fletes };
}

/** Saldo sin asignar de un flete = monto − lo ya asignado a compras. */
export const saldoFlete = (f: Flete, compras: Compra[]) => r2(f.monto - compras.filter((c) => c.fleteId === f.id).reduce((t, c) => t + (c.flete ?? 0), 0));

export function estadoInicial(): Estado {
  return {
    ingredientes: ING.map((i) => ({ ...i })), recetas: structuredClone(RECETAS), ...fletesYCompras(), fabricaciones: fabricacionesIniciales(),
    cierres: Object.entries(FINALES).map(([mes, finales]) => ({ mes, finales, comentario: '', responsable: 'Admin (ficticio)', fecha: `${mes}-30`, estado: 'CERRADO' as const })),
    stockInicial: { postura: 350, recria: 150, prepostura: 40 },
    auditoria: [{ cuando: '2026-11-13 18:05', quien: 'Juan (ficticio)', que: 'Fabricación 13/11 Ponedoras postura v2: 200 kg (alta)' }],
    historialRecetas: [
      { cuando: '2026-08-28 10:12', quien: 'Admin (ficticio)', receta: 'Ponedoras postura', cambio: 'Nueva versión v2 desde 01/09/26: Maíz 123.21 → 119.21 kg · Expeller de soja 50 → 52 kg · Conchilla 20 → 22 kg' },
      { cuando: '2026-07-31 17:40', quien: 'Admin (ficticio)', receta: 'Pre-postura', cambio: 'Desactivada desde 01/08/26' },
    ],
  };
}

// ── Cálculos ────────────────────────────────────────────────────────────────────────────────────────────────────
export const costoFinalKg = (c: Compra) => (c.precioKg * c.kg + (c.flete ?? 0)) / c.kg;

/** Costo/kg del insumo en el mes: ponderado por kg con flete; sin compras en el mes, el último conocido. */
export function costoInsumo(compras: Compra[], ingredienteId: string, mes: Mes): { costo: number | null; estimado: boolean } {
  const propias = compras.filter((c) => c.ingredienteId === ingredienteId && mesDe(c.fecha) <= mes).sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (propias.length === 0) return { costo: null, estimado: true };
  const ultimoMes = mesDe(propias[propias.length - 1].fecha);
  const delMes = propias.filter((c) => mesDe(c.fecha) === ultimoMes);
  const kg = delMes.reduce((t, c) => t + c.kg, 0);
  const total = delMes.reduce((t, c) => t + c.precioKg * c.kg + (c.flete ?? 0), 0);
  return { costo: total / kg, estimado: delMes.some((c) => c.flete === null) };
}

/** Versión vigente al último día del mes (la de mayor `desde` que no sea posterior). */
export function versionVigente(receta: Receta, fecha: string): Version | undefined {
  return [...receta.versiones].filter((v) => v.desde <= fecha).sort((a, b) => b.desde.localeCompare(a.desde))[0];
}
export const finDeMes = (m: Mes) => { const [y, mm] = m.split('-').map(Number); return `${m}-${String(new Date(y, mm, 0).getDate()).padStart(2, '0')}`; };

export function costoReceta(compras: Compra[], version: Version | undefined, mes: Mes): { costo: number | null; estimado: boolean } {
  if (!version) return { costo: null, estimado: false };
  let total = 0; let estimado = false;
  for (const l of version.lineas) {
    const c = costoInsumo(compras, l.ingredienteId, mes);
    if (c.costo === null) return { costo: null, estimado: true };
    total += l.kg * c.costo; estimado ||= c.estimado;
  }
  return { costo: total / version.tandaKg, estimado };
}

/** Escala las cantidades a otro tamaño de tanda, manteniendo la proporción. */
export function escalarTanda(v: Version, nuevoKg: number): Linea[] {
  const f = nuevoKg / v.tandaKg;
  return v.lineas.map((l) => ({ ...l, kg: Math.round(l.kg * f * 1000) / 1000 }));
}

/** Reparte el flete entre compras: proporcional a los kg (el redondeo se ajusta en la última) o manual. */
export function repartirFlete(total: number, compras: Pick<Compra, 'id' | 'kg'>[], modo: 'KG' | 'MANUAL', manual: Record<string, number> = {}): Record<string, number> {
  if (modo === 'MANUAL') return Object.fromEntries(compras.map((c) => [c.id, manual[c.id] ?? 0]));
  const kg = compras.reduce((t, c) => t + c.kg, 0);
  const out: Record<string, number> = {}; let asignado = 0;
  compras.forEach((c, i) => {
    const parte = i === compras.length - 1 ? r2(total - asignado) : r2((total * c.kg) / kg);
    out[c.id] = parte; asignado = r2(asignado + parte);
  });
  return out;
}

export interface FilaStock { recetaId: string; mes: Mes; inicial: number; produccion: number; final: number | null; consumo: number | null }

export const produccionMes = (fabs: Fabricacion[], recetaId: string, mes: Mes) =>
  fabs.filter((f) => f.recetaId === recetaId && mesDe(f.fecha) === mes).reduce((t, f) => t + f.kg, 0);

/** Stock por tipo y mes: inicial = final del mes anterior; consumo = inicial + producción − final (solo con cierre). */
export function tablaStock(e: Estado, recetaId: string): FilaStock[] {
  let inicial = e.stockInicial[recetaId] ?? 0;
  return MESES.map((mes) => {
    const cierre = e.cierres.find((c) => c.mes === mes && c.estado === 'CERRADO');
    const produccion = produccionMes(e.fabricaciones, recetaId, mes);
    const final = cierre ? cierre.finales[recetaId] ?? 0 : null;
    const fila = { recetaId, mes, inicial, produccion, final, consumo: final === null ? null : inicial + produccion - final };
    inicial = final ?? inicial + produccion;   // sin cierre, el mes siguiente arranca con el teórico
    return fila;
  });
}

export const mesCerrado = (e: Estado, fecha: string) => e.cierres.some((c) => c.mes === mesDe(fecha) && c.estado === 'CERRADO');

/** Recetas activas con su versión vigente hoy: las opciones del selector único tipo/versión. */
export function opcionesFabricacion(e: Estado, fecha: string) {
  return e.recetas.filter((r) => r.activa).flatMap((r) => { const v = versionVigente(r, fecha); return v ? [{ receta: r, version: v }] : []; });
}

/** Mismo período del mes anterior: del 1 al mismo día (acotado al largo del mes anterior). 14/11 → 01/10–14/10. */
export function periodoComparable(hoy: string) {
  const [y, m, d] = hoy.split('-').map(Number);
  const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
  const ultimo = new Date(py, pm, 0).getDate();
  const ant = `${py}-${String(pm).padStart(2, '0')}`;
  return { desde: `${hoy.slice(0, 7)}-01`, hasta: hoy, desdeAnt: `${ant}-01`, hastaAnt: `${ant}-${String(Math.min(d, ultimo)).padStart(2, '0')}`, mesAnt: ant };
}

export const kgEntre = (fabs: Fabricacion[], desde: string, hasta: string, recetaId?: string) =>
  fabs.filter((f) => f.fecha >= desde && f.fecha <= hasta && (!recetaId || f.recetaId === recetaId)).reduce((t, f) => t + f.kg, 0);

/** Costo/kg promedio del alimento fabricado en el mes: ponderado por los kg de cada receta. */
export function costoPromedioFabricado(e: Estado, mes: Mes): { costo: number | null; estimado: boolean } {
  let kg = 0; let total = 0; let estimado = false;
  for (const r of e.recetas) {
    const k = produccionMes(e.fabricaciones, r.id, mes);
    if (k === 0) continue;
    const c = costoReceta(e.compras, versionVigente(r, finDeMes(mes)), mes);
    if (c.costo === null) return { costo: null, estimado: true };
    kg += k; total += k * c.costo; estimado ||= c.estimado;
  }
  return { costo: kg === 0 ? null : total / kg, estimado };
}

/** Último precio de un insumo a una fecha: la compra más reciente (flete incluido); estimado si su flete está pendiente. */
export function ultimoCostoInsumo(compras: Compra[], ingredienteId: string, fecha: string): { costo: number | null; estimado: boolean } {
  const c = compras.filter((x) => x.ingredienteId === ingredienteId && x.fecha <= fecha).sort((a, b) => a.fecha.localeCompare(b.fecha)).at(-1);
  return c ? { costo: costoFinalKg(c), estimado: c.flete === null } : { costo: null, estimado: true };
}

/** Costo/kg de una versión con el último precio de cada insumo a la fecha. */
export function costoRecetaAl(compras: Compra[], v: Version | undefined, fecha: string): { costo: number | null; estimado: boolean } {
  if (!v) return { costo: null, estimado: false };
  let total = 0; let estimado = false;
  for (const l of v.lineas) {
    const c = ultimoCostoInsumo(compras, l.ingredienteId, fecha);
    if (c.costo === null) return { costo: null, estimado: true };
    total += l.kg * c.costo; estimado ||= c.estimado;
  }
  return { costo: total / v.tandaKg, estimado };
}

/**
 * Tarjeta de costo: costo/kg con el último precio de cada insumo a `fecha`, con la receta vigente HOY y ponderado por
 * los kg fabricados en el mes en curso (sin fabricaciones, pesos iguales). Mismas recetas y mezcla en ambas fechas:
 * la diferencia es solo de precios.
 */
export function costoActualMezcla(e: Estado, fecha: string) {
  const activas = e.recetas.filter((r) => r.activa);
  const pesosMezcla = activas.map((r) => produccionMes(e.fabricaciones, r.id, mesDe(HOY)));
  const sumaPesos = pesosMezcla.reduce((a, b) => a + b, 0);
  const porReceta = activas.map((r, i) => ({ receta: r, peso: sumaPesos === 0 ? 1 : pesosMezcla[i], ...costoRecetaAl(e.compras, versionVigente(r, HOY), fecha) }));
  if (porReceta.length === 0 || porReceta.some((x) => x.costo === null)) return { costo: null, estimado: true, porReceta };
  const w = porReceta.reduce((t, x) => t + x.peso, 0);
  return { costo: porReceta.reduce((t, x) => t + x.peso * x.costo!, 0) / w, estimado: porReceta.some((x) => x.estimado), porReceta };
}

const diaAnterior = (f: string) => { const d = new Date(`${f}T12:00:00`); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); };

/** Fin de una versión: el día anterior al inicio de la siguiente; la última termina el día anterior a la desactivación (o null: en uso). */
export function hastaVersion(r: Receta, v: Version): string | null {
  const sig = [...r.versiones].filter((x) => x.desde > v.desde).sort((a, b) => a.desde.localeCompare(b.desde))[0];
  if (sig) return diaAnterior(sig.desde);
  return !r.activa && r.inactivaDesde ? diaAnterior(r.inactivaDesde) : null;
}
export const fechaDMA = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(2, 4)}`;

export const variacion = (actual: number, anterior: number) => (anterior === 0 ? null : ((actual - anterior) / anterior) * 100);
export const fechaCorta = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;

export const pesos =(n: number | null) => (n === null ? '—' : `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const kgTxt = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('es-AR', { maximumFractionDigits: 1 })} kg`);
export const ahora = () => `${HOY} ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
