import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import {
  OUTCOME_LABELS, R2_AVAILABILITY, RESOLUTIONS, RESOLUTION_LABELS, mapPayerToClient, requestRefetch, requeueConfigBlocked, resolveChargebackSignal,
  resolveMatch, unmapPayer, type ReportException, type Resolution,
} from '../../target/mp';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useClients } from '../caja/useTreasury';
import { MotivoModal } from './CobrosMP';
import { useDeliveryHealth, useMappingLookup, useMPAction, useReportExceptions, useSignalLookup } from './useMP';

const HEALTH: [string, string][] = [
  ['received_count', 'Recibidas'], ['processing_count', 'Procesando'], ['fetched_count', 'Consultadas'], ['signal_recorded_count', 'Avisos registrados'],
  ['failed_retryable_count', 'Reintentando'], ['failed_permanent_count', 'Fallidas (definitivas)'], ['config_blocked_count', 'Bloqueadas por credencial'],
  ['unsupported_count', 'Tópicos no soportados'],
];
const boton = 'text-sm px-3 py-1.5 rounded-lg bg-amber-100 text-amber-900 hover:bg-amber-200';

/** S-E banner (dashboard): shown only when the view says review is required or the credential is failing. */
export function BannerSaludMP() {
  const h = useDeliveryHealth();
  if (!h.data) return null;
  return (
    <>
      {h.data.auth_configuration_error && (
        <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">Credencial de Mercado Pago inválida o sin permisos — las consultas están en espera</div>
      )}
      {h.data.review_required && !h.data.auth_configuration_error && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 rounded text-sm">Las notificaciones de Mercado Pago requieren revisión: ver “Notificaciones”.</div>
      )}
    </>
  );
}

