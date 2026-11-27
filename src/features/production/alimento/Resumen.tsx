import { type ReactNode, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getTodayDate } from '../../../utils/dateUtils';
import { DesgloseReceta } from './DesgloseReceta';
import { Evolucion } from './Evolucion';
import { etiquetaMes, fechaCorta, kgTxt, mesAnterior, mesDe, meses, periodoComparable, pesos, variacion } from './format';
import { Tabla, Titulo, td, tdR, thL, thR } from './ui';
import { useAllFeedTypes, useComposition, useConsumptionCosts, useFabricaciones, useFeedMonths, useFeedPurchases, useIngredientCosts, useRecipeCosts } from './useAlimento';

const METODO = (
  <>
    <p><b>Costo por kg de cada receta:</b> Σ (kg de cada insumo en el batch × su costo por kg del mes) ÷ kg del batch, con la versión vigente a fin de mes.</p>
    <p><b>Costo por kg de un insumo:</b> promedio ponderado por kg de las compras del mes, flete incluido; con Factura A, sin IVA. Sin compras en el mes, el último costo conocido.</p>
    <p><b>Consumo:</b> stock inicial + producción − stock final del cierre mensual. Sin cierre, el consumo del mes no se calcula.</p>
    <p><b>Costo del consumo:</b> kg consumidos × costo por kg del mes. Desde noviembre 2026 es el gasto de alimento del estado de resultados.</p>
    <p>* = estimado: hay compras con flete pendiente.</p>
  </>
);
const fmtPesos = (v: number) => `$ ${v.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
const fmtKg = (v: number) => `${v.toLocaleString('es-AR', { maximumFractionDigits: 0 })} kg`;

function Variacion({ actual, anterior, subeEsMalo }: { actual: number; anterior: number; subeEsMalo?: boolean }) {
  const v = variacion(actual, anterior);
  if (v === null) return <span className="text-xs text-gray-500">sin dato anterior</span>;
  const color = subeEsMalo === undefined || Math.abs(v) < 0.05 ? 'text-gray-600' : (v > 0) === subeEsMalo ? 'text-red-700' : 'text-green-700';
  return <span className={`text-xs font-semibold ${color}`}>{v > 0 ? '▲' : v < 0 ? '▼' : '='} {Math.abs(v).toLocaleString('es-AR', { maximumFractionDigits: 1 })} %</span>;
}
function Tarjeta({ titulo, valor, pie, detalle }: { titulo: string; valor: ReactNode; pie: ReactNode; detalle?: ReactNode }) {
  return (
    <div tabIndex={detalle ? 0 : undefined} className="group relative bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">{titulo}</p>
      <p className="text-2xl font-bold text-amber-900 mt-1">{valor}</p>
      <div className="text-xs text-gray-600 mt-0.5">{pie}</div>
      {detalle && <div className="hidden group-hover:block group-focus:block absolute left-0 right-0 top-full z-10 mt-1 bg-white border border-[#E4DCC8] rounded-lg shadow p-3 text-xs space-y-1">{detalle}</div>}
    </div>
  );
}

/** Resumen (ADMIN): indicators, monthly charts and tables. Every number comes from the backend views; nothing is computed here but sums for display. */
export function Resumen() {
  const hoy = getTodayDate();
  const lista = meses(mesAnterior(mesAnterior(mesAnterior(mesAnterior(mesAnterior(mesDe(hoy)))))), hoy);   // last 6 months
  const tipos = useAllFeedTypes();
  const fabs = useFabricaciones(lista[0], hoy);
  const meses_ = useFeedMonths();
  const costos = useRecipeCosts();
  const consumo = useConsumptionCosts();
  const compras = useFeedPurchases();
  const costosInsumo = useIngredientCosts();
  const [abiertas, setAbiertas] = useState<ReadonlySet<string>>(new Set());
  const versiones = [...new Set((costos.data ?? []).filter((c) => lista.includes(c.period)).map((c) => c.formula_version_id))].sort();
  const composicion = useComposition(abiertas.size > 0 ? versiones : []);
  const alternar = (id: string) => setAbiertas((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const todos = [...(tipos.data ?? [])].sort((a, b) => a.nombre.localeCompare(b.nombre));
  const color = (id: string) => todos.findIndex((t) => t.id === id);
  const fab = fabs.data ?? [];
  const kgEntre = (d: string, h: string, tipo?: string) => fab.filter((r) => r.current.manufacturing_date >= d && r.current.manufacturing_date <= h && (!tipo || r.current.feed_type_id === tipo))
    .reduce((s, r) => s + r.current.quantity_kg, 0);
  const visibles = todos.filter((t) => t.activo || fab.some((r) => r.current.feed_type_id === t.id));
  const p = periodoComparable(hoy);
  const kgHoy = kgEntre(p.desde, p.hasta); const kgAnt = kgEntre(p.desdeAnt, p.hastaAnt);
  const costo = (id: string, m: string) => (costos.data ?? []).find((c) => c.feed_type_id === id && c.period === m);
  const mesActual = mesDe(hoy);
  const pendientes = (compras.data ?? []).filter((c) => c.quantity_kg !== null && c.freight_status === 'PENDIENTE');
  const sinKg = (compras.data ?? []).filter((c) => c.quantity_kg === null);
  const cab = <><th className={thL}>Tipo</th>{lista.map((m) => <th key={m} className={thR}>{etiquetaMes(m)}</th>)}</>;
  const serie = (valor: (tipo: string, m: string) => number | null) => visibles.map((t) => ({ id: t.id, nombre: t.nombre, colorIndex: color(t.id), valores: lista.map((m) => valor(t.id, m)) }));
  const kgMes = (tipo: string, m: string) => kgEntre(m, `${m.slice(0, 7)}-31`, tipo);
  const consumoMes = (tipo: string, m: string) => (meses_.data ?? []).find((f) => f.feed_type_id === tipo && f.period === m)?.internal_consumption_kg ?? null;
  const costoConsumo = (tipo: string, m: string) => (consumo.data ?? []).find((c) => c.feed_type_id === tipo && c.period === m)?.consumption_cost ?? null;
  const total = (f: (tipo: string, m: string) => number | null, m: string) => {
    const vs = visibles.map((t) => f(t.id, m));
    return vs.every((v) => v === null) ? null : vs.reduce<number>((s, v) => s + (v ?? 0), 0);
  };
  const activas = visibles.filter((t) => t.activo);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tarjeta titulo={`Kg fabricados ${fechaCorta(p.desde)}–${fechaCorta(p.hasta)}`} valor={kgTxt(kgHoy)}
          pie={<>vs {kgTxt(kgAnt)} del {fechaCorta(p.desdeAnt)} al {fechaCorta(p.hastaAnt)} <Variacion actual={kgHoy} anterior={kgAnt} /></>}
          detalle={<><p className="font-semibold text-[#2C2419]">Por receta activa</p>{activas.map((t) => {
            const a = kgEntre(p.desde, p.hasta, t.id); const b = kgEntre(p.desdeAnt, p.hastaAnt, t.id);
            return <p key={t.id} className="flex justify-between gap-2"><span>{t.nombre}</span><span>{kgTxt(a)} <span className="text-gray-500">vs {kgTxt(b)}</span> <Variacion actual={a} anterior={b} /></span></p>;
          })}</>} />
        <Tarjeta titulo={`Costo por kg · ${etiquetaMes(mesActual)}`}
          valor={(() => { const cs = activas.map((t) => costo(t.id, mesActual)?.cost_per_kg).filter((v): v is number => v != null); return cs.length ? pesos(cs.reduce((s, v) => s + v, 0) / cs.length) : '—'; })()}
          pie={<>Promedio simple de las recetas activas con costo, compras de {etiquetaMes(mesActual)} vs {etiquetaMes(p.mesAnt)}</>}
          detalle={<>{activas.map((t) => {
            const a = costo(t.id, mesActual); const b = costo(t.id, p.mesAnt);
            return <p key={t.id} className="flex justify-between gap-2"><span>{t.nombre}</span><span>{pesos(a?.cost_per_kg ?? null)}{a?.estimated ? '*' : ''} <span className="text-gray-500">vs {pesos(b?.cost_per_kg ?? null)}</span>
              {a?.cost_per_kg != null && b?.cost_per_kg != null && <> <Variacion actual={a.cost_per_kg} anterior={b.cost_per_kg} subeEsMalo /></>}</span></p>;
          })}{activas.some((t) => (costo(t.id, mesActual)?.missing_ingredients.length ?? 0) > 0) && <p className="text-red-700">Hay recetas sin costo: faltan precios de insumos.</p>}</>} />
        <Tarjeta titulo="Compras por completar" valor={`${pendientes.length + sinKg.length}`}
          pie={sinKg.length + pendientes.length === 0 ? 'Todas tienen kilos y flete: el costo es definitivo.' : `${sinKg.length} sin kilos · ${pendientes.length} con flete pendiente (costo estimado).`} />
      </div>

      <section>
        <Titulo info={METODO}>Costo estimado por kg de cada receta</Titulo>
        <Evolucion meses={lista} formato={fmtPesos} dominio={[300, 600]} series={serie((t, m) => costo(t, m)?.cost_per_kg ?? null)} />
        <Tabla cabecera={cab}>
          {visibles.map((t) => {
            const abierta = abiertas.has(t.id);
            return [
              <tr key={t.id}>
                <td className={td}>
                  <button type="button" onClick={() => alternar(t.id)} aria-expanded={abierta} className="inline-flex items-center gap-1 text-left hover:text-[#A8552E]"
                    title={abierta ? 'Cerrar la apertura por insumo' : 'Ver el precio de cada insumo y el total del batch'}>
                    {abierta ? <ChevronDown className="w-4 h-4 shrink-0" aria-hidden /> : <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />}{t.nombre}
                  </button>
                </td>
                {lista.map((m) => { const c = costo(t.id, m); return (
                  <td key={m} className={tdR}>{pesos(c?.cost_per_kg ?? null)}{c?.estimated && c.cost_per_kg != null ? '*' : ''}
                    {c && c.cost_per_kg === null && c.missing_ingredients.length > 0 && <span className="block text-[11px] text-red-700">sin precio: {c.missing_ingredients.join(', ')}</span>}</td>); })}
              </tr>,
              abierta && (composicion.isLoading || costosInsumo.isLoading
                ? <tr key={`${t.id}-d`}><td className={`${td} pl-8 text-gray-500`} colSpan={lista.length + 1}>Cargando insumos…</td></tr>
                : <DesgloseReceta key={`${t.id}-d`} meses={lista} costosMes={(m) => costo(t.id, m)} lineas={composicion.data ?? []} costosInsumo={costosInsumo.data ?? []} />),
            ];
          })}
        </Tabla>
      </section>
      {([['Kilos producidos', kgMes, fmtKg, kgTxt], ['Kilos consumidos', consumoMes, fmtKg, kgTxt], ['Costo del alimento consumido (estado de resultados)', costoConsumo, fmtPesos, pesos]] as const).map(([titulo, f, fmt, txt]) => (
        <section key={titulo}>
          <Titulo info={titulo === 'Kilos producidos' ? undefined : METODO}>{titulo}{titulo === 'Costo del alimento consumido (estado de resultados)' ? '' : ' por tipo de alimento'}</Titulo>
          <Evolucion meses={lista} formato={fmt} series={serie(f)} />
          <Tabla cabecera={cab}>
            {visibles.map((t) => <tr key={t.id}><td className={td}>{t.nombre}</td>{lista.map((m) => <td key={m} className={tdR}>{txt(f(t.id, m))}</td>)}</tr>)}
            <tr className="font-semibold bg-amber-50"><td className={td}>Total</td>{lista.map((m) => <td key={m} className={tdR}>{txt(total(f, m))}</td>)}</tr>
          </Tabla>
        </section>
      ))}
    </div>
  );
}
