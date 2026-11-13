/**
 * Caja → Cuentas a pagar / Cartera de cheques: DEMONSTRATION model (caja-mejoras-v2 prototype). Pure and fictitious: no Supabase client,
 * no RPC, no write. Every pending expense is split into due items (vencimientos): a single payment, informal instalments or own cheques /
 * eCheqs. A payment goes to the item the user picks (never "oldest first"); a cheque is not paid by hand (the bank debits it).
 * Owner decisions 2026-11-13: a cheque needs a supplier; groups Vencidos / Esta semana / Este mes / Más adelante / Sin fecha; one expense
 * form for all Caja (paid or pending); any field editable with a pencil → marked Rectificado, with who / when / before / after in the history;
 * the cheque wallet is a Caja section: a client cheque comes in from Cuentas corrientes and is endorsed to a supplier against a due item.
 */
export type TipoVto = 'PAGO' | 'CUOTA' | 'CHEQUE' | 'ECHEQ';
export type Medio = 'TRANSFER' | 'CASH' | 'MERCADOPAGO';
export interface Vto { id: string; gastoId: string; tipo: TipoVto; fecha: string | null; importe: number; pagado: number; numero?: string; cuenta?: string }
export interface Cambio { cuando: string; quien: string; que: string; antes?: string; despues?: string; motivo?: string }
export interface Gasto {
  id: string; concepto: string; proveedorId: string | null; categoria: string; fecha: string; total: number; comprobante: string | null;
  rectificado: boolean; historial: Cambio[];
}
export interface Proveedor { id: string; nombre: string; aFavor: number }
export interface ChequeTercero {
  id: string; numero: string; banco: string; librador: string; importe: number; fechaCobro: string;
  estado: 'EN_CARTERA' | 'DEPOSITADO' | 'ENDOSADO'; destino?: string;
}
export interface DemoPagar { proveedores: Proveedor[]; gastos: Gasto[]; vtos: Vto[]; cartera: ChequeTercero[] }
export interface Autor { cuando: string; quien: string }

export type Grupo = 'VENCIDO' | 'SEMANA' | 'MES' | 'ADELANTE' | 'SIN_FECHA';
export const GRUPOS: { id: Grupo; label: string }[] = [
  { id: 'VENCIDO', label: 'Vencidos' }, { id: 'SEMANA', label: 'Esta semana' }, { id: 'MES', label: 'Este mes' },
  { id: 'ADELANTE', label: 'Más adelante' }, { id: 'SIN_FECHA', label: 'Sin fecha' },
];
export type Tarjeta = 'TOTAL' | 'VENCIDO' | 'PROX7' | 'PROX30' | 'SIN_FECHA';
export const TIPO_LABEL: Record<TipoVto, string> = { PAGO: 'Pago único', CUOTA: 'Cuota', CHEQUE: 'Cheque', ECHEQ: 'eCheq' };
export const MEDIO_LABEL: Record<Medio, string> = { TRANSFER: 'Transferencia', CASH: 'Efectivo', MERCADOPAGO: 'Mercado Pago' };
export const CUENTAS: Record<Medio, string[]> = { TRANSFER: ['BNA', 'Banco Provincia'], CASH: ['Caja efectivo'], MERCADOPAGO: ['Mercado Pago'] };

export const esCheque = (v: Pick<Vto, 'tipo'>) => v.tipo === 'CHEQUE' || v.tipo === 'ECHEQ';
const r2 = (n: number) => Math.round(n * 100) / 100;
export const pendiente = (v: Pick<Vto, 'importe' | 'pagado'>) => r2(v.importe - v.pagado);
export const pesos = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
export const ddmm = (s: string | null) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : 'sin fecha');

// ── dates ───────────────────────────────────────────────────────────────────
const d = (s: string) => new Date(`${s}T00:00:00Z`);
export const masDias = (s: string, n: number) => { const x = d(s); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export function masMeses(s: string, n: number): string {
  const [y, m, dd] = s.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(dd, ultimo))).toISOString().slice(0, 10);
}
const finSemana = (hoy: string) => masDias(hoy, 6 - ((d(hoy).getUTCDay() + 6) % 7));   // Sunday of the current Monday–Sunday week
const finMes = (hoy: string) => masDias(masMeses(`${hoy.slice(0, 7)}-01`, 1), -1);

