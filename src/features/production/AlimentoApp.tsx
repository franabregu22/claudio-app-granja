import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { FEED_MOVEMENT_TYPES, versionsEffectiveOn, type FeedMovementType } from '../../target/feed';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { FabricacionesHistorial } from './FabricacionesHistorial';
import {
  useConsumptionIntervals, useFeedMutations, useFeedTypes, useFlockFeed, useFlockOptions, useFormulaVersions,
} from './useProduction';

type Accion = 'fabricacion' | 'recuento' | 'movimiento' | 'asignacion';
const MOVIMIENTO: Record<FeedMovementType, string> = {
  EXTERNAL_SALE: 'Venta externa', LOSS: 'Pérdida', ADJUSTMENT_POSITIVE: 'Ajuste (+)', ADJUSTMENT_NEGATIVE: 'Ajuste (−)',
};
const kg = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('es-AR', { maximumFractionDigits: 1 })} kg`);

/**
 * Alimento (F27-E). An external feed sale (EXTERNAL_SALE) must reference its Pedido (PEDIDO_REQUIRED); that link is not
 * offered here yet, so the movement form offers loss and adjustments only. Manufacturing and physical counts: ADMIN and OPERATOR; movements (external sale, loss,
 * adjustments) and flock feed assignment: ADMIN only — the RPCs enforce it, the buttons only mirror it. Stock and
 * consumption are the count-to-count intervals of report_feed_consumption_interval, in kg as reported; no cost is
 * read and no inventory is balanced here.
 */
export function AlimentoApp() {
  const { rol } = useAuth();
  const tipos = useFeedTypes();
  const intervalos = useConsumptionIntervals();
  const asignaciones = useFlockFeed();
  const lotes = useFlockOptions();
  const [accion, setAccion] = useState<Accion | null>(null);
  const nombreTipo = (id: string) => (tipos.data ?? []).find((t) => t.id === id)?.nombre ?? '—';
  const nombreLote = (id: string) => (lotes.data ?? []).find((f) => f.id === id)?.shed_nombre ?? '—';
  const error = tipos.error ?? intervalos.error ?? asignaciones.error ?? lotes.error;
  const boton = 'text-sm px-3 py-2 rounded-lg font-medium';

  return (
    <div className="min-h-screen bg-[#FAF6EE] px-4 md:px-6 pt-6 pb-20 space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
        <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Alimento</h1>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setAccion('fabricacion')} className={`${boton} bg-amber-600 text-white hover:bg-amber-700`}>Registrar fabricación</button>
        <button onClick={() => setAccion('recuento')} className={`${boton} bg-amber-600 text-white hover:bg-amber-700`}>Registrar recuento de stock</button>
        {rol === 'ADMIN' && <button onClick={() => setAccion('movimiento')} className={`${boton} bg-white border border-[#E4DCC8] hover:bg-stone-50`}>Movimiento (pérdida / ajuste)</button>}
        {rol === 'ADMIN' && <button onClick={() => setAccion('asignacion')} className={`${boton} bg-white border border-[#E4DCC8] hover:bg-stone-50`}>Asignar alimento a un lote</button>}
      </div>
      {error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}

      <FabricacionesHistorial />

      <section>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Consumo entre recuentos</p>
        {intervalos.isLoading ? <p className="text-sm text-gray-500">Cargando…</p> : (intervalos.data ?? []).length === 0 ? (
          <p className="text-sm text-[#8A7A5C]">Hacen falta al menos dos recuentos de un mismo alimento para ver su consumo.</p>
        ) : (
          <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
            <table className="w-full text-xs md:text-sm">
              <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
                <tr>
                  <th className="px-3 py-2 text-left">Alimento</th><th className="px-3 py-2 text-left">Período</th>
                  <th className="px-3 py-2 text-right">Inicial</th><th className="px-3 py-2 text-right">Fabricado</th>
                  <th className="hidden md:table-cell px-3 py-2 text-right">Salidas / ajustes</th><th className="px-3 py-2 text-right">Final</th>
                  <th className="px-3 py-2 text-right bg-amber-100">Consumo</th><th className="hidden lg:table-cell px-3 py-2 text-right">Teórico</th>
                </tr>
              </thead>
              <tbody>
                {(intervalos.data ?? []).map((i) => (
                  <tr key={`${i.feed_type_id}-${i.business_date}`} className="border-b border-amber-100">
                    <td className="px-3 py-2">{i.feed_type_nombre}</td>
                    <td className="px-3 py-2">{i.opening_date} → {i.business_date}</td>
                    <td className="px-3 py-2 text-right">{kg(i.opening_kg)}</td>
                    <td className="px-3 py-2 text-right">{kg(i.manufactured_kg)}</td>
                    <td className="hidden md:table-cell px-3 py-2 text-right text-gray-600">
                      venta {kg(i.external_sale_kg)} · pérdida {kg(i.loss_kg)} · ajustes +{kg(i.adjustment_positive_kg)} / −{kg(i.adjustment_negative_kg)}
                    </td>
                    <td className="px-3 py-2 text-right">{kg(i.closing_kg)}</td>
                    <td className="px-3 py-2 text-right font-semibold bg-amber-100">{kg(i.internal_consumption_kg)}</td>
                    <td className="hidden lg:table-cell px-3 py-2 text-right text-gray-600">{kg(i.theoretical_kg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Alimento asignado por lote</p>
        {(asignaciones.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin asignaciones.</p> : (
          <div className="space-y-1 text-sm">
            {(asignaciones.data ?? []).map((a) => (
              <p key={a.id} className="text-gray-700">{nombreLote(a.flock_id)} · {nombreTipo(a.feed_type_id)} · desde {a.effective_from}{a.effective_to ? ` hasta ${a.effective_to}` : ' (vigente)'}</p>
            ))}
          </div>
        )}
      </section>

      {accion === 'fabricacion' && <FabricacionModal onClose={() => setAccion(null)} />}
      {accion === 'recuento' && <RecuentoModal onClose={() => setAccion(null)} />}
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

function FabricacionModal({ onClose }: { onClose: () => void }) {
  const { manufacturing } = useFeedMutations();
  const tipos = useFeedTypes();
  const versiones = useFormulaVersions();
  const [versionId, setVersionId] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [cantidad, setCantidad] = useState('');
  const [lote, setLote] = useState('');
  const [clave] = useState(() => `FAB-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const nombre = (id: string) => (tipos.data ?? []).find((t) => t.id === id)?.nombre ?? '—';
  // D-FEED-5: only the versions effective on the chosen date (ADR-013: at most one per feed type)
  const vigentes = versionsEffectiveOn(versiones.data ?? [], fecha);
  const elegida = vigentes.some((v) => v.id === versionId) ? versionId : '';
  return (
    <Modal titulo="Registrar fabricación" onClose={onClose} puedeGuardar={elegida !== '' && Number(cantidad) > 0 && fecha !== ''}
      guardando={manufacturing.isPending} error={manufacturing.error ?? versiones.error}
      onSubmit={() => manufacturing.mutate({ formulaVersionId: elegida, date: fecha, quantityKg: Number(cantidad), idempotencyKey: clave, batchNumber: lote },
        { onSuccess: onClose })}>
      <label className={etiqueta}>Fecha<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      {!versiones.isLoading && vigentes.length === 0 ? (
        <p className="text-sm text-amber-800">No hay fórmula vigente para esta fecha. Cargala en Administración → Alimento.</p>
      ) : (
        <label className={etiqueta}>Fórmula
          <select value={elegida} onChange={(e) => setVersionId(e.target.value)} className={campo}>
            <option value="">Elegir…</option>
            {vigentes.map((v) => <option key={v.id} value={v.id}>{nombre(v.feed_type_id)} · v{v.version}</option>)}
          </select>
        </label>
      )}
      <label className={etiqueta}>Cantidad (kg)<input type="number" min="0" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Nº de lote de fabricación (opcional)<input type="text" value={lote} onChange={(e) => setLote(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

function RecuentoModal({ onClose }: { onClose: () => void }) {
  const { count } = useFeedMutations();
  const [tipoId, setTipoId] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [cantidad, setCantidad] = useState('');
  const [notas, setNotas] = useState('');
  return (
    <Modal titulo="Recuento físico de stock" onClose={onClose} puedeGuardar={tipoId !== '' && cantidad !== '' && Number(cantidad) >= 0 && fecha !== ''}
      guardando={count.isPending} error={count.error}
      onSubmit={() => count.mutate({ feedTypeId: tipoId, date: fecha, quantityKg: Number(cantidad), reason: notas }, { onSuccess: onClose })}>
      <TipoSelect value={tipoId} onChange={setTipoId} />
      <label className={etiqueta}>Fecha<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Cantidad contada (kg)<input type="number" min="0" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Notas (opcional)<input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} /></label>
    </Modal>
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
      <label className={etiqueta}>Cantidad (kg)<input type="number" min="0" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={campo} /></label>
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
