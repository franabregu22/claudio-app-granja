import { Fragment, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { construirFlujo, getCashFlow, inicioPeriodo, moverPeriodo, periodos, type Fila, type Grano } from '../../target/cashFlow';
import { errorMessage } from '../../target/messages';

/** Columns shown per view; the last one is the current period (no future period is shown). */
const VENTANA: Record<Grano, number> = { MES: 6, SEMANA: 8 };
const pesos = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const importe = (v: number) => (v === 0 ? '—' : pesos.format(v));
const hoyLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Caja → Flujo de caja (0122, caja-mejoras-v2; design approved on the prototype): read only, from fin_cash_flow. Periods in columns (months, or Monday–Sunday weeks) up to the current one, concepts in rows: opening balance, collected
 * income, paid outflows by category (each opens into its subcategories), other movements (opening balances, corrections, partner
 * withdrawals) apart, net flow and the cash at the end of each period — the same source as the balance cards.
 */
export function FlujoCaja() {
  const hoy = hoyLocal();
  const [grano, setGrano] = useState<Grano>('MES');
  const inicial = (g: Grano) => moverPeriodo(g, inicioPeriodo(g, hoy), -(VENTANA[g] - 1));
  const [primero, setPrimero] = useState(() => inicial('MES'));
  const [abiertas, setAbiertas] = useState<Set<string>>(() => new Set(['egresos']));
  const n = VENTANA[grano];
  const minimo = moverPeriodo(grano, inicial(grano), grano === 'MES' ? -24 : -104);   // up to two years back
  const maximo = inicial(grano);
  const cols = periodos(grano, primero, n, hoy);
  const datos = useQuery({
    queryKey: ['treasury', 'cash-flow', grano, cols[0].inicio, cols[n - 1].fin],
    queryFn: () => getCashFlow(supabase, cols[0].inicio, cols[n - 1].fin, grano),
  });
  const flujo = construirFlujo(cols, datos.data ?? { opening: 0, net: [], rows: [] });

  const cambiarGrano = (g: Grano) => { setGrano(g); setPrimero(inicial(g)); };
  const alternar = (id: string) => setAbiertas((s) => new Set(s.has(id) ? [...s].filter((x) => x !== id) : [...s, id]));

  const renglon = (f: Fila, nivel: number): React.ReactNode => {
    const abierta = abiertas.has(f.id);
    const fuerte = f.tipo === 'saldo' || f.tipo === 'neto' || (f.tipo === 'total' && nivel === 0);
    const borde = f.tipo === 'saldo' || f.tipo === 'neto' ? 'border-t border-[#E4DCC8]' : '';
    const color = 'text-[#2C2419]';
    return (
      <Fragment key={f.id}>
        <tr className={`${borde} ${f.tipo === 'saldo' ? 'bg-[#FAF6EE]' : ''}`}>
          <th scope="row" className={`sticky left-0 z-10 text-left font-normal py-1.5 pr-3 whitespace-nowrap ${f.tipo === 'saldo' ? 'bg-[#FAF6EE]' : 'bg-white'} ${color} ${fuerte ? 'font-semibold' : ''}`}
            style={{ paddingLeft: `${0.5 + nivel * 1}rem` }}>
            {f.hijos.length > 0 ? (
              <button type="button" onClick={() => alternar(f.id)} aria-expanded={abierta} className="inline-flex items-center gap-1 hover:underline">
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${abierta ? '' : '-rotate-90'}`} />{f.etiqueta}
              </button>
            ) : <span className={nivel > 0 ? 'pl-[1.125rem]' : ''}>{f.etiqueta}</span>}
          </th>
          {f.valores.map((v, i) => {
            const negativo = (f.tipo === 'saldo' || f.tipo === 'neto') && v < 0;
            return (
              <td key={flujo.periodos[i].inicio} className={`text-right tabular-nums py-1.5 px-2 whitespace-nowrap ${negativo ? 'text-red-700' : color} ${fuerte ? 'font-semibold' : ''} ${nivel > 0 ? 'text-[#6B5D45]' : ''}`}>
                {importe(v)}
              </td>
            );
          })}
        </tr>
        {abierta && f.hijos.map((h) => renglon(h, nivel + 1))}
      </Fragment>
    );
  };

  return (
    <section aria-label="Flujo de caja" className="bg-white rounded-lg border border-[#E4DCC8] p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-[#2C2419]">Flujo de caja</h2>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <div className="inline-flex rounded-lg border border-[#E4DCC8] overflow-hidden" role="group" aria-label="Período">
            {(['MES', 'SEMANA'] as Grano[]).map((g) => (
              <button key={g} type="button" onClick={() => cambiarGrano(g)} aria-pressed={grano === g}
                className={`px-3 py-1 ${grano === g ? 'bg-[#A8552E] text-white' : 'bg-white text-[#6B5D45] hover:bg-stone-50'}`}>
                {g === 'MES' ? 'Mensual' : 'Semanal'}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setPrimero(moverPeriodo(grano, primero, -1))} disabled={primero <= minimo}
            aria-label="Período anterior" className="p-1 rounded hover:bg-stone-100 disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
          <button type="button" onClick={() => setPrimero(inicial(grano))} className="px-2 py-1 rounded text-[#A8552E] hover:bg-stone-100">Hoy</button>
          <button type="button" onClick={() => setPrimero(moverPeriodo(grano, primero, 1))} disabled={primero >= maximo}
            aria-label="Período siguiente" className="p-1 rounded hover:bg-stone-100 disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>
      {datos.error ? <p className="text-sm text-red-700">{errorMessage(datos.error)}</p> : datos.isLoading ? <p className="text-sm text-gray-500">Cargando flujo de caja...</p> : (
      <div className="overflow-x-auto -mx-3 sm:mx-0">
        <table className="w-full text-xs sm:text-sm border-collapse">
          <thead>
            <tr className="border-b border-[#E4DCC8]">
              <th className="sticky left-0 z-10 bg-white" />
              {flujo.periodos.map((p) => (
                <th key={p.inicio} scope="col" className="text-right font-medium px-2 py-1.5 whitespace-nowrap text-[#6B5D45]">
                  <span className="block">{p.etiqueta}</span>
                  <span className="block text-[10px] font-normal not-italic text-[#8A7A5C]">{p.estado === 'ACTUAL' ? 'en curso' : 'cerrado'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{flujo.filas.map((f) => renglon(f, 0))}</tbody>
        </table>
      </div>
      )}
      <p className="text-xs text-[#8A7A5C]">
        Dinero cobrado y pagado, sin transferencias entre cuentas propias. Saldo final: caja al cierre de cada período (el período en curso, hasta hoy).
      </p>
    </section>
  );
}