export function grupo(fecha: string | null, hoy: string): Grupo {
  if (fecha === null) return 'SIN_FECHA';
  if (fecha < hoy) return 'VENCIDO';
  if (fecha <= finSemana(hoy)) return 'SEMANA';
  if (fecha <= finMes(hoy)) return 'MES';
  return 'ADELANTE';
}
/** Whether an open item belongs to a summary card (each card is also the list's filter). */
export function enTarjeta(v: Pick<Vto, 'fecha'>, t: Tarjeta, hoy: string): boolean {
  if (t === 'TOTAL') return true;
  if (t === 'SIN_FECHA') return v.fecha === null;
  if (v.fecha === null) return false;
  if (t === 'VENCIDO') return v.fecha < hoy;
  return v.fecha >= hoy && v.fecha <= masDias(hoy, t === 'PROX7' ? 7 : 30);
}
export function totales(vtos: Vto[], hoy: string): Record<Tarjeta, number> {
  const abiertos = vtos.filter((v) => pendiente(v) > 0);
  const suma = (t: Tarjeta) => r2(abiertos.filter((v) => enTarjeta(v, t, hoy)).reduce((x, v) => x + pendiente(v), 0));
  return { TOTAL: suma('TOTAL'), VENCIDO: suma('VENCIDO'), PROX7: suma('PROX7'), PROX30: suma('PROX30'), SIN_FECHA: suma('SIN_FECHA') };
}

// ── payment plans ───────────────────────────────────────────────────────────
export type Frecuencia = 'MENSUAL' | 'QUINCENAL' | 'SEMANAL';
export interface VtoNuevo { tipo: TipoVto; fecha: string | null; importe: number; numero?: string; cuenta?: string }
/** n instalments of the total (the last one takes the rounding), from the first date on. */
export function repartirCuotas(total: number, n: number, primera: string, f: Frecuencia): { fecha: string; importe: number }[] {
  const base = Math.floor((total / n) * 100) / 100;
  return Array.from({ length: n }, (_, i) => ({
    fecha: f === 'MENSUAL' ? masMeses(primera, i) : masDias(primera, i * (f === 'QUINCENAL' ? 15 : 7)),
    importe: i === n - 1 ? r2(total - base * (n - 1)) : base,
  }));
}
/** Why a payment plan for `total` cannot be used, or null. */
export function validarPlan(total: number, vtos: VtoNuevo[], proveedorId: string | null): string | null {
  if (vtos.length === 0) return 'Falta al menos un vencimiento.';
  if (vtos.some((v) => !(v.importe > 0))) return 'Cada vencimiento necesita un importe mayor a cero.';
  if (Math.abs(r2(vtos.reduce((t, v) => t + v.importe, 0)) - total) > 0.005) return 'Los vencimientos tienen que sumar el total.';
  if (vtos.some(esCheque)) {
    if (!proveedorId) return 'Para pagar con cheque o eCheq hay que elegir el proveedor.';
    if (vtos.some((v) => esCheque(v) && (!v.numero?.trim() || !v.fecha))) return 'Cada cheque necesita número y fecha de pago.';
  }
  return null;
}

// ── new expense: paid or pending, one form ──────────────────────────────────
export interface NuevoGasto {
  concepto: string; proveedorId: string | null; categoria: string; fecha: string; total: number; comprobante: string | null;
  pagado: { medio: Medio; cuenta: string; fecha: string } | null;   // null = pending
  vtos: VtoNuevo[];   // only when pending
}
export function validarGasto(g: NuevoGasto): string | null {
  if (!g.concepto.trim()) return 'Falta el concepto.';
  if (!g.categoria) return 'Falta la categoría.';
  if (!(g.total > 0)) return 'El importe debe ser mayor a cero.';
  if (g.pagado) return g.pagado.cuenta ? null : 'Falta la cuenta de donde salió el dinero.';
  return validarPlan(g.total, g.vtos, g.proveedorId);
}
export function agregarGasto(s: DemoPagar, g: NuevoGasto, id: string, a: Autor): DemoPagar {
  const alta: Cambio = { ...a, que: g.pagado ? `Registrado y pagado (${MEDIO_LABEL[g.pagado.medio]} · ${g.pagado.cuenta})` : 'Registrado como pendiente de pago' };
  const gasto: Gasto = { id, concepto: g.concepto.trim(), proveedorId: g.proveedorId, categoria: g.categoria, fecha: g.fecha, total: g.total,
    comprobante: g.comprobante, rectificado: false, historial: [alta] };
  const vtos: Vto[] = g.pagado ? [{ id: `${id}-1`, gastoId: id, tipo: 'PAGO', fecha: g.pagado.fecha, importe: g.total, pagado: g.total }]
    : g.vtos.map((v, i) => ({ ...v, id: `${id}-${i + 1}`, gastoId: id, pagado: 0 }));
  return { ...s, gastos: [...s.gastos, gasto], vtos: [...s.vtos, ...vtos] };
}

