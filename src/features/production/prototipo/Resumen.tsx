import type { ReactNode } from 'react';
import {
  costoActualMezcla, costoReceta, etiquetaMes, fechaCorta, finDeMes, HOY, kgEntre, kgTxt, MESES, mesDe, periodoComparable, pesos, produccionMes,
  tablaStock, variacion, versionVigente, type Estado,
} from './datos';
import { Evolucion } from './Evolucion';
import { Tabla, Titulo, td, tdR, thL, thR } from './ui';

const fmtPesos = (n: number) => `$ ${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
const fmtKg = (n: number) => `${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })} kg`;

/** Variación vs el período anterior. subeEsMalo (costo): suba en rojo, baja en verde; sin él (kilos) es neutro. */
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
      {detalle && (
        <div className="hidden group-hover:block group-focus:block absolute left-0 right-0 top-full z-10 mt-1 bg-white border border-[#E4DCC8] rounded-lg shadow p-3 text-xs space-y-1">{detalle}</div>
      )}
    </div>
  );
}

/** Indicadores: kg fabricados en el mes hasta hoy vs los mismos días del mes anterior, costo/kg del mes y fletes pendientes. */
function Tarjetas({ e }: { e: Estado }) {
  const p = periodoComparable(HOY);
  const activas = e.recetas.filter((r) => r.activa);
  const kgHoy = kgEntre(e.fabricaciones, p.desde, p.hasta);
  const kgAnt = kgEntre(e.fabricaciones, p.desdeAnt, p.hastaAnt);
  const cierreAnt = finDeMes(p.mesAnt);
  const costo = costoActualMezcla(e, HOY);
  const costoAnt = costoActualMezcla(e, cierreAnt);
  const pendientes = e.compras.filter((c) => c.flete === null);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Tarjeta titulo={`Kg fabricados ${fechaCorta(p.desde)}–${fechaCorta(p.hasta)}`} valor={kgTxt(kgHoy)}
        pie={<>vs {kgTxt(kgAnt)} del {fechaCorta(p.desdeAnt)} al {fechaCorta(p.hastaAnt)} <Variacion actual={kgHoy} anterior={kgAnt} /></>}
        detalle={<>
          <p className="font-semibold text-[#2C2419]">Por receta activa</p>
          {activas.map((r) => {
            const a = kgEntre(e.fabricaciones, p.desde, p.hasta, r.id); const b = kgEntre(e.fabricaciones, p.desdeAnt, p.hastaAnt, r.id);
            return <p key={r.id} className="flex justify-between gap-2"><span>{r.nombre}</span><span>{kgTxt(a)} <span className="text-gray-500">vs {kgTxt(b)}</span> <Variacion actual={a} anterior={b} /></span></p>;
          })}
        </>} />
      <Tarjeta titulo={`Costo por kg hoy (${fechaCorta(HOY)})`} valor={<>{pesos(costo.costo)}{costo.estimado ? '*' : ''}</>}
        pie={<>vs {pesos(costoAnt.costo)}{costoAnt.estimado ? '*' : ''} con el último precio de {etiquetaMes(p.mesAnt)} (al {fechaCorta(cierreAnt)}) {costo.costo !== null && costoAnt.costo !== null && <Variacion actual={costo.costo} anterior={costoAnt.costo} subeEsMalo />}</>}
        detalle={<>
          <p>Último precio de compra de cada insumo (flete incluido), hoy vs al {fechaCorta(cierreAnt)}. Mismas recetas (versión vigente hoy) y misma mezcla (kg fabricados en {etiquetaMes(mesDe(HOY))}): la diferencia es solo de precios.</p>
          {costo.porReceta.map((x, i) => {
            const ant = costoAnt.porReceta[i];
            return <p key={x.receta.id} className="flex justify-between gap-2"><span>{x.receta.nombre}</span><span>{pesos(x.costo)}{x.estimado ? '*' : ''} <span className="text-gray-500">vs {pesos(ant.costo)}</span> {x.costo !== null && ant.costo !== null && <Variacion actual={x.costo} anterior={ant.costo} subeEsMalo />}</span></p>;
          })}
          {(costo.estimado || costoAnt.estimado) && <p className="text-gray-500">* estimado: el último precio tiene el flete pendiente.</p>}
        </>} />
      <Tarjeta titulo="Fletes pendientes" valor={`${pendientes.length} compra${pendientes.length === 1 ? '' : 's'}`}
        pie={pendientes.length === 0 ? 'El costo del mes es definitivo.' : `${kgTxt(pendientes.reduce((t, c) => t + c.kg, 0))} sin flete: el costo es estimado hasta cargarlos.`} />
    </div>
  );
}

const METODO = (
  <>
    <p><b>Costo por kg de cada receta:</b> suma de (kg de cada insumo en la tanda × su costo por kg del mes) ÷ kg de la tanda, con la versión vigente al cierre del mes.</p>
    <p><b>Costo por kg de un insumo:</b> promedio ponderado por kg de las compras del mes, flete incluido. Si no hubo compras, el último costo conocido.</p>
    <p><b>Consumo:</b> stock inicial + producción − stock final del cierre mensual. Sin cierre, el consumo del mes no se calcula.</p>
    <p><b>Costo del consumo:</b> kg consumidos × costo por kg del mes. Es el importe que luego irá al estado de resultados.</p>
    <p>* = estimado: hay compras con flete pendiente.</p>
  </>
);

export function Resumen({ e }: { e: Estado }) {
  const recetas = e.recetas.filter((r) => r.activa || MESES.some((m) => produccionMes(e.fabricaciones, r.id, m) > 0));
  const stock = Object.fromEntries(recetas.map((r) => [r.id, tablaStock(e, r.id)]));
  const costo = (rid: string, m: string) => costoReceta(e.compras, versionVigente(e.recetas.find((r) => r.id === rid)!, finDeMes(m)), m);
  const cab = <><th className={thL}>Tipo</th>{MESES.map((m) => <th key={m} className={thR}>{etiquetaMes(m)}</th>)}</>;
  const totalMes = (f: (rid: string) => number | null) => recetas.map((r) => f(r.id));

  return (
    <div className="space-y-6">
      <Tarjetas e={e} />
      <section>
        <Titulo info={METODO}>Costo estimado por kg de cada receta</Titulo>
        <Evolucion formato={fmtPesos} dominio={[300, 600]} series={recetas.map((r) => ({ id: r.id, nombre: r.nombre, valores: MESES.map((m) => costo(r.id, m).costo) }))} />
        <Tabla cabecera={cab}>
          {recetas.map((r) => (
            <tr key={r.id}><td className={td}>{r.nombre}</td>
              {MESES.map((m) => { const c = costo(r.id, m); return <td key={m} className={tdR}>{pesos(c.costo)}{c.estimado && c.costo !== null ? '*' : ''}</td>; })}
            </tr>
          ))}
        </Tabla>
      </section>

      {([['Kilos producidos', 'produccion'], ['Kilos consumidos', 'consumo']] as const).map(([titulo, campo]) => (
        <section key={campo}>
          <Titulo info={campo === 'consumo' ? METODO : undefined}>{titulo} por tipo de alimento</Titulo>
          <Evolucion formato={fmtKg} series={recetas.map((r) => ({ id: r.id, nombre: r.nombre, valores: stock[r.id].map((f) => f[campo]) }))} />
          <Tabla cabecera={cab}>
            {recetas.map((r) => (
              <tr key={r.id}><td className={td}>{r.nombre}</td>{stock[r.id].map((f) => <td key={f.mes} className={tdR}>{kgTxt(f[campo])}</td>)}</tr>
            ))}
            <tr className="font-semibold bg-amber-50"><td className={td}>Total</td>
              {MESES.map((m, i) => { const vs = recetas.map((r) => stock[r.id][i][campo]); return <td key={m} className={tdR}>{vs.some((v) => v === null) ? '—' : kgTxt(vs.reduce<number>((t, v) => t + (v ?? 0), 0))}</td>; })}
            </tr>
          </Tabla>
        </section>
      ))}

      <section>
        <Titulo info={METODO}>Costo del alimento consumido (para el estado de resultados)</Titulo>
        <Evolucion formato={fmtPesos} series={recetas.map((r) => ({ id: r.id, nombre: r.nombre,
          valores: stock[r.id].map((f) => { const c = costo(r.id, f.mes).costo; return f.consumo === null || c === null ? null : f.consumo * c; }) }))} />
        <Tabla cabecera={cab}>
          {recetas.map((r) => (
            <tr key={r.id}><td className={td}>{r.nombre}</td>
              {stock[r.id].map((f) => { const c = costo(r.id, f.mes).costo; return <td key={f.mes} className={tdR}>{f.consumo === null || c === null ? '—' : pesos(f.consumo * c)}</td>; })}
            </tr>
          ))}
          <tr className="font-semibold bg-amber-50"><td className={td}>Total</td>
            {MESES.map((m, i) => {
              const vs = totalMes((rid) => { const f = stock[rid][i]; const c = costo(rid, m).costo; return f.consumo === null || c === null ? null : f.consumo * c; });
              return <td key={m} className={tdR}>{vs.some((v) => v === null) ? '—' : pesos(vs.reduce<number>((t, v) => t + (v ?? 0), 0))}</td>;
            })}
          </tr>
        </Tabla>
      </section>

    </div>
  );
}
