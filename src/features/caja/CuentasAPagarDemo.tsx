import { useState } from 'react';
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { campo, etiqueta, Modal } from './Modal';
import {
  abiertoReplanificable, agregarGasto, CATEGORIAS, CUENTAS, ddmm, editarGasto, editarVto, enTarjeta, esCheque, etiquetaVto, GRUPOS, grupo,
  marcarDebitado, MEDIO_LABEL, pagarConCheque, pagarVto, pendiente, pesos, repartirCuotas, replanificar, resumenProveedor, totales,
  validarGasto, validarPlan, type Autor, type DemoPagar, type Frecuencia, type Gasto, type Medio, type Tarjeta, type Vto, type VtoNuevo,
} from './pagarDemo';

export interface DemoProps { s: DemoPagar; setS: (s: DemoPagar) => void; autor: () => Autor; hoy: string }
const btn = 'text-sm px-3 py-1.5 rounded-lg';
export const btnPrimario = `${btn} bg-amber-600 text-white hover:bg-amber-700`;
export const btnSecundario = `${btn} border border-[#E4DCC8] text-[#6B5D45] bg-white hover:bg-stone-50`;
export const AVISO_DEMO = <p className="text-xs text-amber-700">Vista de demostración · Datos ficticios · Nada se guarda</p>;
const ErrorForm = ({ e }: { e: string | null }) => (e ? <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{e}</p> : null);
const intentar = (f: () => void, setError: (e: string) => void) => { try { f(); } catch (x) { setError(x instanceof Error ? x.message : String(x)); } };

const TARJETAS: { id: Tarjeta; label: string }[] = [
  { id: 'TOTAL', label: 'Total a pagar' }, { id: 'VENCIDO', label: 'Vencido' }, { id: 'PROX7', label: 'Próximos 7 días' },
  { id: 'PROX30', label: 'Próximos 30 días' }, { id: 'SIN_FECHA', label: 'Sin fecha' },
];

/**
 * Caja → Cuentas a pagar (caja-mejoras-v2): FRONTEND PROTOTYPE over fictitious data kept in memory by CajaApp — no query, no write,
 * nothing reaches Supabase; reloading restores the seed. One list of every open due item: cards that filter, supplier / type filters,
 * each row opens its expense (data, items, history) with pay, change payment plan and pencil edits (Rectificado + history).
 */