// ── actions on a due item ───────────────────────────────────────────────────
const conGasto = (s: DemoPagar, gastoId: string, f: (g: Gasto) => Gasto): DemoPagar => ({ ...s, gastos: s.gastos.map((g) => (g.id === gastoId ? f(g) : g)) });
const nota = (s: DemoPagar, gastoId: string, c: Cambio, rectifica = false) =>
  conGasto(s, gastoId, (g) => ({ ...g, rectificado: g.rectificado || rectifica, historial: [...g.historial, c] }));
/** The label of an item inside its expense ("Cuota 2/4", "eCheq E-1", "Pago único"). */
export function etiquetaVto(s: DemoPagar, v: Vto): string {
  if (esCheque(v)) return `${TIPO_LABEL[v.tipo]} ${v.numero} · ${v.cuenta}`;
  if (v.tipo !== 'CUOTA') return 'Pago único';
  const cuotas = s.vtos.filter((x) => x.gastoId === v.gastoId && x.tipo === 'CUOTA');
  return `Cuota ${cuotas.findIndex((x) => x.id === v.id) + 1}/${cuotas.length}`;
}

/** Pays (part of) ONE item from an account. */
export function pagarVto(s: DemoPagar, vtoId: string, monto: number, medio: Medio, cuenta: string, a: Autor): DemoPagar {
  const v = s.vtos.find((x) => x.id === vtoId)!;
  if (esCheque(v) || !(monto > 0) || monto > pendiente(v) + 0.005) throw new Error('PAGO_INVALIDO');
  const s2 = { ...s, vtos: s.vtos.map((x) => (x.id === vtoId ? { ...x, pagado: r2(x.pagado + monto) } : x)) };
  return nota(s2, v.gastoId, { ...a, que: `Pago de ${pesos(monto)} · ${etiquetaVto(s, v)} · ${MEDIO_LABEL[medio]} (${cuenta})` });
}
/** Pays (part of) ONE item by issuing an own cheque / eCheq: that part becomes a cheque to be debited on its date. */
export function pagarConCheque(s: DemoPagar, vtoId: string, ch: { tipo: 'CHEQUE' | 'ECHEQ'; numero: string; cuenta: string; fecha: string; importe: number }, a: Autor): DemoPagar {
  const v = s.vtos.find((x) => x.id === vtoId)!;
  const g = s.gastos.find((x) => x.id === v.gastoId)!;
  if (!g.proveedorId) throw new Error('CHEQUE_SIN_PROVEEDOR');
  if (esCheque(v) || !(ch.importe > 0) || ch.importe > pendiente(v) + 0.005 || !ch.numero.trim() || !ch.fecha) throw new Error('CHEQUE_INVALIDO');
  const nuevo: Vto = { id: `${v.id}-ch${s.vtos.length}`, gastoId: v.gastoId, tipo: ch.tipo, fecha: ch.fecha, importe: ch.importe, pagado: 0, numero: ch.numero.trim(), cuenta: ch.cuenta };
  const vtos = s.vtos.flatMap((x) => (x.id === vtoId ? (r2(x.importe - ch.importe) > 0 ? [{ ...x, importe: r2(x.importe - ch.importe) }, nuevo] : [nuevo]) : [x]));
  return nota({ ...s, vtos }, v.gastoId, { ...a, que: `${TIPO_LABEL[ch.tipo]} ${ch.numero} emitido por ${pesos(ch.importe)} (${etiquetaVto(s, v)}), se debita el ${ddmm(ch.fecha)}` });
}
/** The bank debited an own cheque (in the real system this comes from the statement). */
export function marcarDebitado(s: DemoPagar, vtoId: string, a: Autor): DemoPagar {
  const v = s.vtos.find((x) => x.id === vtoId)!;
  return nota({ ...s, vtos: s.vtos.map((x) => (x.id === vtoId ? { ...x, pagado: x.importe } : x)) }, v.gastoId, { ...a, que: `${TIPO_LABEL[v.tipo]} ${v.numero} debitado` });
}
/** What is still open of an expense (paid parts and cheques stay as they are). */
export function abiertoReplanificable(s: DemoPagar, gastoId: string): number {
  return r2(s.vtos.filter((v) => v.gastoId === gastoId && !esCheque(v)).reduce((t, v) => t + pendiente(v), 0));
}
/** Replaces what is still open (not paid, not in cheques) with a new plan: single payment, instalments or cheques. */
export function replanificar(s: DemoPagar, gastoId: string, plan: VtoNuevo[], a: Autor): DemoPagar {
  const g = s.gastos.find((x) => x.id === gastoId)!;
  const abierto = abiertoReplanificable(s, gastoId);
  const err = validarPlan(abierto, plan, g.proveedorId);
  if (err) throw new Error(err);
  const quedan = s.vtos.flatMap((v) => {
    if (v.gastoId !== gastoId || esCheque(v)) return [v];
    return v.pagado > 0 ? [{ ...v, importe: v.pagado }] : [];   // a partly paid item closes at what was paid
  });
  const nuevos = plan.map((p, i) => ({ ...p, id: `${gastoId}-r${s.vtos.length + i}`, gastoId, pagado: 0 }));
  const forma = plan.some(esCheque) ? `${plan.length} cheque(s)` : plan.length > 1 ? `${plan.length} cuotas` : 'un pago';
  return nota({ ...s, vtos: [...quedan, ...nuevos] }, gastoId, { ...a, que: `Forma de pago cambiada: ${pesos(abierto)} en ${forma}` });
}

