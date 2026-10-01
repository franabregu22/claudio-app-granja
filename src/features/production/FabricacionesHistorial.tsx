import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { shiftDate } from '../../target/production';
import { userLabel, type ManufacturingRecord, type ManufacturingVersion } from '../../target/feed';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useFormulaComposition, useManufacturing, useProfileNames, useRectifyManufacturing } from './useProduction';

const fechaHora = (d: string, ts: string) =>
  `${d.slice(8, 10)}/${d.slice(5, 7)} ${new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
const kg = (v: number) => `${v.toLocaleString('es-AR', { maximumFractionDigits: 3 })} kg`;

/**
 * D-FEED-7 / D-FEED-9 (ADR-014): read-only manufacturing history. Every version shows the composition of its EXACT
 * stored formula version (feed_formula_line_safe by formula_version_id), never the current recipe. Authors resolve
 * within the caller's permissions ("Vos" / "Otro usuario" for OPERATOR). A current record can be rectified by ADMIN,
 * or by the OPERATOR who registered it (RPC 49; the backend enforces it, the button only mirrors it).
 */
export function FabricacionesHistorial() {
  const { user, rol } = useAuth();
  const hoy = getTodayDate();
  const [desde, setDesde] = useState(shiftDate(hoy, -30));
  const [hasta, setHasta] = useState(hoy);
  const registros = useManufacturing(desde, hasta);
  const perfiles = useProfileNames();
  const [abierta, setAbierta] = useState<string | null>(null);
  const [rectificando, setRectificando] = useState<ManufacturingRecord | null>(null);
  const yo = user?.id ?? null;
  const autor = (id: string | null) => userLabel(id, yo, perfiles.data ?? new Map());
  const puedeRectificar = (r: ManufacturingRecord) => rol === 'ADMIN' || (rol === 'OPERATOR' && r.author === yo);

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Fabricaciones</p>
        <span className="flex items-center gap-2 text-sm">
          <input type="date" aria-label="Desde" value={desde} onChange={(e) => setDesde(e.target.value)} className="border border-gray-300 rounded px-2 py-1" />
          <span>a</span>
          <input type="date" aria-label="Hasta" value={hasta} onChange={(e) => setHasta(e.target.value)} className="border border-gray-300 rounded px-2 py-1" />
        </span>
      </div>
      {registros.isLoading ? <p className="text-sm text-gray-500">Cargando fabricaciones…</p> : registros.error ? (
        <p className="text-sm text-red-700">{errorMessage(registros.error)}</p>
      ) : (registros.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay fabricaciones en el período.</p> : (
        <div className="space-y-2">
          {(registros.data ?? []).map((r) => (
            <div key={r.current.id} className="bg-white rounded-lg border border-[#E4DCC8]">
              <button onClick={() => setAbierta(abierta === r.current.id ? null : r.current.id)} className="w-full flex items-center justify-between gap-2 p-3 text-left text-sm">
                <span className="flex items-center gap-2">
                  <ChevronDown className={`w-4 h-4 transition ${abierta === r.current.id ? 'rotate-180' : ''}`} />
                  <span>{fechaHora(r.current.manufacturing_date, r.current.created_at)} · {r.current.feed_type_nombre} · v{r.current.formula_version} · {kg(r.current.quantity_kg)} · {autor(r.author)}</span>
                  {r.history.length > 0 && <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">Rectificada</span>}
                </span>
              </button>
              {abierta === r.current.id && (
                <div className="px-4 pb-3 border-t border-[#E4DCC8] bg-[#FAF6EE] text-sm space-y-1">
                  <Detalle v={r.current} autor={autor} />
                  {r.history.length > 0 && (
                    <details className="text-xs text-gray-600">
                      <summary className="cursor-pointer">Versiones anteriores ({r.history.length})</summary>
                      {r.history.map((h) => <div key={h.id} className="mt-1 pl-2 border-l border-gray-300"><Detalle v={h} autor={autor} /></div>)}
                    </details>
                  )}
                  {puedeRectificar(r) && (
                    <button onClick={() => setRectificando(r)} className="mt-2 text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200">Rectificar</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {rectificando && <RectificarFabricacion registro={rectificando} onClose={() => setRectificando(null)} />}
    </section>
  );
}

/** One version: its own exact formula version and that version's composition. */
function Detalle({ v, autor }: { v: ManufacturingVersion; autor: (id: string | null) => string }) {
  const comp = useFormulaComposition([v.formula_version_id]);
  return (
    <div className="pt-1 space-y-0.5">
      <p>Fórmula: {v.feed_type_nombre} · versión {v.formula_version}</p>
      {comp.isLoading ? <p className="text-xs text-gray-500">Cargando composición…</p>
        : (comp.data ?? []).map((l) => <p key={l.ingredient_id} className="text-xs pl-2">{l.ingredient_name} — {kg(l.quantity_kg)}</p>)}
      <p>Cantidad: {kg(v.quantity_kg)}{v.batch_number ? ` · Lote ${v.batch_number}` : ''}</p>
      <p className="text-xs text-gray-600">Registrada {new Date(v.created_at).toLocaleString('es-AR')} por {autor(v.created_by)}</p>
      {v.rectification_reason && <p className="text-xs text-gray-600">Motivo de la rectificación: {v.rectification_reason}</p>}
    </div>
  );
}

/** ADR-014 RPC 49: a correction, never an edit — the original stays as a prior version. */
function RectificarFabricacion({ registro, onClose }: { registro: ManufacturingRecord; onClose: () => void }) {
  const rectificar = useRectifyManufacturing();
  const [cantidad, setCantidad] = useState(String(registro.current.quantity_kg));
  const [lote, setLote] = useState(registro.current.batch_number ?? '');
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `FAB-R-${crypto.randomUUID()}`);   // idempotency: one per opened form
  return (
    <Modal titulo="Rectificar fabricación" onClose={onClose} textoGuardar="Registrar corrección"
      puedeGuardar={Number(cantidad) > 0 && motivo.trim() !== ''} guardando={rectificar.isPending} error={rectificar.error}
      onSubmit={() => rectificar.mutate({ idempotencyKey: clave, manufacturingId: registro.current.id, quantityKg: Number(cantidad), reason: motivo, batchNumber: lote },
        { onSuccess: onClose })}>
      <p className="text-sm">{registro.current.manufacturing_date} · {registro.current.feed_type_nombre} · v{registro.current.formula_version}</p>
      <label className={etiqueta}>Cantidad (kg)<input type="number" min="0" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Nº de lote de fabricación (opcional)<input type="text" value={lote} onChange={(e) => setLote(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Motivo de la corrección<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-500">Se registra una corrección: la fabricación original queda guardada como versión anterior y los reportes usan la versión corregida.</p>
    </Modal>
  );
}
