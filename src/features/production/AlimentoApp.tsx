import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { FEED_MOVEMENT_TYPES, type FeedMovementType } from '../../target/feed';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { AlimentoModulo } from './alimento/AlimentoModulo';
import { useFeedMutations, useFeedTypes, useFlockFeed, useFlockOptions } from './useProduction';
import { NumeroInput } from '../../components/NumeroInput';

type Accion = 'movimiento' | 'asignacion';
const MOVIMIENTO: Record<FeedMovementType, string> = {
  EXTERNAL_SALE: 'Venta externa', LOSS: 'Pérdida', ADJUSTMENT_POSITIVE: 'Ajuste (+)', ADJUSTMENT_NEGATIVE: 'Ajuste (−)',
};

/**
 * Alimento Balanceado (alimento-balanceado-v1): the module (Resumen, Stock, Compras e insumos, Recetas, Fabricaciones,
 * Ver recetas — by role) plus, for ADMIN, «Más acciones»: loss / adjustment movements and flock feed assignment (ADMIN
 * only; the RPCs enforce it). An external feed sale (EXTERNAL_SALE) needs its Pedido, not offered here. Physical stock
 * is counted by the monthly close (Stock), which replaces the free count of F27-E.
 */
export function AlimentoApp() {
  const { rol } = useAuth();
  const asignaciones = useFlockFeed();
  const tipos = useFeedTypes();
  const lotes = useFlockOptions();
  const [accion, setAccion] = useState<Accion | null>(null);
  const nombreTipo = (id: string) => (tipos.data ?? []).find((t) => t.id === id)?.nombre ?? '—';
  const nombreLote = (id: string) => (lotes.data ?? []).find((f) => f.id === id)?.shed_nombre ?? '—';

  return (
    <div className="min-h-screen bg-[#FAF6EE] px-4 md:px-6 pt-6 pb-20 space-y-6">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Alimento</h1>
        </div>
        {rol === 'ADMIN' && (
          <details className="relative text-sm mt-2">
            <summary className="cursor-pointer text-[#A8552E]">Más acciones</summary>
            <div className="absolute right-0 z-10 mt-1 bg-white border border-[#E4DCC8] rounded-lg shadow p-2 w-64 space-y-1">
              <button onClick={() => setAccion('movimiento')} className="w-full text-left px-2 py-1 rounded hover:bg-amber-50">Movimiento (pérdida / ajuste)</button>
              <button onClick={() => setAccion('asignacion')} className="w-full text-left px-2 py-1 rounded hover:bg-amber-50">Asignar alimento a un lote</button>
              <p className="px-2 pt-1 text-xs text-gray-500 border-t border-[#E4DCC8]">Asignaciones vigentes</p>
              {(asignaciones.data ?? []).filter((a) => !a.effective_to).map((a) => (
                <p key={a.id} className="px-2 text-xs text-gray-700">{nombreLote(a.flock_id)} · {nombreTipo(a.feed_type_id)} · desde {a.effective_from}</p>
              ))}
            </div>
          </details>
        )}
      </div>
      <AlimentoModulo />
      {accion === 'movimiento' && <MovimientoModal onClose={() => setAccion(null)} />}
      {accion === 'asignacion' && <AsignacionModal onClose={() => setAccion(null)} />}
    </div>
  );
}

function TipoSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tipos = useFeedTypes();
  return (
    <label className={etiqueta}>Alimento
      <select value={value} onChange={(e) => onChange(e.target.value)} className={campo}>
        <option value="">Elegir…</option>
        {(tipos.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
      </select>
    </label>
  );
}


function MovimientoModal({ onClose }: { onClose: () => void }) {
  const { movement } = useFeedMutations();
  const [tipoId, setTipoId] = useState('');
  const [tipoMov, setTipoMov] = useState<FeedMovementType>('LOSS');
  const [fecha, setFecha] = useState(getTodayDate());
  const [cantidad, setCantidad] = useState('');
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo="Movimiento de alimento" onClose={onClose} puedeGuardar={tipoId !== '' && Number(cantidad) > 0 && fecha !== ''}
      guardando={movement.isPending} error={movement.error}
      onSubmit={() => movement.mutate({ feedTypeId: tipoId, type: tipoMov, quantityKg: Number(cantidad), date: fecha, reason: motivo }, { onSuccess: onClose })}>
      <TipoSelect value={tipoId} onChange={setTipoId} />
      <label className={etiqueta}>Tipo
        <select value={tipoMov} onChange={(e) => setTipoMov(e.target.value as FeedMovementType)} className={campo}>
          {FEED_MOVEMENT_TYPES.filter((t) => t !== 'EXTERNAL_SALE').map((t) => <option key={t} value={t}>{MOVIMIENTO[t]}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Fecha<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Cantidad (kg)<NumeroInput min="0" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

function AsignacionModal({ onClose }: { onClose: () => void }) {
  const { assign } = useFeedMutations();
  const lotes = useFlockOptions();
  const [flockId, setFlockId] = useState('');
  const [tipoId, setTipoId] = useState('');
  const [desde, setDesde] = useState(getTodayDate());
  const [notas, setNotas] = useState('');
  return (
    <Modal titulo="Asignar alimento a un lote" onClose={onClose} puedeGuardar={flockId !== '' && tipoId !== '' && desde !== ''}
      guardando={assign.isPending} error={assign.error ?? lotes.error}
      onSubmit={() => assign.mutate({ flockId, feedTypeId: tipoId, effectiveFrom: desde, reason: notas }, { onSuccess: onClose })}>
      <label className={etiqueta}>Lote / galpón
        <select value={flockId} onChange={(e) => setFlockId(e.target.value)} className={campo}>
          <option value="">Elegir…</option>
          {(lotes.data ?? []).filter((f) => f.estado === 'ACTIVE').map((f) => <option key={f.id} value={f.id}>{f.shed_nombre} · ingreso {f.entry_date}</option>)}
        </select>
      </label>
      <TipoSelect value={tipoId} onChange={setTipoId} />
      <label className={etiqueta}>Vigente desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Notas (opcional)<input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} /></label>
    </Modal>
  );
}