// ── rectifications (pencil) ─────────────────────────────────────────────────
export interface DatosGasto { concepto: string; proveedorId: string | null; categoria: string; fecha: string; comprobante: string | null; total: number }
/** Edits the expense's own data. A new total moves the difference to its last open item (not a cheque). Each change → history, Rectificado. */
export function editarGasto(s: DemoPagar, gastoId: string, nuevo: DatosGasto, motivo: string, a: Autor): DemoPagar {
  const g = s.gastos.find((x) => x.id === gastoId)!;
  if (!motivo.trim()) throw new Error('Falta el motivo de la rectificación.');
  if (!nuevo.concepto.trim()) throw new Error('Falta el concepto.');
  const propios = s.vtos.filter((v) => v.gastoId === gastoId);
  if (!nuevo.proveedorId && propios.some(esCheque)) throw new Error('Tiene cheques emitidos: el proveedor es obligatorio.');
  let vtos = s.vtos;
  const delta = r2(nuevo.total - g.total);
  if (delta !== 0) {
    const ultimo = [...propios].reverse().find((v) => !esCheque(v) && pendiente(v) > 0) ?? [...propios].reverse().find((v) => !esCheque(v));
    if (!ultimo || r2(ultimo.importe + delta) < ultimo.pagado || r2(ultimo.importe + delta) <= 0) throw new Error('El nuevo total no entra en lo que queda por pagar.');
    vtos = s.vtos.map((v) => (v.id === ultimo.id ? { ...v, importe: r2(v.importe + delta) } : v));
  }
  const nombre = (id: string | null) => (id ? s.proveedores.find((p) => p.id === id)?.nombre ?? '—' : 'Sin proveedor');
  const campos: [string, string, string][] = [
    ['Concepto', g.concepto, nuevo.concepto.trim()], ['Proveedor', nombre(g.proveedorId), nombre(nuevo.proveedorId)], ['Categoría', g.categoria, nuevo.categoria],
    ['Fecha', g.fecha, nuevo.fecha], ['Comprobante', g.comprobante ?? '—', nuevo.comprobante?.trim() || '—'], ['Total', pesos(g.total), pesos(nuevo.total)],
  ];
  const cambios = campos.filter(([, x, y]) => x !== y);
  if (cambios.length === 0) return s;
  const s2: DemoPagar = { ...s, vtos, gastos: s.gastos.map((x) => (x.id === gastoId
    ? { ...x, concepto: nuevo.concepto.trim(), proveedorId: nuevo.proveedorId, categoria: nuevo.categoria, fecha: nuevo.fecha, comprobante: nuevo.comprobante?.trim() || null, total: nuevo.total }
    : x)) };
  return cambios.reduce((acc, [que, antes, despues]) => nota(acc, gastoId, { ...a, que, antes, despues, motivo: motivo.trim() }, true), s2);
}
/** Edits one item's date and / or amount (a cheque only its date). A new amount changes the expense's total too. */
export function editarVto(s: DemoPagar, vtoId: string, nuevo: { fecha: string | null; importe: number }, motivo: string, a: Autor): DemoPagar {
  const v = s.vtos.find((x) => x.id === vtoId)!;
  if (!motivo.trim()) throw new Error('Falta el motivo de la rectificación.');
  if (esCheque(v) && nuevo.importe !== v.importe) throw new Error('El importe de un cheque emitido no se cambia.');
  if (esCheque(v) && !nuevo.fecha) throw new Error('Un cheque necesita fecha de pago.');
  if (!(nuevo.importe > 0) || nuevo.importe < v.pagado) throw new Error('El importe no puede ser menor a lo ya pagado.');
  const delta = r2(nuevo.importe - v.importe);
  let s2: DemoPagar = { ...s, vtos: s.vtos.map((x) => (x.id === vtoId ? { ...x, fecha: nuevo.fecha, importe: nuevo.importe } : x)) };
  if (delta !== 0) s2 = conGasto(s2, v.gastoId, (g) => ({ ...g, total: r2(g.total + delta) }));
  const et = etiquetaVto(s, v);
  if (nuevo.fecha !== v.fecha) s2 = nota(s2, v.gastoId, { ...a, que: `Fecha · ${et}`, antes: ddmm(v.fecha), despues: ddmm(nuevo.fecha), motivo: motivo.trim() }, true);
  if (delta !== 0) s2 = nota(s2, v.gastoId, { ...a, que: `Importe · ${et} (cambia el total)`, antes: pesos(v.importe), despues: pesos(nuevo.importe), motivo: motivo.trim() }, true);
  return s2;
}

