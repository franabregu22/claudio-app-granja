import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { mpOutflowCandidates } from '../../target/mpActivity';
import { listManagementEvents, registerManagementEvent, type ManagementEventRow, type ManagementEventType } from '../../target/pnl';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { BloqueoMp, SelectorMovimientoMp, useActividadMp, useEsCuentaMp } from '../caja/MovimientoMp';
import { useClassifyMp } from '../caja/useMpActivity';
import { useAllExpenseSubcategories, useExpenseGroups } from '../caja/useTreasury';
import { socios } from '../../target/expenseCategories';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';

/** User-facing names (D-FIN-1 / D-FIN-2). The backend types and the P&L lines are unchanged (ADR-004 D7–D9). */
export const EVENTO_LABEL: Record<ManagementEventType, string> = { RETIRO: 'Retiro de socios', RESERVA_INTERNA: 'Reserva interna' };
export const MANAGEMENT_EVENTS_KEY = ['pnl', 'events'];

export function useManagementEvents() {
  return useQuery({ queryKey: MANAGEMENT_EVENTS_KEY, queryFn: () => listManagementEvents(supabase) });
}

/**
 * One management event of a FIXED type through RPC 43 register_management_event (ADR-004 D9), unchanged:
 *   - RETIRO = "Retiro de socios": money leaves the chosen account; in the P&L it sits below the operating /
 *     reinvestment result (never an operating expense);
 *   - RESERVA_INTERNA: moves no money; it only separates result in the P&L.
 * A compensation (money returned / reserve released) points to an original of the same type.
 * Meta A (0091): a withdrawal from Mercado Pago is the Mercado Pago outflow chosen here, classified as "Retiro de socios"
 * (mp_classify_payout_outflow OWNER_WITHDRAWAL; amount and date from the movement). A return of money into Mercado Pago is
 * registered from Actividad Mercado Pago.
 */
export function EventoGestionModal({ tipo, onClose }: { tipo: ManagementEventType; onClose: () => void }) {
  const qc = useQueryClient();
  const eventos = useManagementEvents();
  const registrar = useMutation({
    mutationFn: (p: Parameters<typeof registerManagementEvent>[1]) => registerManagementEvent(supabase, p),
    onSuccess: () => Promise.all([['pnl'], ['treasury']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
  const cuentas = useFinancialAccounts();
  const [fecha, setFecha] = useState(getTodayDate());
  const [monto, setMonto] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [compensaId, setCompensaId] = useState('');
  const [motivo, setMotivo] = useState('');
  const [socioId, setSocioId] = useState('');   // ADR-024: optional (Santi / Fran / Padres)
  const grupos = useExpenseGroups();
  const subcategorias = useAllExpenseSubcategories();
  const listaSocios = socios(grupos.data ?? [], subcategorias.data ?? []);
  const [clave] = useState(() => `GEST-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const compensables = (eventos.data ?? []).filter((e: ManagementEventRow) => e.event_type === tipo && !e.compensates_event_id);
  const esMp = useEsCuentaMp(cuentaId) && tipo === 'RETIRO';
  const actividadMp = useActividadMp(cuentaId, esMp && !compensaId);
  const candidatosMp = mpOutflowCandidates(actividadMp.rows, actividadMp.matches);
  const [movimientoMp, setMovimientoMp] = useState('');
  const { outflow } = useClassifyMp();
  const puede = esMp ? !compensaId && candidatosMp.some((c) => c.sourceId === movimientoMp)
    : Number(monto) > 0 && fecha !== '' && motivo.trim() !== '' && (tipo !== 'RETIRO' || cuentaId !== '');
  return (
    <Modal titulo={`Registrar ${EVENTO_LABEL[tipo].toLowerCase()}`} onClose={onClose} puedeGuardar={puede} guardando={registrar.isPending || outflow.isPending}
      error={registrar.error ?? outflow.error ?? (esMp ? actividadMp.error : null) ?? cuentas.error ?? eventos.error} textoGuardar="Registrar"
      onSubmit={() => (esMp ? outflow.mutate({ sourceId: movimientoMp, classification: 'OWNER_WITHDRAWAL' }, { onSuccess: onClose }) : registrar.mutate({
        type: tipo, effectiveDate: fecha, amount: Number(monto), idempotencyKey: clave, reason: motivo.trim(),
        accountId: tipo === 'RETIRO' ? cuentaId : null, compensatesEventId: compensaId || null,
        socioCategoryId: tipo === 'RETIRO' && !compensaId ? socioId || null : null,
      }, { onSuccess: onClose }))}>
      {tipo === 'RETIRO' && (
        <label className={etiqueta}>Cuenta de la que sale el dinero
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
            <option value="">Elegir cuenta…</option>
            {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </label>
      )}
      {esMp && (compensaId ? <BloqueoMp /> : (
        <SelectorMovimientoMp titulo="Salida de Mercado Pago" candidatos={candidatosMp} cargando={actividadMp.cargando} value={movimientoMp} onChange={setMovimientoMp} />
      ))}
      {!esMp && <>
        <label className={etiqueta}>Fecha<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Monto<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
      </>}
      {compensables.length > 0 && (
        <label className={etiqueta}>{tipo === 'RETIRO' ? 'Devolución de un retiro anterior (opcional)' : 'Libera una reserva anterior (opcional)'}
          <select value={compensaId} onChange={(e) => setCompensaId(e.target.value)} className={campo}>
            <option value="">No</option>
            {compensables.map((e) => <option key={e.id} value={e.id}>{e.effective_date} · {formatoPesos(e.amount)}{e.reason ? ` · ${e.reason}` : ''}</option>)}
          </select>
        </label>
      )}
      {tipo === 'RETIRO' && !esMp && !compensaId && listaSocios.length > 0 && (
        <label className={etiqueta}>Socio (opcional)
          <select aria-label="Socio" value={socioId} onChange={(e) => setSocioId(e.target.value)} className={campo}>
            <option value="">Sin especificar</option>
            {listaSocios.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
        </label>
      )}
      {!esMp && <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>}
      <p className="text-xs text-gray-500">
        {tipo === 'RETIRO'
          ? 'El retiro de socios saca dinero de la cuenta elegida. No es un gasto: no cambia el resultado operativo y aparece en Finanzas debajo del resultado.'
          : 'Una reserva interna no mueve dinero: separa resultado en el estado de resultados.'}
      </p>
    </Modal>
  );
}
