import { useState } from 'react';
import { Plus, X, Edit2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { shiftDate, type FlockDay, type FlockOption } from '../../target/production';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { FormProduccion } from './FormProduccion';
import { useFlockDays, useFlockOptions, useMortalityEvents, useProductionMutations } from './useProduction';

const ITEMS_POR_PAGINA = 12;
const DIAS_HISTORICO = 60;

const formatearFecha = (f: string) => { const [a, m, d] = f.split('-'); return `${d}/${m}/${a}`; };
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

/**
 * Producción (F27-E; ADMIN and OPERATOR on assigned flocks). The history is report_flock_day: eggs, laying % and
 * expected curve, mortality, population and the quality warning exactly as reported. Every write is a contract
 * RPC (register / rectify production, register mortality, count adjustment; mortality rectification is ADMIN-only).
 */
export function ProductionApp() {
  const { rol } = useAuth();
  const hoy = getTodayDate();
  const flocks = useFlockOptions();
  const dias = useFlockDays(shiftDate(hoy, -DIAS_HISTORICO), hoy);
  const [nuevo, setNuevo] = useState(false);
  const [ajuste, setAjuste] = useState(false);
  const [rectificando, setRectificando] = useState<FlockDay | null>(null);
  const [rectMortandad, setRectMortandad] = useState<FlockDay | null>(null);
  const [pagina, setPagina] = useState(0);

  if (flocks.isLoading || dias.isLoading) return <div className="flex items-center justify-center py-12"><p className="text-gray-500">Cargando producción...</p></div>;
  const error = flocks.error ?? dias.error;
  const filas = (dias.data ?? []).filter((d) => d.daily_production_id || d.mortality !== 0 || d.count_adjustment !== 0);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / ITEMS_POR_PAGINA));
  const visibles = filas.slice(pagina * ITEMS_POR_PAGINA, (pagina + 1) * ITEMS_POR_PAGINA);

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-full bg-[#FAF6EE] min-h-screen flex flex-col">
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8] flex items-end justify-between gap-2">
          <div>
            <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
            <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Producción</h1>
          </div>
          <button onClick={() => setAjuste(true)} className="text-sm px-3 py-1.5 bg-white border border-[#E4DCC8] rounded-lg hover:bg-stone-50">Ajuste de conteo</button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {error ? <div className="mb-4 bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">Histórico (últimos {DIAS_HISTORICO} días)</p>
          {filas.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay registros en el período.</p> : (
            <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
              <table className="w-full text-xs md:text-sm">
                <thead className="bg-amber-50 border-b border-amber-200">
                  <tr>
                    <th className="px-2 md:px-4 py-2 text-left font-semibold text-amber-900">Fecha</th>
                    <th className="px-2 md:px-4 py-2 text-left font-semibold text-amber-900">Galpón</th>
                    <th className="px-2 md:px-4 py-2 text-right font-semibold text-amber-900">Huevos</th>
                    <th className="px-2 md:px-4 py-2 text-right font-semibold text-amber-900">Rotos</th>
                    <th className="hidden lg:table-cell px-4 py-2 text-right font-semibold text-amber-900">Sucios</th>
                    <th className="px-2 md:px-4 py-2 text-right font-semibold text-amber-900 bg-amber-100">% Postura</th>
                    <th className="hidden lg:table-cell px-4 py-2 text-right font-semibold text-amber-900">% Esperado</th>
                    <th className="px-2 md:px-4 py-2 text-right font-semibold text-amber-900">Mortandad</th>
                    <th className="hidden md:table-cell px-4 py-2 text-right font-semibold text-amber-900">Aves</th>
                    <th className="px-2 md:px-4 py-2 text-center font-semibold text-amber-900">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((d) => (
                    <tr key={`${d.flock_id}-${d.business_date}`} className="border-b border-amber-100 hover:bg-amber-50">
                      <td className="px-2 md:px-4 py-2 text-gray-700">{formatearFecha(d.business_date)}</td>
                      <td className="px-2 md:px-4 py-2 text-gray-700">{d.shed_nombre}
                        {d.quality_data_warning && <span title="Datos de calidad incompletos"><AlertTriangle className="inline w-3 h-3 ml-1 text-amber-600" /></span>}
                      </td>
                      <td className="px-2 md:px-4 py-2 text-right font-semibold text-amber-900">{d.eggs_total ?? '—'}</td>
                      <td className="px-2 md:px-4 py-2 text-right text-gray-700">{d.eggs_broken ?? '—'}</td>
                      <td className="hidden lg:table-cell px-4 py-2 text-right text-gray-700">{d.eggs_dirty ?? '—'}</td>
                      <td className="px-2 md:px-4 py-2 text-right font-semibold text-amber-900 bg-amber-100">{pct(d.laying_pct)}</td>
                      <td className="hidden lg:table-cell px-4 py-2 text-right text-gray-600">{pct(d.expected_laying_pct)}</td>
                      <td className="px-2 md:px-4 py-2 text-right text-gray-700">{d.mortality || '—'}</td>
                      <td className="hidden md:table-cell px-4 py-2 text-right text-gray-700">{d.population}</td>
                      <td className="px-2 md:px-4 py-2 text-center whitespace-nowrap">
                        {d.daily_production_id && (
                          <button onClick={() => setRectificando(d)} className="text-amber-600 hover:text-amber-900 inline-flex items-center gap-1" title="Rectificar producción">
                            <Edit2 className="w-4 h-4" />
                          </button>
                        )}
                        {rol === 'ADMIN' && d.mortality !== 0 && (
                          <button onClick={() => setRectMortandad(d)} className="ml-2 text-xs text-red-700 hover:underline" title="Rectificar mortandad">Mort.</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {totalPaginas > 1 && (
            <div className="mt-3 flex items-center justify-center gap-2 text-sm">
              <button onClick={() => setPagina(Math.max(0, pagina - 1))} disabled={pagina === 0} className="px-2 py-1 border border-amber-200 rounded disabled:opacity-50">←</button>
              <span>{pagina + 1} / {totalPaginas}</span>
              <button onClick={() => setPagina(Math.min(totalPaginas - 1, pagina + 1))} disabled={pagina >= totalPaginas - 1} className="px-2 py-1 border border-amber-200 rounded disabled:opacity-50">→</button>
            </div>
          )}
        </div>

        <div className="fixed bottom-6 right-4 md:right-6 z-40">
          <button onClick={() => setNuevo(true)} className="flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-3 rounded-lg hover:bg-[#8B4423] shadow-lg">
            <Plus className="w-5 h-5" /> Nuevo
          </button>
        </div>
      </div>

      {nuevo && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-4 z-50 overflow-y-auto p-4">
          <div className="bg-[#FAF6EE] rounded-lg max-w-2xl w-full">
            <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-[#E4DCC8]">
              <h2 className="text-lg font-bold text-[#2C2419]">Registrar producción</h2>
              <button onClick={() => setNuevo(false)} className="text-[#8A7A5C] hover:text-[#2C2419]"><X className="w-6 h-6" /></button>
            </div>
            <div className="px-4 md:px-6 py-6"><FormProduccion flocks={flocks.data ?? []} onDone={() => setNuevo(false)} /></div>
          </div>
        </div>
      )}
      {rectificando && <RectificarProduccion dia={rectificando} onClose={() => setRectificando(null)} />}
      {rectMortandad && <RectificarMortandad dia={rectMortandad} onClose={() => setRectMortandad(null)} />}
      {ajuste && <AjusteConteo flocks={flocks.data ?? []} onClose={() => setAjuste(false)} />}
    </div>
  );
}

function RectificarProduccion({ dia, onClose }: { dia: FlockDay; onClose: () => void }) {
  const { rectify } = useProductionMutations();
  const [total, setTotal] = useState(String(dia.eggs_total ?? 0));
  const [rotos, setRotos] = useState(String(dia.eggs_broken ?? 0));
  const [sucios, setSucios] = useState(String(dia.eggs_dirty ?? 0));
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={`Rectificar producción — ${dia.shed_nombre} ${formatearFecha(dia.business_date)}`} onClose={onClose}
      puedeGuardar={total !== '' && motivo.trim() !== ''} guardando={rectify.isPending} error={rectify.error} textoGuardar="Rectificar"
      onSubmit={() => rectify.mutate({ productionId: dia.daily_production_id!, eggsTotal: Number(total), eggsBroken: Number(rotos || 0), eggsDirty: Number(sucios || 0), reason: motivo },
        { onSuccess: onClose })}>
      <div className="grid grid-cols-3 gap-2">
        <label className={etiqueta}>Totales<input type="number" min="0" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Rotos<input type="number" min="0" value={rotos} onChange={(e) => setRotos(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Sucios<input type="number" min="0" value={sucios} onChange={(e) => setSucios(e.target.value)} className={campo} /></label>
      </div>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

function RectificarMortandad({ dia, onClose }: { dia: FlockDay; onClose: () => void }) {
  const { rectifyMortality } = useProductionMutations();
  const eventos = useMortalityEvents(dia.flock_id, dia.business_date, true);
  const evento = (eventos.data ?? [])[0];
  const [muertes, setMuertes] = useState('');
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={`Rectificar mortandad — ${dia.shed_nombre} ${formatearFecha(dia.business_date)}`} onClose={onClose}
      puedeGuardar={!!evento && muertes !== '' && motivo.trim() !== ''} guardando={rectifyMortality.isPending} error={rectifyMortality.error ?? eventos.error}
      textoGuardar="Rectificar"
      onSubmit={() => rectifyMortality.mutate({ eventId: evento!.id, deaths: Number(muertes), reason: motivo }, { onSuccess: onClose })}>
      <p className="text-sm text-gray-600">{evento ? `Registrado: ${evento.deaths} aves` : eventos.isLoading ? 'Cargando…' : 'No hay un registro de mortandad para rectificar.'}</p>
      <label className={etiqueta}>Mortandad correcta<input type="number" min="1" value={muertes} onChange={(e) => setMuertes(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

function AjusteConteo({ flocks, onClose }: { flocks: FlockOption[]; onClose: () => void }) {
  const { countAdjustment } = useProductionMutations();
  const [flockId, setFlockId] = useState(flocks.length === 1 ? flocks[0].id : '');
  const [fecha, setFecha] = useState(getTodayDate());
  const [delta, setDelta] = useState('');
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo="Ajuste de conteo de aves" onClose={onClose} puedeGuardar={flockId !== '' && delta !== '' && Number(delta) !== 0 && motivo.trim() !== ''}
      guardando={countAdjustment.isPending} error={countAdjustment.error} textoGuardar="Registrar ajuste"
      onSubmit={() => countAdjustment.mutate({ flockId, date: fecha, delta: Math.trunc(Number(delta)), reason: motivo }, { onSuccess: onClose })}>
      <label className={etiqueta}>Lote / galpón
        <select value={flockId} onChange={(e) => setFlockId(e.target.value)} className={campo}>
          <option value="">Elegir…</option>
          {flocks.map((f) => <option key={f.id} value={f.id}>{f.shed_nombre} · ingreso {f.entry_date}{f.exit_date ? ` · salida ${f.exit_date}` : ''}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Fecha del recuento<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Diferencia de aves (+ sobran / − faltan)<input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-500">La población la calcula el sistema a partir de los registros.</p>
    </Modal>
  );
}
