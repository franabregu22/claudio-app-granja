import { useMemo, useState } from 'react';
import { Plus, X, Edit2, AlertTriangle, Download, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import {
  brokenPct, codigoLote, describeDayEdit, horaActual, lastValidCount, listAllProduction, listDayNotes, listProductionDays, PRODUCCION_CSV_CABECERA, produccionCsvFila, shiftDate,
  type DayEdit, type FlockDay, type FlockOption,
} from '../../target/production';
import { aCsv, descargarCsv } from '../../utils/csv';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { FiltroColumna, OpcionesFiltro } from '../../components/FiltroColumna';
import { FormProduccion } from './FormProduccion';
import { useBirdCounts, useDayEdits, useDayNotes, useFlockDay, useFlockDays, useFlockOptions, useProductionDays, useProductionMutations } from './useProduction';
import { NumeroInput } from '../../components/NumeroInput';

/** «Exportar CSV»: the whole production history (every page) with every column of the table (time, who loaded it, note), one file. */
function ExportarCsv({ flocks }: { flocks: FlockOption[] }) {
  const [estado, setEstado] = useState<'listo' | 'bajando' | 'error'>('listo');
  const exportar = async () => {
    setEstado('bajando');
    try {
      const hoy = getTodayDate();
      const [filas, info, notas] = await Promise.all([listAllProduction(supabase), listProductionDays(supabase, DESDE_SIEMPRE, hoy),
        listDayNotes(supabase, DESDE_SIEMPRE, hoy)]);
      const nota = new Map(notas.map((n) => [clave(n.flock_id, n.note_date), n.notes]));
      const lote = new Map(flocks.map((f) => [f.id, codigoLote(f)]));
      descargarCsv(`produccion_${hoy}.csv`, aCsv(PRODUCCION_CSV_CABECERA, filas.map((d) => {
        const k = clave(d.flock_id, d.business_date);
        return produccionCsvFila(d, { time: info.get(k)?.time, by: info.get(k)?.by, notes: nota.get(k), lote: lote.get(d.flock_id) });
      })));
      setEstado('listo');
    } catch {
      setEstado('error');
    }
  };
  return (
    <button onClick={() => { void exportar(); }} disabled={estado === 'bajando'} title="Descargar todo el historial de producción en CSV"
      className={`text-sm px-3 py-1.5 bg-white border rounded-lg hover:bg-stone-50 inline-flex items-center gap-1 disabled:opacity-50 ${estado === 'error' ? 'border-red-300 text-red-700' : 'border-[#E4DCC8]'}`}>
      <Download className="w-4 h-4" aria-hidden />{estado === 'bajando' ? 'Exportando…' : estado === 'error' ? 'Error: reintentar' : 'Exportar CSV'}
    </button>
  );
}

const ITEMS_POR_PAGINA = 30;
const DESDE_SIEMPRE = '2000-01-01';
const DIAS_HISTORICO = 60;

const formatearFecha = (f: string) => { const [a, m, d] = f.split('-'); return `${d}/${m}/${a}`; };
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);
const momento = (iso: string) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const conSigno = (n: number) => (n > 0 ? `+${n}` : String(n));
const clave = (flockId: string, fecha: string) => `${flockId}|${fecha}`;

const TH = 'px-2.5 py-1.5 font-semibold text-amber-900 bg-amber-50 whitespace-nowrap';
const TD = 'px-2.5 py-1 whitespace-nowrap';

/**
 * Producción (ADMIN and OPERATOR). The history is report_flock_day (eggs, laying %, mortality, population exactly as reported) plus
 * the day's note and its modifications (0131). Every write is a contract RPC: the day in one call, its edit with a reason (anyone,
 * any record), a bird count by its total and the deletion of the flock's last count. The whole table is shown on a phone too
 * (horizontal scroll, no hidden columns — owner 2026-11-17).
 */