// ── supplier summary (when the list is filtered by one supplier) ────────────
export function resumenProveedor(s: DemoPagar, proveedorId: string, hoy: string) {
  const ids = new Set(s.gastos.filter((g) => g.proveedorId === proveedorId).map((g) => g.id));
  const abiertos = s.vtos.filter((v) => ids.has(v.gastoId) && pendiente(v) > 0);
  const suma = (xs: Vto[]) => r2(xs.reduce((t, v) => t + pendiente(v), 0));
  return {
    deuda: suma(abiertos.filter((v) => !esCheque(v))),
    vencido: suma(abiertos.filter((v) => !esCheque(v) && v.fecha !== null && v.fecha < hoy)),
    cheques: suma(abiertos.filter(esCheque)),
    aFavor: s.proveedores.find((p) => p.id === proveedorId)?.aFavor ?? 0,
  };
}

// ── cheque wallet (Caja section) ────────────────────────────────────────────
export function depositar(s: DemoPagar, chequeId: string, cuenta: string): DemoPagar {
  return { ...s, cartera: s.cartera.map((c) => (c.id === chequeId ? { ...c, estado: 'DEPOSITADO', destino: cuenta } : c)) };
}
/** Endorses a client cheque to a supplier against ONE of its due items; what exceeds that item stays in the supplier's favour. */
export function endosar(s: DemoPagar, chequeId: string, vtoId: string, a: Autor): { s: DemoPagar; aFavor: number } {
  const c = s.cartera.find((x) => x.id === chequeId)!;
  const v = s.vtos.find((x) => x.id === vtoId)!;
  const g = s.gastos.find((x) => x.id === v.gastoId)!;
  if (c.estado !== 'EN_CARTERA' || esCheque(v) || !g.proveedorId) throw new Error('ENDOSO_INVALIDO');
  const aplicado = Math.min(c.importe, pendiente(v));
  const aFavor = r2(c.importe - aplicado);
  const prov = s.proveedores.find((p) => p.id === g.proveedorId)!;
  let s2: DemoPagar = {
    ...s,
    vtos: s.vtos.map((x) => (x.id === vtoId ? { ...x, pagado: r2(x.pagado + aplicado) } : x)),
    cartera: s.cartera.map((x) => (x.id === chequeId ? { ...x, estado: 'ENDOSADO', destino: prov.nombre } : x)),
    proveedores: s.proveedores.map((p) => (p.id === prov.id ? { ...p, aFavor: r2(p.aFavor + aFavor) } : p)),
  };
  s2 = nota(s2, g.id, { ...a, que: `Cheque de cliente ${c.numero} (${c.librador}) endosado: ${pesos(aplicado)} a ${etiquetaVto(s, v)}${aFavor > 0 ? `; ${pesos(aFavor)} a favor` : ''}` });
  return { s: s2, aFavor };
}

