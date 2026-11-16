import { useState } from 'react';
import { Lock, Pencil, Plus } from 'lucide-react';
import { useAuth } from '../../../auth/useAuth';
import { userLabel, versionsEffectiveOn, type ManufacturingRecord, type ManufacturingVersion } from '../../../target/feed';
import { shiftDate } from '../../../target/production';
import { getTodayDate } from '../../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { useProfileNames } from '../useProduction';
import { fechaDMA, kgTxt, mesDe } from './format';
import { botonPrimario, Tabla, Titulo, td, tdR, thL, thR } from './ui';
import { useAlimentoMutations, useAllFeedTypes, useFabricaciones, useStockPeriods, useVersions } from './useAlimento';

/**
 * Fabricaciones (ADMIN and OPERATOR). Register: date (past allowed while its stock month is open), one recipe/version
 * selector (active recipes, the version effective on that date), kg (the recipe's standard batch, editable), comment.
 * Edit = RPC 49 rectification (a new version, reason required, the date is kept — ADR-014); ADMIN any record, OPERATOR
 * its own. A closed stock month shows a lock and offers no edit; the backend refuses it anyway (FEED_MONTH_CLOSED).
 */
export function Fabricaciones() {
  const { user, rol } = useAuth();
  const hoy = getTodayDate();
  const [desde, setDesde] = useState(shiftDate(hoy, -45));
  const [hasta, setHasta] = useState(hoy);
  const registros = useFabricaciones(desde, hasta);
  const periodos = useStockPeriods();
  const perfiles = useProfileNames();
  const [form, setForm] = useState<ManufacturingRecord | 'nueva' | null>(null);
  const cerrado = (fecha: string) => (periodos.data ?? []).some((p) => p.period === mesDe(fecha) && p.status === 'CLOSED');
  const autor = (id: string | null) => userLabel(id, user?.id ?? null, perfiles.data ?? new Map());
  const puedeEditar = (r: ManufacturingRecord) => rol === 'ADMIN' || r.author === user?.id;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="flex items-center gap-2 text-sm">
          <input type="date" aria-label="Desde" value={desde} onChange={(e) => setDesde(e.target.value)} className="border border-gray-300 rounded px-2 py-1" />
          <span>a</span>
          <input type="date" aria-label="Hasta" value={hasta} onChange={(e) => setHasta(e.target.value)} className="border border-gray-300 rounded px-2 py-1" />
        </span>
        <button className={botonPrimario} onClick={() => setForm('nueva')}><Plus className="w-4 h-4 inline -mt-0.5" /> Nueva fabricación</button>
      </div>
      <section>
        <Titulo>Historial de fabricaciones</Titulo>
        {registros.isLoading ? <p className="text-sm text-gray-500">Cargando…</p> : registros.error ? <p className="text-sm text-red-700">No se pudieron leer las fabricaciones.</p>
          : (registros.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay fabricaciones en el período.</p> : (
            <Tabla cabecera={<><th className={thL}>Fecha</th><th className={thL}>Tipo / versión</th><th className={thR}>Kilos</th><th className={thL}>Responsable</th>
              <th className={`${thL} hidden md:table-cell`}>Comentario</th><th className={thR} /></>}>
              {(registros.data ?? []).map((r) => (
                <tr key={r.current.id}>
                  <td className={td}>{fechaDMA(r.current.manufacturing_date)}</td>
                  <td className={td}>{r.current.feed_type_nombre} · v{r.current.formula_version}{r.history.length > 0 && <Rectificada r={r} autor={autor} />}</td>
                  <td className={tdR}>{kgTxt(r.current.quantity_kg)}</td>
                  <td className={td}>{autor(r.author)}</td>
                  <td className={`${td} hidden md:table-cell text-gray-600`}>{r.current.notes || '—'}</td>
                  <td className={tdR}>{cerrado(r.current.manufacturing_date)
                    ? <span title="Mes cerrado: no se puede editar" className="inline-flex items-center gap-1 text-xs text-gray-500"><Lock className="w-3.5 h-3.5" /> Mes cerrado</span>
                    : puedeEditar(r) && <button aria-label="Editar" title="Editar" onClick={() => setForm(r)} className="text-[#A8552E] hover:text-[#8B4423]"><Pencil className="w-4 h-4" /></button>}</td>
                </tr>
              ))}
            </Tabla>
          )}
      </section>
      {form && <FabricacionModal registro={form === 'nueva' ? null : form} cerrado={cerrado} onClose={() => setForm(null)} />}
    </div>
  );
}

const cambios = (a: ManufacturingVersion, b: ManufacturingVersion) => [
  a.formula_version_id !== b.formula_version_id && `Tipo ${a.feed_type_nombre} v${a.formula_version} → ${b.feed_type_nombre} v${b.formula_version}`,
  a.quantity_kg !== b.quantity_kg && `Kilos ${a.quantity_kg} → ${b.quantity_kg}`,
  (a.notes ?? '') !== (b.notes ?? '') && `Comentario «${a.notes || '—'}» → «${b.notes || '—'}»`,
].filter(Boolean) as string[];