export function ProductionApp() {
  const hoy = getTodayDate();
  const [desde, setDesde] = useState(shiftDate(hoy, -DIAS_HISTORICO));
  const [hasta, setHasta] = useState(hoy);
  const [galpon, setGalpon] = useState('');
  const flocks = useFlockOptions();
  const dias = useFlockDays(desde, hasta);
  const notas = useDayNotes(desde, hasta);
  const ediciones = useDayEdits(desde, hasta);
  const info = useProductionDays(desde, hasta);   // time and who loaded each day (0131)
  const [nuevo, setNuevo] = useState(false);
  const [conteo, setConteo] = useState(false);
  const [editando, setEditando] = useState<FlockDay | null>(null);
  const [pagina, setPagina] = useState(0);

  const notaDe = useMemo(() => new Map((notas.data ?? []).map((n) => [clave(n.flock_id, n.note_date), n.notes])), [notas.data]);
  const edicionesDe = useMemo(() => {
    const m = new Map<string, DayEdit[]>();
    for (const e of ediciones.data ?? []) {
      const k = clave(e.flock_id, e.date);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [ediciones.data]);

  if (flocks.isLoading || dias.isLoading) return <div className="flex items-center justify-center py-12"><p className="text-gray-500">Cargando producción...</p></div>;
  const error = flocks.error ?? dias.error ?? notas.error ?? ediciones.error ?? info.error;
  const loteDe = new Map((flocks.data ?? []).map((f) => [f.id, codigoLote(f)]));
  const galpones = [...new Set((flocks.data ?? []).map((f) => f.shed_nombre))].sort((a, b) => a.localeCompare(b, 'es'));
  const filas = (dias.data ?? []).filter((d) => (d.daily_production_id || d.mortality !== 0 || d.count_adjustment !== 0 || notaDe.has(clave(d.flock_id, d.business_date)))
    && (galpon === '' || d.shed_nombre === galpon));
  const totalPaginas = Math.max(1, Math.ceil(filas.length / ITEMS_POR_PAGINA));
  const pag = Math.min(pagina, totalPaginas - 1);
  const visibles = filas.slice(pag * ITEMS_POR_PAGINA, (pag + 1) * ITEMS_POR_PAGINA);
  const fechaFiltrada = desde !== shiftDate(hoy, -DIAS_HISTORICO) || hasta !== hoy;

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-full bg-[#FAF6EE] min-h-screen flex flex-col">
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8] flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
            <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Producción</h1>
          </div>
          <span className="flex items-center gap-2">
            <ExportarCsv flocks={flocks.data ?? []} />
            <button onClick={() => setConteo(true)} className="text-sm px-3 py-1.5 bg-white border border-[#E4DCC8] rounded-lg hover:bg-stone-50">Conteo de aves</button>
          </span>
        </header>

        <div className="flex-1 px-4 md:px-6 pt-4 pb-20">
          {error ? <div className="mb-4 bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[#8A6A2E]">
            <span className="font-semibold uppercase tracking-wide">Histórico {formatearFecha(desde)} – {formatearFecha(hasta)}</span>
            {(fechaFiltrada || galpon) && (
              <button type="button" onClick={() => { setDesde(shiftDate(hoy, -DIAS_HISTORICO)); setHasta(hoy); setGalpon(''); setPagina(0); }}
                className="underline hover:text-[#A8552E]">Limpiar filtros</button>
            )}
          </div>
          <div className="relative w-full bg-white rounded-lg border border-amber-200 overflow-x-auto">
            <table className="w-full text-xs md:text-sm">
              <thead className="border-b border-amber-200">
                <tr>
                  <th className={`${TH} text-left`}>
                    <FiltroColumna titulo="Fecha" activo={fechaFiltrada}>
                      {(cerrar) => (
                        <div className="space-y-2 p-1">
                          <label className={etiqueta}>Desde<input type="date" value={desde} max={hasta} onChange={(e) => { if (e.target.value) { setDesde(e.target.value); setPagina(0); } }} className={campo} /></label>
                          <label className={etiqueta}>Hasta<input type="date" value={hasta} min={desde} onChange={(e) => { if (e.target.value) { setHasta(e.target.value); setPagina(0); } }} className={campo} /></label>
                          <button type="button" onClick={() => { setDesde(shiftDate(hoy, -DIAS_HISTORICO)); setHasta(hoy); setPagina(0); cerrar(); }}
                            className="w-full rounded border border-[#E4DCC8] px-2 py-1 text-sm hover:bg-amber-50">Últimos {DIAS_HISTORICO} días</button>
                        </div>
                      )}
                    </FiltroColumna>
                  </th>
                  <th className={`${TH} text-left`}>Hora</th>
                  <th className={`${TH} text-left`}>Responsable</th>
                  <th className={`${TH} text-left`}>
                    <FiltroColumna titulo="Galpón" activo={galpon !== ''}>
                      {(cerrar) => <OpcionesFiltro valor={galpon} opciones={galpones.map((g) => ({ v: g, t: g }))} onElegir={(v) => { setGalpon(v); setPagina(0); cerrar(); }} />}
                    </FiltroColumna>
                  </th>
                  <th className={`${TH} text-left`}>Lote</th>
                  <th className={`${TH} text-right`}>Huevos</th>
                  <th className={`${TH} text-right`}>Rotos</th>
                  <th className={`${TH} text-right`}>% Rotos</th>
                  <th className={`${TH} text-right bg-amber-100`}>% Postura</th>
                  <th className={`${TH} text-right`}>Mortandad</th>
                  <th className={`${TH} text-right`}>Aves</th>
                  <th className={`${TH} text-left w-full`}>Notas</th>
                  <th className={`${TH} text-center`} aria-label="Acción" />
                </tr>
              </thead>
              <tbody>
                {visibles.length === 0 && (
                  <tr><td colSpan={13} className="px-2 py-6 text-center text-sm text-[#8A7A5C]">No hay registros en el período.</td></tr>
                )}
                {visibles.map((d) => {
                  const k = clave(d.flock_id, d.business_date);
                  const nota = notaDe.get(k);
                  const cambios = edicionesDe.get(k) ?? [];
                  return (
                    <tr key={k} className="border-b border-amber-100 hover:bg-amber-50">
                      <td className={`${TD} text-gray-700`}>
                        {formatearFecha(d.business_date)}
                        {cambios.length > 0 && (
                          <span className="ml-1.5 inline-block rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 cursor-help"
                            title={cambios.map((e) => `${momento(e.at)} · ${e.actor}\n${describeDayEdit(e) || 'Sin cambios de valores'}\nMotivo: ${e.reason ?? '—'}`).join('\n\n')}>
                            Modificado
                          </span>
                        )}
                      </td>
                      <td className={`${TD} text-gray-600`}>{info.data?.get(k)?.time ?? '—'}</td>
                      <td className={`${TD} text-gray-600`}>{info.data?.get(k)?.by ?? '—'}</td>
                      <td className={`${TD} text-gray-700`}>{d.shed_nombre}
                        {d.quality_data_warning && <span title="Datos de calidad incompletos"><AlertTriangle className="inline w-3 h-3 ml-1 text-amber-600" /></span>}
                      </td>
                      <td className={`${TD} text-gray-600`} title={d.genetics_line ?? undefined}>{loteDe.get(d.flock_id) ?? '—'}</td>
                      <td className={`${TD} text-right font-semibold text-amber-900`}>{d.eggs_total ?? '—'}</td>
                      <td className={`${TD} text-right text-gray-700`}>{d.eggs_broken ?? '—'}</td>
                      <td className={`${TD} text-right text-gray-600`}>{pct(brokenPct(d))}</td>
                      <td className={`${TD} text-right font-semibold text-amber-900 bg-amber-50`}>{pct(d.laying_pct)}</td>
                      <td className={`${TD} text-right text-gray-700`}>{d.mortality || '—'}</td>
                      <td className={`${TD} text-right text-gray-700`}>
                        {d.population}
                        {d.count_adjustment !== 0 && (
                          <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] font-semibold text-emerald-800" title="Ese día se registró un conteo de aves">
                            conteo ({conSigno(d.count_adjustment)})
                          </span>
                        )}
                      </td>
                      <td className={`${TD} text-gray-600 max-w-[32rem] truncate`} title={nota}>{nota ?? ''}</td>
                      <td className={`${TD} text-center`}>
                        <button onClick={() => setEditando(d)} className="text-amber-600 hover:text-amber-900 p-0.5" title="Modificar el día" aria-label="Modificar el día">
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalPaginas > 1 && (
            <div className="mt-3 flex items-center justify-center gap-2 text-sm">
              <button onClick={() => setPagina(Math.max(0, pag - 1))} disabled={pag === 0} className="px-2 py-1 border border-amber-200 rounded disabled:opacity-50">←</button>
              <span>{pag + 1} / {totalPaginas}</span>
              <button onClick={() => setPagina(Math.min(totalPaginas - 1, pag + 1))} disabled={pag >= totalPaginas - 1} className="px-2 py-1 border border-amber-200 rounded disabled:opacity-50">→</button>
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
      {editando && <EditarDia dia={editando} nota={notaDe.get(clave(editando.flock_id, editando.business_date)) ?? ''}
        hora={info.data?.get(clave(editando.flock_id, editando.business_date))?.time ?? ''} onClose={() => setEditando(null)} />}
      {conteo && <ConteoAves flocks={flocks.data ?? []} onClose={() => setConteo(false)} />}
    </div>
  );
}

/** The day's form with what was loaded (eggs, broken, mortality, note) — any change needs a reason (0131 edit_production_day). */
function EditarDia({ dia, nota, hora: horaCargada, onClose }: { dia: FlockDay; nota: string; hora: string; onClose: () => void }) {
  const { editDay } = useProductionMutations();
  const conProduccion = dia.daily_production_id !== null;
  const [total, setTotal] = useState(dia.eggs_total === null ? '' : String(dia.eggs_total));
  const [rotos, setRotos] = useState(String(dia.eggs_broken ?? 0));
  const [muertes, setMuertes] = useState(String(dia.mortality));
  const [notas, setNotas] = useState(nota);
  const [hora, setHora] = useState(horaCargada || (conProduccion ? '' : horaActual()));
  const [motivo, setMotivo] = useState('');
  const n = (v: string) => (v === '' ? 0 : Math.trunc(Number(v)));
  const cambio = total !== (dia.eggs_total === null ? '' : String(dia.eggs_total)) || n(rotos) !== (dia.eggs_broken ?? 0)
    || n(muertes) !== dia.mortality || notas.trim() !== nota.trim() || (total !== '' && hora !== '' && hora !== horaCargada);
  const rotosDeMas = total !== '' && n(rotos) > n(total);
  const faltanHuevos = conProduccion && total === '';
  return (
    <Modal titulo={`Modificar — ${dia.shed_nombre} ${formatearFecha(dia.business_date)}`} onClose={onClose}
      puedeGuardar={cambio && !rotosDeMas && !faltanHuevos && motivo.trim() !== ''} guardando={editDay.isPending} error={editDay.error} textoGuardar="Guardar cambios"
      onSubmit={() => editDay.mutate({
        flockId: dia.flock_id, date: dia.business_date, eggsTotal: total === '' ? null : n(total), eggsBroken: total === '' ? 0 : n(rotos),
        deaths: n(muertes), notes: notas, recordedTime: total === '' || hora === '' ? null : hora, reason: motivo.trim(),
      }, { onSuccess: onClose })}>
      <div className="grid grid-cols-3 gap-2">
        <label className={etiqueta}>Huevos totales<NumeroInput min="0" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Rotos<NumeroInput min="0" value={rotos} onChange={(e) => setRotos(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Mortandad<NumeroInput min="0" value={muertes} onChange={(e) => setMuertes(e.target.value)} className={campo} /></label>
      </div>
      {total !== '' && (
        <label className={etiqueta}>Hora del registro<input type="time" value={hora} onChange={(e) => setHora(e.target.value)} className={campo} /></label>
      )}
      {rotosDeMas && <p className="text-xs text-red-700">Los rotos no pueden superar a los huevos totales.</p>}
      {faltanHuevos && <p className="text-xs text-red-700">Ese día tiene producción: indicá los huevos.</p>}
      {!conProduccion && <p className="text-xs text-gray-500">Ese día no tiene producción cargada: si cargás huevos, se registra.</p>}
      <label className={etiqueta}>Notas<input type="text" value={notas} maxLength={500} onChange={(e) => setNotas(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Motivo de la modificación<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: mal contado" className={campo} /></label>
      <p className="text-xs text-gray-500">El día queda marcado como «Modificado» con quién lo cambió, qué cambió y el motivo.</p>
    </Modal>
  );
}

/** A bird count by its TOTAL (0131): the system shows what it computes for that date and the difference; the flock's counts with
 *  their responsible; only the last valid count can be deleted (the population goes back). */
function ConteoAves({ flocks, onClose }: { flocks: FlockOption[]; onClose: () => void }) {
  const { count, voidCount } = useProductionMutations();
  const activos = flocks.filter((f) => f.estado === 'ACTIVE');
  const [flockId, setFlockId] = useState(activos.length === 1 ? activos[0].id : '');
  const [fecha, setFecha] = useState(getTodayDate());
  const [contadas, setContadas] = useState('');
  const [comentario, setComentario] = useState('');
  const [borrar, setBorrar] = useState<number | null>(null);
  const dia = useFlockDay(flockId, fecha);
  const conteos = useBirdCounts(flockId);
  const ultimo = lastValidCount(conteos.data ?? []);
  const sistema = dia.data?.population ?? null;
  const diferencia = sistema !== null && contadas !== '' ? Math.trunc(Number(contadas)) - sistema : null;
  return (
    <Modal titulo="Conteo de aves" onClose={onClose} puedeGuardar={flockId !== '' && fecha !== '' && contadas !== '' && Number(contadas) >= 0}
      guardando={count.isPending} error={count.error ?? voidCount.error} textoGuardar="Registrar conteo"
      onSubmit={() => count.mutate({ flockId, date: fecha, counted: Math.trunc(Number(contadas)), reason: comentario },
        { onSuccess: () => { setContadas(''); setComentario(''); } })}>
      <label className={etiqueta}>Lote / galpón
        <select value={flockId} onChange={(e) => setFlockId(e.target.value)} className={campo}>
          <option value="">Elegir…</option>
          {flocks.map((f) => <option key={f.id} value={f.id}>{codigoLote(f)} · {f.shed_nombre}{f.exit_date ? ` · salida ${formatearFecha(f.exit_date)}` : ''}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Fecha del conteo<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Aves contadas<NumeroInput min="0" value={contadas} onChange={(e) => setContadas(e.target.value)} className={campo} /></label>
      </div>
      {flockId !== '' && (
        <p className="text-sm text-[#2C2419]">
          {dia.isLoading ? 'Calculando…' : sistema === null ? 'El lote no tiene datos para esa fecha.' : (
            <>El sistema calcula <b>{sistema}</b> aves al {formatearFecha(fecha)}
              {diferencia !== null && <> → diferencia <b className={diferencia === 0 ? '' : diferencia < 0 ? 'text-red-700' : 'text-emerald-700'}>{conSigno(diferencia)}</b></>}.</>
          )}
        </p>
      )}
      <label className={etiqueta}>Comentario (opcional)<input type="text" value={comentario} maxLength={200} onChange={(e) => setComentario(e.target.value)} className={campo} /></label>

      {flockId !== '' && (
        <div className="border-t border-[#E4DCC8] pt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E] mb-1">Conteos del lote</p>
          {conteos.isLoading ? <p className="text-xs text-gray-500">Cargando…</p> : (conteos.data ?? []).length === 0 ? (
            <p className="text-xs text-gray-500">Todavía no hay conteos.</p>
          ) : (
            <div className="relative overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead><tr className="text-left text-amber-900">
                  <th className="px-1 py-1">Fecha</th><th className="px-1 py-1 text-right">Contadas</th><th className="px-1 py-1 text-right">Sistema</th>
                  <th className="px-1 py-1 text-right">Dif.</th><th className="px-1 py-1">Responsable</th><th className="px-1 py-1">Comentario</th><th className="px-1 py-1" />
                </tr></thead>
                <tbody>
                  {(conteos.data ?? []).map((c) => (
                    <tr key={c.id} className={`border-t border-amber-100 whitespace-nowrap ${c.voided_at ? 'text-gray-400 line-through' : ''}`}
                      title={c.voided_at ? `Borrado por ${c.voided_by ?? '—'} el ${momento(c.voided_at)}` : `Cargado el ${momento(c.at)}`}>
                      <td className="px-1 py-1">{formatearFecha(c.date)}</td>
                      <td className="px-1 py-1 text-right">{c.counted}</td>
                      <td className="px-1 py-1 text-right">{c.computed}</td>
                      <td className="px-1 py-1 text-right">{conSigno(c.difference)}</td>
                      <td className="px-1 py-1">{c.by}</td>
                      <td className="px-1 py-1 max-w-[10rem] truncate">{c.reason ?? ''}</td>
                      <td className="px-1 py-1 no-underline">
                        {ultimo?.id === c.id && (borrar === c.id ? (
                          <span className="inline-flex items-center gap-1 no-underline">
                            <button type="button" disabled={voidCount.isPending} onClick={() => voidCount.mutate({ countId: c.id }, { onSuccess: () => setBorrar(null) })}
                              className="rounded bg-red-600 px-1.5 py-0.5 text-white disabled:opacity-50">{voidCount.isPending ? 'Borrando…' : 'Confirmar'}</button>
                            <button type="button" onClick={() => setBorrar(null)} className="underline">No</button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setBorrar(c.id)} title="Borrar el conteo: la población vuelve a la anterior" aria-label="Borrar conteo"
                            className="text-red-700 hover:text-red-900"><Trash2 className="w-3.5 h-3.5" /></button>
                        ))}
                        {c.voided_at && <span className="text-[10px] no-underline">borrado</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-1 text-[11px] text-gray-500">Solo se puede borrar el último conteo de cada lote.</p>
        </div>
      )}
    </Modal>
  );
}