// ── fictitious seed (dates relative to today, so every group has rows) ──────
export function semillaDemo(hoy: string): DemoPagar {
  const D = (n: number) => masDias(hoy, n);
  const a: Autor = { cuando: `${D(-40)} 09:00`, quien: 'demo' };
  let s: DemoPagar = {
    proveedores: [
      { id: 'p1', nombre: 'Agro Cereales del Sur', aFavor: 0 }, { id: 'p2', nombre: 'Nutrición Avícola SA', aFavor: 0 },
      { id: 'p3', nombre: 'Veterinaria San Roque', aFavor: 0 }, { id: 'p4', nombre: 'Envases Pampa', aFavor: 0 }, { id: 'p5', nombre: 'Cooperativa Eléctrica', aFavor: 0 },
    ],
    gastos: [], vtos: [], cartera: [],
  };
  const g = (id: string, x: Omit<NuevoGasto, 'pagado'>) => { s = agregarGasto(s, { ...x, pagado: null }, id, a); };
  const cuotas = (total: number, n: number, primera: string, f: Frecuencia) => repartirCuotas(total, n, primera, f).map((c) => ({ tipo: 'CUOTA' as const, ...c }));
  g('g1', { concepto: 'Maíz 30 tn', proveedorId: 'p1', categoria: 'Alimento', fecha: D(-40), total: 4_200_000, comprobante: 'Factura A 0003-00012345', vtos: cuotas(4_200_000, 4, D(-10), 'MENSUAL') });
  g('g2', { concepto: 'Núcleo vitamínico', proveedorId: 'p2', categoria: 'Alimento', fecha: D(-20), total: 1_850_000, comprobante: 'Factura A 0001-00004521',
    vtos: [{ tipo: 'ECHEQ', fecha: D(3), importe: 925_000, numero: 'E-778812', cuenta: 'BNA' }, { tipo: 'ECHEQ', fecha: D(33), importe: 925_000, numero: 'E-778813', cuenta: 'BNA' }] });
  g('g3', { concepto: 'Vacunas Newcastle', proveedorId: 'p3', categoria: 'Sanidad', fecha: D(-15), total: 380_000, comprobante: null, vtos: [{ tipo: 'PAGO', fecha: D(-2), importe: 380_000 }] });
  g('g4', { concepto: 'Maples 30 u. (5.000)', proveedorId: 'p4', categoria: 'Envases', fecha: D(-5), total: 640_000, comprobante: 'Factura B 0002-00000981',
    vtos: [{ tipo: 'CHEQUE', fecha: D(12), importe: 640_000, numero: '00045123', cuenta: 'BNA' }] });
  g('g5', { concepto: 'Energía octubre', proveedorId: 'p5', categoria: 'Servicios', fecha: D(-8), total: 215_000, comprobante: 'Factura B 0005-00123456', vtos: [{ tipo: 'PAGO', fecha: D(5), importe: 215_000 }] });
  g('g6', { concepto: 'Reparación bomba de agua', proveedorId: null, categoria: 'Mantenimiento', fecha: D(-3), total: 180_000, comprobante: null, vtos: [{ tipo: 'PAGO', fecha: null, importe: 180_000 }] });
  g('g7', { concepto: 'Flete alimento', proveedorId: null, categoria: 'Fletes', fecha: D(-1), total: 95_000, comprobante: null, vtos: cuotas(95_000, 2, D(20), 'QUINCENAL') });
  g('g8', { concepto: 'Balanceado postura 12 tn', proveedorId: 'p2', categoria: 'Alimento', fecha: D(-2), total: 2_600_000, comprobante: null, vtos: cuotas(2_600_000, 3, D(25), 'MENSUAL') });
  s = pagarVto(s, 'g1-1', 1_050_000, 'TRANSFER', 'BNA', { cuando: `${D(-10)} 11:30`, quien: 'demo' });   // 1st instalment of g1 paid
  s.cartera = [
    { id: 'c1', numero: '00981234', banco: 'Banco Provincia', librador: 'Almacén Don Pedro', importe: 310_000, fechaCobro: D(4), estado: 'EN_CARTERA' },
    { id: 'c2', numero: '12004567', banco: 'Banco Galicia', librador: 'Supermercado La Esquina', importe: 520_000, fechaCobro: D(18), estado: 'EN_CARTERA' },
    { id: 'c3', numero: '00771100', banco: 'Banco Nación', librador: 'Panadería El Trigal', importe: 145_000, fechaCobro: D(-6), estado: 'DEPOSITADO', destino: 'BNA' },
  ];
  return s;
}
export const CATEGORIAS = ['Alimento', 'Personal', 'Sanidad', 'Envases', 'Servicios', 'Mantenimiento', 'Fletes', 'Impuestos y bancos', 'Otros'];