/** «Rectificada» chip with the floating change history (fixed position: the scrolling table never clips it). */
function Rectificada({ r, autor }: { r: ManufacturingRecord; autor: (id: string | null) => string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const abrir = (el: HTMLElement) => { const b = el.getBoundingClientRect(); setPos({ x: Math.min(b.left, window.innerWidth - 300), y: b.bottom + 4 }); };
  const cadena = [r.current, ...r.history];   // newest first
  return (
    <span tabIndex={0} className="ml-1.5 inline-block align-middle focus:outline-none"
      onMouseEnter={(e) => abrir(e.currentTarget)} onMouseLeave={() => setPos(null)} onFocus={(e) => abrir(e.currentTarget)} onBlur={() => setPos(null)}>
      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded cursor-help">Rectificada{r.history.length > 1 ? ` ×${r.history.length}` : ''}</span>
      {pos && (
        <span style={{ left: Math.max(8, pos.x), top: pos.y }} className="fixed z-50 block w-72 max-w-[80vw] bg-white border border-[#E4DCC8] rounded-lg shadow p-3 text-xs text-gray-700 space-y-2 text-left font-normal">
          <span className="block font-semibold text-[#2C2419]">Historial de cambios</span>
          {cadena.slice(0, -1).map((v, i) => (
            <span key={v.id} className="block border-t border-amber-100 pt-1.5 first:border-0 first:pt-0">
              <span className="block text-gray-500">{new Date(v.created_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })} · {autor(v.created_by)}</span>
              {cambios(cadena[i + 1], v).map((c) => <span key={c} className="block">{c}</span>)}
              {v.rectification_reason && <span className="block text-gray-500">Motivo: {v.rectification_reason}</span>}
            </span>
          ))}
          <span className="block text-gray-500 border-t border-amber-100 pt-1.5">Registrada por {autor(r.author)}</span>
        </span>
      )}
    </span>
  );
}

function FabricacionModal({ registro, cerrado, onClose }: { registro: ManufacturingRecord | null; cerrado: (f: string) => boolean; onClose: () => void }) {
  const m = useAlimentoMutations();
  const tipos = useAllFeedTypes();
  const versiones = useVersions();
  const hoy = getTodayDate();
  const actual = registro?.current;
  const [fecha, setFecha] = useState(actual?.manufacturing_date ?? hoy);
  const [versionId, setVersionId] = useState(actual?.formula_version_id ?? '');
  const [kilos, setKilos] = useState(actual ? String(actual.quantity_kg) : '');
  const [comentario, setComentario] = useState(actual?.notes ?? '');
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `FAB-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const activos = new Map((tipos.data ?? []).filter((t) => t.activo).map((t) => [t.id, t]));
  const opciones = versionsEffectiveOn(versiones.data ?? [], fecha).filter((v) => activos.has(v.feed_type_id) || v.id === actual?.formula_version_id);
  const elegida = opciones.find((v) => v.id === versionId);
  const kgSugerido = elegida ? activos.get(elegida.feed_type_id)?.standard_batch_kg ?? 200 : 200;
  const kg = kilos === '' ? kgSugerido : Number(kilos);
  const bloqueado = cerrado(fecha);
  const sinCambios = !!actual && elegida?.id === actual.formula_version_id && kg === actual.quantity_kg && (comentario.trim() || null) === (actual.notes || null);
  const puede = !!elegida && kg > 0 && fecha !== '' && fecha <= hoy && !bloqueado && !sinCambios && (!actual || motivo.trim() !== '');
  const mut = actual ? m.rectify : m.register;
  return (
    <Modal titulo={actual ? 'Editar fabricación' : 'Nueva fabricación'} onClose={onClose} guardando={mut.isPending} error={mut.error ?? versiones.error}
      puedeGuardar={puede}
      onSubmit={() => (actual
        ? m.rectify.mutate({ idempotencyKey: clave, manufacturingId: actual.id, quantityKg: kg, reason: motivo, formulaVersionId: elegida!.id, notes: comentario },
          { onSuccess: onClose })
        : m.register.mutate({ formulaVersionId: elegida!.id, date: fecha, quantityKg: kg, idempotencyKey: clave, notes: comentario }, { onSuccess: onClose }))}>
      <label className={etiqueta}>Fecha
        <input type="date" max={hoy} value={fecha} disabled={!!actual} onChange={(e) => setFecha(e.target.value)} className={`${campo} disabled:bg-gray-100`} />
      </label>
      {actual && <p className="text-xs text-gray-500">La fecha no se cambia al editar.</p>}
      {bloqueado && <p className="text-sm text-amber-800 flex items-center gap-1"><Lock className="w-4 h-4" /> El stock de ese mes está cerrado: no se puede registrar ni editar.</p>}
      {!versiones.isLoading && opciones.length === 0 ? <p className="text-sm text-amber-800">No hay recetas activas vigentes en esa fecha.</p> : (
        <label className={etiqueta}>Tipo / versión
          <select value={elegida?.id ?? ''} onChange={(e) => setVersionId(e.target.value)} className={campo}>
            <option value="">Elegir…</option>
            {opciones.map((v) => <option key={v.id} value={v.id}>{activos.get(v.feed_type_id)?.nombre ?? (tipos.data ?? []).find((t) => t.id === v.feed_type_id)?.nombre} · v{v.version}</option>)}
          </select>
        </label>
      )}
      <label className={etiqueta}>Kilos
        <input type="number" min="0" step="0.1" value={kilos} placeholder={String(kgSugerido)} onChange={(e) => setKilos(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Comentario (opcional)<input type="text" value={comentario} onChange={(e) => setComentario(e.target.value)} className={campo} /></label>
      {actual && <label className={etiqueta}>Motivo del cambio<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} placeholder="Ej: eran 400 kg" /></label>}
      <p className="text-xs text-gray-600">Responsable: {actual ? 'quien la registró' : 'vos'} (automático)</p>
    </Modal>
  );
}