/** S-E / S-G / S-H: delivery health (counts as the view reports them), recovery (S5, S6) and chargeback signals (S7). */
export function SaludMP() {
  const h = useDeliveryHealth();
  const senales = useSignalLookup();
  const [accion, setAccion] = useState<'requeue' | 'refetch' | { signal: string; resource: string } | null>(null);
  if (h.isLoading) return <p className="text-sm text-gray-500">Cargando…</p>;
  if (h.error) return <p className="text-sm text-red-700">{errorMessage(h.error)}</p>;
  const d = h.data;
  if (!d) return <p className="text-sm text-[#8A7A5C]">Sin acceso</p>;
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        {HEALTH.map(([k, l]) => <p key={k}>{l} <b>{String((d as Record<string, unknown>)[k] ?? 0)}</b></p>)}
        {Number(d.key_conflicts) > 0 && <p className="text-red-700">Notificaciones en conflicto (integración) <b>{String(d.key_conflicts)}</b></p>}
        {Number(d.unresolved_chargeback_signals) > 0 && <p className="text-red-700">Avisos de contracargo sin resolver <b>{String(d.unresolved_chargeback_signals)}</b></p>}
      </div>
      <section className="space-y-2">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Recuperación de consultas</p>
        <div className="flex flex-wrap gap-2">
          {d.auth_configuration_error && <button onClick={() => setAccion('requeue')} className={boton}>Reintentar tras corregir la credencial</button>}
          <button onClick={() => setAccion('refetch')} className={boton}>Volver a consultar un pago</button>
          <button disabled title={`Disponible desde el Step 19 (${R2_AVAILABILITY})`} className="text-sm px-3 py-1.5 rounded-lg bg-stone-100 text-stone-400 cursor-not-allowed">
            Crear desde reporte (no disponible todavía)
          </button>
        </div>
      </section>
      <section>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Avisos de contracargo</p>
        {senales.isLoading ? <p className="text-sm text-gray-500">Cargando…</p> : (senales.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin avisos pendientes.</p> : (
          <div className="space-y-2">
            {(senales.data ?? []).map((s) => (
              <div key={s.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 flex items-center justify-between text-sm">
                <span>Contracargo {s.resource_id} · recibido {s.received_at.slice(0, 16).replace('T', ' ')}</span>
                <button onClick={() => setAccion({ signal: s.id, resource: s.resource_id })} className={boton}>Resolver</button>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-500 mt-1">El aviso es solo una señal: resolverlo no aplica ningún movimiento de dinero.</p>
      </section>
      {accion === 'requeue' && <MotivoModal titulo="Reintentar consultas bloqueadas" fn={requeueConfigBlocked} params={{}} onClose={() => setAccion(null)} />}
      {accion === 'refetch' && <RefetchModal onClose={() => setAccion(null)} />}
      {accion && typeof accion === 'object' && <SenalModal deliveryId={accion.signal} resource={accion.resource} onClose={() => setAccion(null)} />}
    </div>
  );
}

function RefetchModal({ onClose }: { onClose: () => void }) {
  const accion = useMPAction(requestRefetch);
  const [pago, setPago] = useState('');
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo="Volver a consultar un pago" onClose={onClose} puedeGuardar={/^\d+$/.test(pago) && motivo.trim() !== ''} guardando={accion.isPending} error={accion.error}
      textoGuardar="Consultar" onSubmit={() => accion.mutate({ paymentId: pago, reason: motivo.trim() }, { onSuccess: onClose })}>
      <label className={etiqueta}>Número de pago de Mercado Pago<input type="text" inputMode="numeric" value={pago} onChange={(e) => setPago(e.target.value.trim())} className={campo} /></label>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

function SenalModal({ deliveryId, resource, onClose }: { deliveryId: string; resource: string; onClose: () => void }) {
  const accion = useMPAction(resolveChargebackSignal);
  const [resolucion, setResolucion] = useState<'LINKED' | 'DISMISSED'>('LINKED');
  const [pago, setPago] = useState('');
  const [motivo, setMotivo] = useState('');
  const puede = motivo.trim() !== '' && (resolucion === 'DISMISSED' || /^\d+$/.test(pago));
  return (
    <Modal titulo={`Resolver aviso de contracargo ${resource}`} onClose={onClose} puedeGuardar={puede} guardando={accion.isPending} error={accion.error} textoGuardar="Resolver"
      onSubmit={() => accion.mutate({ deliveryId, resolution: resolucion, paymentId: resolucion === 'LINKED' ? pago : null, reason: motivo.trim() }, { onSuccess: onClose })}>
      <div className="grid grid-cols-2 gap-2">
        {(['LINKED', 'DISMISSED'] as const).map((r) => (
          <button key={r} type="button" onClick={() => setResolucion(r)}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${resolucion === r ? 'bg-amber-600 text-white' : 'bg-stone-100 text-gray-700'}`}>
            {r === 'LINKED' ? 'Vincular a un pago' : 'Descartar'}
          </button>
        ))}
      </div>
      {resolucion === 'LINKED' && (
        <label className={etiqueta}>Número de pago de Mercado Pago<input type="text" inputMode="numeric" value={pago} onChange={(e) => setPago(e.target.value.trim())} className={campo} /></label>
      )}
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

/** S-F: every unresolved report exception (each is a work item) and R1. */
export function ExcepcionesMP() {
  const ex = useReportExceptions();
  const [resolviendo, setResolviendo] = useState<ReportException | null>(null);
  if (ex.isLoading) return <p className="text-sm text-gray-500">Cargando…</p>;
  if (ex.error) return <p className="text-sm text-red-700">{errorMessage(ex.error)}</p>;
  if ((ex.data ?? []).length === 0) return <p className="text-sm text-[#8A7A5C]">Sin excepciones abiertas</p>;
  return (
    <div className="space-y-2">
      {(ex.data ?? []).map((e) => (
        <div key={e.match_id} className="bg-white rounded-lg border border-red-200 p-3 text-sm flex items-center justify-between gap-2">
          <span>
            <b className="text-red-800">{OUTCOME_LABELS[e.outcome] ?? e.outcome}</b>
            {e.resource_id && <> · {e.resource_type} {e.resource_id}</>}
            {e.coverage_from && <> · reporte {e.coverage_from} → {e.coverage_to}</>}
            <span className="text-[#8A7A5C]"> · {e.created_at.slice(0, 10)}</span>
          </span>
          <button onClick={() => setResolviendo(e)} className={boton}>Resolver</button>
        </div>
      ))}
      {resolviendo && <ResolverModal ex={resolviendo} onClose={() => setResolviendo(null)} />}
    </div>
  );
}

function ResolverModal({ ex, onClose }: { ex: ReportException; onClose: () => void }) {
  const accion = useMPAction(resolveMatch);
  const [resolucion, setResolucion] = useState<Resolution>('EXPLAINED');
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={`Resolver: ${OUTCOME_LABELS[ex.outcome] ?? ex.outcome}`} onClose={onClose} puedeGuardar={motivo.trim() !== ''} guardando={accion.isPending} error={accion.error}
      textoGuardar="Resolver" onSubmit={() => accion.mutate({ matchId: ex.match_id, resolution: resolucion, reason: motivo.trim() }, { onSuccess: onClose })}>
      <label className={etiqueta}>Resolución
        <select value={resolucion} onChange={(e) => setResolucion(e.target.value as Resolution)} className={campo}>
          {RESOLUTIONS.map((r) => <option key={r} value={r}>{RESOLUTION_LABELS[r]}</option>)}
        </select>
      </label>
      {resolucion === 'CORRECTED' && <p className="text-xs text-gray-500">“Corregida” exige una corrección de tesorería registrada antes.</p>}
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

/** S-I: active payer → client mappings (lookup L-C7, identifiers only), C6 and C7. */
export function PagadoresMP() {
  const mapeos = useMappingLookup();
  const clientes = useClients();
  const [nuevo, setNuevo] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);
  const nombre = (id: string) => (clientes.data ?? []).find((c) => c.id === id)?.nombre ?? '—';
  return (
    <div className="space-y-3">
      <button onClick={() => setNuevo(true)} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Mapear pagador a cliente</button>
      {mapeos.isLoading ? <p className="text-sm text-gray-500">Cargando…</p> : mapeos.error ? <p className="text-sm text-red-700">{errorMessage(mapeos.error)}</p>
        : (mapeos.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin mapeos activos.</p> : (mapeos.data ?? []).map((m) => (
          <div key={m.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 flex items-center justify-between text-sm">
            <span>Pagador {m.mp_payer_id} → <b>{nombre(m.cliente_id)}</b></span>
            <button onClick={() => setQuitando(m.id)} className={boton}>Quitar mapeo</button>
          </div>
        ))}
      {nuevo && <MapearModal onClose={() => setNuevo(false)} />}
      {quitando && <MotivoModal titulo="Quitar mapeo" fn={unmapPayer} params={{ mappingId: quitando }} onClose={() => setQuitando(null)} />}
    </div>
  );
}

function MapearModal({ onClose }: { onClose: () => void }) {
  const accion = useMPAction(mapPayerToClient);
  const clientes = useClients();
  const [pagador, setPagador] = useState('');
  const [clienteId, setClienteId] = useState('');
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo="Mapear pagador a cliente" onClose={onClose} puedeGuardar={/^\d+$/.test(pagador) && clienteId !== '' && motivo.trim() !== ''}
      guardando={accion.isPending} error={accion.error ?? clientes.error} textoGuardar="Mapear"
      onSubmit={() => accion.mutate({ payerId: pagador, clienteId, reason: motivo.trim() }, { onSuccess: onClose })}>
      <label className={etiqueta}>Id de pagador de Mercado Pago<input type="text" inputMode="numeric" value={pagador} onChange={(e) => setPagador(e.target.value.trim())} className={campo} /></label>
      <label className={etiqueta}>Cliente
        <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} className={campo}>
          <option value="">Elegir cliente…</option>
          {(clientes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}