export function PendientesDemo({ s, setS, autor, hoy }: DemoProps) {
  const [tarjeta, setTarjeta] = useState<Tarjeta>('TOTAL');
  const [prov, setProv] = useState('TODOS');
  const [tipo, setTipo] = useState('TODOS');
  const [abierto, setAbierto] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [pagando, setPagando] = useState<Vto | null>(null);
  const [replan, setReplan] = useState<Gasto | null>(null);
  const [editGasto, setEditGasto] = useState<Gasto | null>(null);
  const [editVto, setEditVto] = useState<Vto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const gastoDe = (v: Vto) => s.gastos.find((g) => g.id === v.gastoId)!;
  const nombreProv = (id: string | null) => (id ? s.proveedores.find((p) => p.id === id)?.nombre ?? '—' : null);
  const hecho = (nuevoS: DemoPagar, texto: string) => { setS(nuevoS); setAviso(texto); };

  const abiertos = s.vtos.filter((v) => pendiente(v) > 0).filter((v) => {
    const g = gastoDe(v);
    if (prov !== 'TODOS' && (g.proveedorId ?? '') !== prov) return false;
    if (tipo === 'CUOTA' && v.tipo !== 'CUOTA') return false;
    if (tipo === 'CHEQUE' && !esCheque(v)) return false;
    if (tipo === 'PAGO' && v.tipo !== 'PAGO') return false;
    return true;
  });
  const t = totales(abiertos, hoy);
  const lista = abiertos.filter((v) => enTarjeta(v, tarjeta, hoy)).sort((a, b) => (a.fecha ?? '9999').localeCompare(b.fecha ?? '9999'));
  const filtroActivo = prov !== 'TODOS' || tipo !== 'TODOS' || tarjeta !== 'TOTAL';
  const rp = prov !== 'TODOS' && prov !== '' ? resumenProveedor(s, prov, hoy) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {AVISO_DEMO}
        <button type="button" onClick={() => setNuevo(true)} className={`${btnPrimario} inline-flex items-center gap-1`}><Plus className="w-4 h-4" />Nuevo gasto (demo)</button>
      </div>
      {aviso && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-2 text-sm text-green-900 flex gap-2" role="status">
          <span>{aviso}</span><button type="button" className="ml-auto text-xs hover:underline" onClick={() => setAviso(null)}>Cerrar</button>
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" role="group" aria-label="Totales (tocá una tarjeta para filtrar)">
        {TARJETAS.map((x) => {
          const activa = tarjeta === x.id;
          const rojo = x.id === 'VENCIDO' && t.VENCIDO > 0;
          return (
            <button key={x.id} type="button" onClick={() => setTarjeta(activa && x.id !== 'TOTAL' ? 'TOTAL' : x.id)} aria-pressed={activa}
              className={`text-left rounded-lg border px-3 py-2 ${activa ? 'border-[#A8552E] ring-1 ring-[#A8552E] bg-amber-50' : 'bg-white border-[#E4DCC8] hover:border-[#A8552E]'}`}>
              <p className={`text-xs ${rojo ? 'text-red-700' : 'text-[#8A7A5C]'}`}>{x.label}</p>
              <p className={`font-bold ${rojo ? 'text-red-700' : 'text-[#2C2419]'}`}>{pesos(t[x.id])}</p>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={prov} onChange={(e) => setProv(e.target.value)} className="border border-[#E4DCC8] rounded-lg px-2 py-1 bg-white" aria-label="Proveedor">
          <option value="TODOS">Todos los proveedores</option>
          {s.proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          <option value="">Sin proveedor</option>
        </select>
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} className="border border-[#E4DCC8] rounded-lg px-2 py-1 bg-white" aria-label="Tipo">
          <option value="TODOS">Todos los tipos</option><option value="PAGO">Pago único</option><option value="CUOTA">Cuotas</option><option value="CHEQUE">Cheques y eCheqs</option>
        </select>
        {filtroActivo && <button type="button" onClick={() => { setProv('TODOS'); setTipo('TODOS'); setTarjeta('TOTAL'); }} className="text-[#A8552E] hover:underline">Limpiar filtros</button>}
      </div>
      {rp && (
        <p className="text-sm text-[#6B5D45] bg-white border border-[#E4DCC8] rounded-lg px-3 py-2">
          <b>{nombreProv(prov)}</b>: deuda {pesos(rp.deuda)}{rp.vencido > 0 && <span className="text-red-700"> (vencido {pesos(rp.vencido)})</span>}
          {' · '}cheques a debitar {pesos(rp.cheques)}{rp.aFavor > 0 && <span className="text-green-700"> · a favor {pesos(rp.aFavor)}</span>}
        </p>
      )}

      {lista.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay pagos pendientes{filtroActivo ? ' con estos filtros' : ''}.</p>}
      {GRUPOS.map((gr) => {
        const filas = lista.filter((v) => grupo(v.fecha, hoy) === gr.id);
        if (filas.length === 0) return null;
        const rojo = gr.id === 'VENCIDO';
        return (
          <section key={gr.id} aria-label={gr.label}>
            <div className="flex items-baseline justify-between mb-1">
              <h3 className={`text-xs font-semibold uppercase tracking-wide ${rojo ? 'text-red-700' : 'text-[#8A6A2E]'}`}>{gr.label} · {filas.length}</h3>
              <span className={`text-sm font-semibold ${rojo ? 'text-red-700' : 'text-[#2C2419]'}`}>{pesos(filas.reduce((x, v) => x + pendiente(v), 0))}</span>
            </div>
            <ul className="bg-white rounded-lg border border-[#E4DCC8] divide-y divide-[#F0EADC]">
              {filas.map((v) => {
                const g = gastoDe(v);
                const open = abierto === v.id;
                return (
                  <li key={v.id}>
                    <div className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <button type="button" onClick={() => setAbierto(open ? null : v.id)} aria-expanded={open} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                        <ChevronDown className={`w-4 h-4 shrink-0 text-[#8A7A5C] transition ${open ? '' : '-rotate-90'}`} />
                        <span className={`w-12 shrink-0 text-sm tabular-nums ${rojo ? 'text-red-700 font-semibold' : 'text-[#6B5D45]'}`}>{v.fecha ? ddmm(v.fecha) : '—'}</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-[#2C2419] truncate">
                            {nombreProv(g.proveedorId) ?? g.concepto}
                            {g.rectificado && <span className="ml-2 text-[10px] font-semibold uppercase text-amber-800 bg-amber-100 rounded px-1">Rectificado</span>}
                          </span>
                          <span className="block text-xs text-[#8A7A5C] truncate">
                            {nombreProv(g.proveedorId) ? `${g.concepto} · ` : 'Sin proveedor · '}{etiquetaVto(s, v)}{v.pagado > 0 ? ` · pagado ${pesos(v.pagado)} de ${pesos(v.importe)}` : ''}
                          </span>
                        </span>
                      </button>
                      <span className="font-semibold tabular-nums text-[#2C2419]">{pesos(pendiente(v))}</span>
                      {esCheque(v) ? <span className="text-xs text-sky-800 w-20 text-right">a debitar</span>
                        : <button type="button" onClick={() => setPagando(v)} className={btnPrimario}>Pagar</button>}
                    </div>
                    {open && <DetalleGasto s={s} g={g} hoy={hoy} nombreProv={nombreProv}
                      onEditar={() => setEditGasto(g)} onEditarVto={setEditVto} onReplan={() => setReplan(g)} onPagar={setPagando}
                      onDebitado={(x) => hecho(marcarDebitado(s, x.id, autor()), `${etiquetaVto(s, x)} marcado como debitado.`)} />}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {nuevo && <GastoModal s={s} hoy={hoy} onClose={() => setNuevo(false)}
        onGuardar={(g) => { hecho(agregarGasto(s, g, `n${s.gastos.length + 1}`, autor()), `Gasto «${g.concepto}» registrado${g.pagado ? ' y pagado' : ' como pendiente de pago'}.`); setNuevo(false); }} />}
      {pagando && <PagarModal s={s} v={pagando} hoy={hoy} onClose={() => setPagando(null)}
        onPagar={(f) => { hecho(f(autor()), 'Pago registrado.'); setPagando(null); }} />}
      {replan && <ReplanModal s={s} g={replan} hoy={hoy} onClose={() => setReplan(null)}
        onGuardar={(plan) => { hecho(replanificar(s, replan.id, plan, autor()), 'Forma de pago actualizada.'); setReplan(null); }} />}
      {editGasto && <EditarGastoModal s={s} g={editGasto} onClose={() => setEditGasto(null)}
        onGuardar={(datos, motivo) => { hecho(editarGasto(s, editGasto.id, datos, motivo, autor()), 'Gasto rectificado (queda en el historial).'); setEditGasto(null); }} />}
      {editVto && <EditarVtoModal s={s} v={editVto} onClose={() => setEditVto(null)}
        onGuardar={(n, motivo) => { hecho(editarVto(s, editVto.id, n, motivo, autor()), 'Vencimiento rectificado (queda en el historial).'); setEditVto(null); }} />}
    </div>
  );
}

// ── expense detail (everything the old Proveedores tab showed, per expense) ─
function DetalleGasto({ s, g, hoy, nombreProv, onEditar, onEditarVto, onReplan, onPagar, onDebitado }: {
  s: DemoPagar; g: Gasto; hoy: string; nombreProv: (id: string | null) => string | null;
  onEditar: () => void; onEditarVto: (v: Vto) => void; onReplan: () => void; onPagar: (v: Vto) => void; onDebitado: (v: Vto) => void;
}) {
  const vtos = s.vtos.filter((v) => v.gastoId === g.id);
  const pagado = vtos.reduce((t, v) => t + v.pagado, 0);
  const lapiz = (f: () => void, label: string) => (
    <button type="button" onClick={f} aria-label={label} title={label} className="p-1 rounded text-[#8A7A5C] hover:text-[#A8552E] hover:bg-amber-50"><Pencil className="w-3.5 h-3.5" /></button>
  );
  return (
    <div className="bg-[#FAF6EE] border-t border-[#F0EADC] px-3 sm:px-9 py-3 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs flex-1">
          <div><dt className="text-[#8A7A5C]">Concepto</dt><dd className="text-[#2C2419]">{g.concepto}</dd></div>
          <div><dt className="text-[#8A7A5C]">Proveedor</dt><dd className="text-[#2C2419]">{nombreProv(g.proveedorId) ?? 'Sin proveedor'}</dd></div>
          <div><dt className="text-[#8A7A5C]">Categoría</dt><dd className="text-[#2C2419]">{g.categoria}</dd></div>
          <div><dt className="text-[#8A7A5C]">Fecha del gasto</dt><dd className="text-[#2C2419]">{ddmm(g.fecha)}</dd></div>
          <div><dt className="text-[#8A7A5C]">Comprobante</dt><dd className="text-[#2C2419]">{g.comprobante ?? <span className="text-amber-700">Sin comprobante</span>}</dd></div>
          <div><dt className="text-[#8A7A5C]">Total · pagado · pendiente</dt><dd className="text-[#2C2419]">{pesos(g.total)} · {pesos(pagado)} · <b>{pesos(g.total - pagado)}</b></dd></div>
        </dl>
        {lapiz(onEditar, 'Editar datos del gasto')}
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">Vencimientos</p>
          {abiertoReplanificable(s, g.id) > 0 && <button type="button" onClick={onReplan} className="text-xs text-[#A8552E] hover:underline">Cambiar forma de pago (cuotas, cheques…)</button>}
        </div>
        <ul className="space-y-1">
          {vtos.map((v) => {
            const p = pendiente(v);
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-x-3 text-xs">
                <span className={`w-16 tabular-nums ${p > 0 && v.fecha && v.fecha < hoy ? 'text-red-700 font-semibold' : 'text-[#6B5D45]'}`}>{v.fecha ? ddmm(v.fecha) : 'sin fecha'}</span>
                <span className="flex-1 text-[#2C2419]">{etiquetaVto(s, v)}</span>
                <span className="tabular-nums">{pesos(v.importe)}</span>
                <span className={`w-28 text-right ${p <= 0 ? 'text-green-700' : esCheque(v) ? 'text-sky-800' : 'text-[#6B5D45]'}`}>
                  {p <= 0 ? (esCheque(v) ? 'Debitado' : 'Pagado') : esCheque(v) ? 'A debitar' : v.pagado > 0 ? `Resta ${pesos(p)}` : 'Pendiente'}
                </span>
                <span className="flex items-center gap-1 w-32 justify-end">
                  {p > 0 && !esCheque(v) && <button type="button" onClick={() => onPagar(v)} className="text-[#A8552E] hover:underline">Pagar</button>}
                  {p > 0 && esCheque(v) && <button type="button" onClick={() => onDebitado(v)} className="text-[#A8552E] hover:underline">Marcar debitado</button>}
                  {p > 0 && lapiz(() => onEditarVto(v), `Editar ${etiquetaVto(s, v)}`)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <details>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">Historial ({g.historial.length})</summary>
        <ul className="mt-1 space-y-1 text-xs">
          {[...g.historial].reverse().map((c, i) => (
            <li key={i} className="text-[#6B5D45]">
              <span className="tabular-nums text-[#8A7A5C]">{c.cuando}</span> · <span className="font-medium">{c.quien}</span> · {c.que}
              {c.antes !== undefined && <>: <s className="text-red-700">{c.antes}</s> → <span className="text-green-800">{c.despues}</span></>}
              {c.motivo && <span className="italic"> — «{c.motivo}»</span>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ── payment plan editor (shared: new expense and "Cambiar forma de pago") ───
type Forma = 'UNICO' | 'CUOTAS' | 'CHEQUES';
interface ChequeForm { tipo: 'CHEQUE' | 'ECHEQ'; numero: string; fecha: string; importe: string; cuenta: string }
export function usePlan(total: number, hoy: string) {
  const [forma, setForma] = useState<Forma>('UNICO');
  const [fechaUnica, setFechaUnica] = useState('');
  const [nCuotas, setNCuotas] = useState('3');
  const [primera, setPrimera] = useState(hoy);
  const [frecuencia, setFrecuencia] = useState<Frecuencia>('MENSUAL');
  const [cuotas, setCuotas] = useState<{ fecha: string; importe: string }[] | null>(null);
  const [cheques, setCheques] = useState<ChequeForm[]>([{ tipo: 'ECHEQ', numero: '', fecha: '', importe: '', cuenta: 'BNA' }]);
  const generadas = cuotas ?? (total > 0 && Number(nCuotas) >= 2 ? repartirCuotas(total, Number(nCuotas), primera, frecuencia).map((c) => ({ fecha: c.fecha, importe: String(c.importe) })) : []);
  const vtos: VtoNuevo[] = forma === 'UNICO' ? [{ tipo: 'PAGO', fecha: fechaUnica || null, importe: total }]
    : forma === 'CUOTAS' ? generadas.map((c) => ({ tipo: 'CUOTA' as const, fecha: c.fecha || null, importe: Number(c.importe) }))
      : cheques.map((c) => ({ tipo: c.tipo, fecha: c.fecha || null, importe: Number(c.importe), numero: c.numero, cuenta: c.cuenta }));
  const reset = () => setCuotas(null);
  const setCheque = (i: number, k: keyof ChequeForm, val: string) => setCheques(cheques.map((c, j) => (j === i ? { ...c, [k]: val } : c)));
  const suma = vtos.reduce((t, v) => t + (v.importe || 0), 0);

  const editor = (proveedorId: string | null) => (
    <fieldset className="space-y-2">
      <legend className={etiqueta}>¿Cómo lo vas a pagar?</legend>
      <div className="grid grid-cols-3 gap-1 text-sm">
        {([['UNICO', 'Un pago'], ['CUOTAS', 'En cuotas'], ['CHEQUES', 'Cheques']] as [Forma, string][]).map(([f, l]) => (
          <button key={f} type="button" onClick={() => setForma(f)} aria-pressed={forma === f}
            className={`py-1.5 rounded-lg border ${forma === f ? 'bg-amber-100 border-amber-400 text-amber-900 font-medium' : 'bg-white border-gray-300 text-gray-700'}`}>{l}</button>
        ))}
      </div>
      {forma === 'UNICO' && (
        <label className={etiqueta}>Fecha estimada de pago <span className="font-normal text-gray-500">(opcional)</span>
          <input type="date" value={fechaUnica} onChange={(e) => setFechaUnica(e.target.value)} className={campo} />
        </label>
      )}
      {forma === 'CUOTAS' && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <label className={etiqueta}>Cuotas<input type="number" min="2" max="36" value={nCuotas} onChange={(e) => { setNCuotas(e.target.value); reset(); }} className={campo} /></label>
            <label className={`${etiqueta} col-span-2`}>Primera cuota<input type="date" value={primera} onChange={(e) => { setPrimera(e.target.value); reset(); }} className={campo} /></label>
          </div>
          <select value={frecuencia} onChange={(e) => { setFrecuencia(e.target.value as Frecuencia); reset(); }} className={campo} aria-label="Frecuencia">
            <option value="MENSUAL">Mensual</option><option value="QUINCENAL">Cada 15 días</option><option value="SEMANAL">Semanal</option>
          </select>
          {generadas.length > 0 && (
            <ul className="space-y-1">
              {generadas.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-6 text-gray-500">{i + 1}.</span>
                  <input type="date" value={c.fecha} onChange={(e) => setCuotas(generadas.map((x, j) => (j === i ? { ...x, fecha: e.target.value } : x)))} className="border border-gray-300 rounded px-2 py-1 flex-1" aria-label={`Fecha cuota ${i + 1}`} />
                  <input type="number" step="0.01" value={c.importe} onChange={(e) => setCuotas(generadas.map((x, j) => (j === i ? { ...x, importe: e.target.value } : x)))} className="border border-gray-300 rounded px-2 py-1 w-32 text-right" aria-label={`Importe cuota ${i + 1}`} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {forma === 'CHEQUES' && (
        <div className="space-y-2">
          {!proveedorId && <p className="text-xs text-red-700">Para pagar con cheque o eCheq hay que elegir el proveedor.</p>}
          {cheques.map((c, i) => (
            <div key={i} className="grid grid-cols-6 gap-1 text-sm items-center">
              <select value={c.tipo} onChange={(e) => setCheque(i, 'tipo', e.target.value)} className="col-span-2 border border-gray-300 rounded px-1 py-1" aria-label="Tipo"><option value="ECHEQ">eCheq</option><option value="CHEQUE">Cheque</option></select>
              <input value={c.numero} onChange={(e) => setCheque(i, 'numero', e.target.value)} placeholder="Número" className="col-span-2 border border-gray-300 rounded px-2 py-1" />
              <select value={c.cuenta} onChange={(e) => setCheque(i, 'cuenta', e.target.value)} className="col-span-2 border border-gray-300 rounded px-1 py-1" aria-label="Cuenta"><option>BNA</option><option>Banco Provincia</option></select>
              <input type="date" value={c.fecha} onChange={(e) => setCheque(i, 'fecha', e.target.value)} className="col-span-3 border border-gray-300 rounded px-2 py-1" aria-label="Fecha de pago" />
              <input type="number" step="0.01" value={c.importe} onChange={(e) => setCheque(i, 'importe', e.target.value)} placeholder="Importe" className="col-span-2 border border-gray-300 rounded px-2 py-1 text-right" />
              <button type="button" onClick={() => setCheques(cheques.filter((_, j) => j !== i))} disabled={cheques.length === 1} className="text-gray-400 hover:text-red-600 disabled:opacity-30 justify-self-center" aria-label="Quitar cheque"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button type="button" onClick={() => setCheques([...cheques, { ...cheques[cheques.length - 1], numero: '', fecha: '', importe: '' }])} className="text-sm text-[#A8552E] hover:underline">+ Agregar otro cheque</button>
        </div>
      )}
      {forma !== 'UNICO' && total > 0 && <p className={`text-xs ${Math.abs(suma - total) < 0.005 ? 'text-green-700' : 'text-red-700'}`}>Suma {pesos(suma)} de {pesos(total)}</p>}
    </fieldset>
  );
  return { vtos, editor };
}

// ── modals ──────────────────────────────────────────────────────────────────
/** ONE expense form for all Caja: paid now (account and date) or pending (with its payment plan). */
export function GastoModal({ s, hoy, onClose, onGuardar }: { s: DemoPagar; hoy: string; onClose: () => void; onGuardar: (g: Parameters<typeof agregarGasto>[1]) => void }) {
  const [concepto, setConcepto] = useState('');
  const [proveedorId, setProveedorId] = useState('');
  const [categoria, setCategoria] = useState('');
  const [total, setTotal] = useState('');
  const [fecha, setFecha] = useState(hoy);
  const [comprobante, setComprobante] = useState('');
  const [estado, setEstado] = useState<'PENDIENTE' | 'PAGADO'>('PENDIENTE');
  const [medio, setMedio] = useState<Medio>('TRANSFER');
  const [cuenta, setCuenta] = useState(CUENTAS.TRANSFER[0]);
  const [fechaPago, setFechaPago] = useState(hoy);
  const tot = Number(total);
  const plan = usePlan(tot, hoy);
  const g = { concepto, proveedorId: proveedorId || null, categoria, fecha, total: tot, comprobante: comprobante.trim() || null,
    pagado: estado === 'PAGADO' ? { medio, cuenta, fecha: fechaPago } : null, vtos: estado === 'PENDIENTE' ? plan.vtos : [] };
  const error = concepto && total ? validarGasto(g) : null;
  return (
    <Modal titulo="Nuevo gasto (demo)" onClose={onClose} onSubmit={() => onGuardar(g)} puedeGuardar={validarGasto(g) === null} guardando={false} textoGuardar="Registrar gasto">
      {AVISO_DEMO}
      <label className={etiqueta}>Concepto del gasto<input value={concepto} onChange={(e) => setConcepto(e.target.value)} className={campo} placeholder="Ej.: Maíz 20 tn" /></label>
      <label className={etiqueta}>Proveedor <span className="font-normal text-gray-500">(opcional)</span>
        <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={campo}>
          <option value="">Sin proveedor</option>
          {s.proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Importe total<input type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Fecha del gasto<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      </div>
      <label className={etiqueta}>Categoría
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className={campo}>
          <option value="">Elegí la categoría</option>{CATEGORIAS.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-1 text-sm" role="group" aria-label="Estado del pago">
        {([['PAGADO', 'Ya está pagado'], ['PENDIENTE', 'Pendiente de pago']] as const).map(([e, l]) => (
          <button key={e} type="button" onClick={() => setEstado(e)} aria-pressed={estado === e}
            className={`py-1.5 rounded-lg border ${estado === e ? 'bg-amber-100 border-amber-400 text-amber-900 font-medium' : 'bg-white border-gray-300 text-gray-700'}`}>{l}</button>
        ))}
      </div>
      {estado === 'PAGADO' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className={etiqueta}>Forma de pago
            <select value={medio} onChange={(e) => { const m = e.target.value as Medio; setMedio(m); setCuenta(CUENTAS[m][0]); }} className={campo}>
              {(Object.keys(MEDIO_LABEL) as Medio[]).map((m) => <option key={m} value={m}>{MEDIO_LABEL[m]}</option>)}
            </select>
          </label>
          <label className={etiqueta}>Cuenta
            <select value={cuenta} onChange={(e) => setCuenta(e.target.value)} className={campo}>{CUENTAS[medio].map((c) => <option key={c}>{c}</option>)}</select>
          </label>
          <label className={`${etiqueta} col-span-2`}>Fecha de pago<input type="date" value={fechaPago} onChange={(e) => setFechaPago(e.target.value)} className={campo} /></label>
        </div>
      ) : plan.editor(proveedorId || null)}
      <label className={etiqueta}>Comprobante <span className="font-normal text-gray-500">(opcional; se puede agregar después con el lápiz)</span>
        <input value={comprobante} onChange={(e) => setComprobante(e.target.value)} className={campo} placeholder="Ej.: Factura A 0001-00001234" />
      </label>
      <ErrorForm e={error} />
    </Modal>
  );
}

/** Pays ONE item: from an account (Transferencia / Efectivo / Mercado Pago) or by issuing an own cheque / eCheq (supplier required). */
function PagarModal({ s, v, hoy, onClose, onPagar }: { s: DemoPagar; v: Vto; hoy: string; onClose: () => void; onPagar: (f: (a: Autor) => DemoPagar) => void }) {
  const g = s.gastos.find((x) => x.id === v.gastoId)!;
  const [monto, setMonto] = useState(String(pendiente(v)));
  const [medio, setMedio] = useState<Medio | 'CHEQUE'>('TRANSFER');
  const [cuenta, setCuenta] = useState(CUENTAS.TRANSFER[0]);
  const [ch, setCh] = useState({ tipo: 'ECHEQ' as 'CHEQUE' | 'ECHEQ', numero: '', cuenta: 'BNA', fecha: hoy });
  const [error, setError] = useState<string | null>(null);
  const n = Number(monto);
  const valido = n > 0 && n <= pendiente(v) + 0.005 && (medio !== 'CHEQUE' || (!!g.proveedorId && ch.numero.trim() !== '' && ch.fecha !== ''));
  const guardar = () => intentar(() => onPagar((a) => (medio === 'CHEQUE' ? pagarConCheque(s, v.id, { ...ch, importe: n }, a) : pagarVto(s, v.id, n, medio, cuenta, a))), setError);
  return (
    <Modal titulo={`Pagar · ${etiquetaVto(s, v)}`} onClose={onClose} onSubmit={guardar} puedeGuardar={valido} guardando={false} textoGuardar={medio === 'CHEQUE' ? 'Emitir y registrar' : 'Registrar pago'}>
      {AVISO_DEMO}
      <p className="text-sm text-[#6B5D45]">{g.concepto} · pendiente {pesos(pendiente(v))}</p>
      <label className={etiqueta}>Importe<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
      {n > 0 && n < pendiente(v) && <p className="text-xs text-[#8A7A5C]">Pago parcial: en este vencimiento quedan {pesos(pendiente(v) - n)}.</p>}
      {n > pendiente(v) + 0.005 && <p className="text-xs text-red-700">No puede superar lo pendiente de este vencimiento.</p>}
      <label className={etiqueta}>Forma de pago
        <select value={medio} onChange={(e) => { const m = e.target.value as Medio | 'CHEQUE'; setMedio(m); if (m !== 'CHEQUE') setCuenta(CUENTAS[m][0]); }} className={campo}>
          {(Object.keys(MEDIO_LABEL) as Medio[]).map((m) => <option key={m} value={m}>{MEDIO_LABEL[m]}</option>)}
          <option value="CHEQUE">Emitir cheque / eCheq</option>
        </select>
      </label>
      {medio !== 'CHEQUE' && (
        <label className={etiqueta}>Cuenta<select value={cuenta} onChange={(e) => setCuenta(e.target.value)} className={campo}>{CUENTAS[medio].map((c) => <option key={c}>{c}</option>)}</select></label>
      )}
      {medio === 'CHEQUE' && (g.proveedorId ? (
        <div className="grid grid-cols-2 gap-2">
          <label className={etiqueta}>Tipo<select value={ch.tipo} onChange={(e) => setCh({ ...ch, tipo: e.target.value as 'CHEQUE' | 'ECHEQ' })} className={campo}><option value="ECHEQ">eCheq</option><option value="CHEQUE">Cheque</option></select></label>
          <label className={etiqueta}>Número<input value={ch.numero} onChange={(e) => setCh({ ...ch, numero: e.target.value })} className={campo} /></label>
          <label className={etiqueta}>Cuenta<select value={ch.cuenta} onChange={(e) => setCh({ ...ch, cuenta: e.target.value })} className={campo}><option>BNA</option><option>Banco Provincia</option></select></label>
          <label className={etiqueta}>Fecha de pago<input type="date" value={ch.fecha} onChange={(e) => setCh({ ...ch, fecha: e.target.value })} className={campo} /></label>
        </div>
      ) : <p className="text-sm text-red-700">Este gasto no tiene proveedor: para pagarlo con cheque, primero asignale el proveedor con el lápiz.</p>)}
      <ErrorForm e={error} />
    </Modal>
  );
}

function ReplanModal({ s, g, hoy, onClose, onGuardar }: { s: DemoPagar; g: Gasto; hoy: string; onClose: () => void; onGuardar: (plan: VtoNuevo[]) => void }) {
  const abierto = abiertoReplanificable(s, g.id);
  const plan = usePlan(abierto, hoy);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal titulo="Cambiar forma de pago" onClose={onClose} onSubmit={() => intentar(() => onGuardar(plan.vtos), setError)}
      puedeGuardar={validarPlan(abierto, plan.vtos, g.proveedorId) === null} guardando={false}>
      {AVISO_DEMO}
      <p className="text-sm text-[#6B5D45]">{g.concepto}: se reorganizan los {pesos(abierto)} que quedan por pagar. Lo ya pagado y los cheques emitidos no cambian.</p>
      {plan.editor(g.proveedorId)}
      <ErrorForm e={error ?? validarPlan(abierto, plan.vtos, g.proveedorId)} />
    </Modal>
  );
}

const Motivo = ({ v, set }: { v: string; set: (x: string) => void }) => (
  <label className={etiqueta}>Motivo del cambio<input value={v} onChange={(e) => set(e.target.value)} className={campo} placeholder="Ej.: el proveedor corrigió la factura" /></label>
);

function EditarGastoModal({ s, g, onClose, onGuardar }: { s: DemoPagar; g: Gasto; onClose: () => void; onGuardar: (d: Parameters<typeof editarGasto>[2], motivo: string) => void }) {
  const [d, setD] = useState({ concepto: g.concepto, proveedorId: g.proveedorId ?? '', categoria: g.categoria, fecha: g.fecha, comprobante: g.comprobante ?? '', total: String(g.total) });
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const datos = { ...d, proveedorId: d.proveedorId || null, comprobante: d.comprobante || null, total: Number(d.total) };
  return (
    <Modal titulo="Editar gasto" onClose={onClose} onSubmit={() => intentar(() => onGuardar(datos, motivo), setError)} puedeGuardar={motivo.trim() !== ''} guardando={false} textoGuardar="Guardar cambios">
      {AVISO_DEMO}
      <label className={etiqueta}>Concepto<input value={d.concepto} onChange={(e) => setD({ ...d, concepto: e.target.value })} className={campo} /></label>
      <label className={etiqueta}>Proveedor
        <select value={d.proveedorId} onChange={(e) => setD({ ...d, proveedorId: e.target.value })} className={campo}>
          <option value="">Sin proveedor</option>{s.proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Categoría<select value={d.categoria} onChange={(e) => setD({ ...d, categoria: e.target.value })} className={campo}>{CATEGORIAS.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className={etiqueta}>Fecha del gasto<input type="date" value={d.fecha} onChange={(e) => setD({ ...d, fecha: e.target.value })} className={campo} /></label>
      </div>
      <label className={etiqueta}>Comprobante<input value={d.comprobante} onChange={(e) => setD({ ...d, comprobante: e.target.value })} className={campo} placeholder="Ej.: Factura A 0001-00001234" /></label>
      <label className={etiqueta}>Importe total<input type="number" step="0.01" value={d.total} onChange={(e) => setD({ ...d, total: e.target.value })} className={campo} /></label>
      {Number(d.total) !== g.total && <p className="text-xs text-[#8A7A5C]">La diferencia se suma o resta al último vencimiento que queda por pagar.</p>}
      <Motivo v={motivo} set={setMotivo} />
      <p className="text-xs text-[#8A7A5C]">El gasto queda marcado como rectificado y el cambio se guarda en su historial, con tu usuario.</p>
      <ErrorForm e={error} />
    </Modal>
  );
}

function EditarVtoModal({ s, v, onClose, onGuardar }: { s: DemoPagar; v: Vto; onClose: () => void; onGuardar: (n: { fecha: string | null; importe: number }, motivo: string) => void }) {
  const [fecha, setFecha] = useState(v.fecha ?? '');
  const [importe, setImporte] = useState(String(v.importe));
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal titulo={`Editar · ${etiquetaVto(s, v)}`} onClose={onClose} onSubmit={() => intentar(() => onGuardar({ fecha: fecha || null, importe: Number(importe) }, motivo), setError)}
      puedeGuardar={motivo.trim() !== ''} guardando={false} textoGuardar="Guardar cambios">
      {AVISO_DEMO}
      <label className={etiqueta}>{esCheque(v) ? 'Fecha de pago del cheque' : 'Fecha de pago'}<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Importe
        <input type="number" step="0.01" value={importe} onChange={(e) => setImporte(e.target.value)} disabled={esCheque(v)} className={`${campo} disabled:bg-gray-100`} />
      </label>
      {esCheque(v) ? <p className="text-xs text-[#8A7A5C]">El importe de un cheque emitido no se cambia; solo su fecha de pago.</p>
        : Number(importe) !== v.importe && <p className="text-xs text-[#8A7A5C]">Cambiar el importe cambia también el total del gasto.</p>}
      <Motivo v={motivo} set={setMotivo} />
      <ErrorForm e={error} />
    </Modal>
  );
}
