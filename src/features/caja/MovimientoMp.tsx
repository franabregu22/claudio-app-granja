import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import type { FinancialAccountRow } from '../../target/masters';
import { allocateToClient, listReceipts } from '../../target/mp';
import { isMercadoPagoAccount, MP_ROUTE_BLOCKED_MESSAGE, MP_SOURCE_MISSING_MESSAGE, type MpCandidate } from '../../target/mpActivity';
import { getTodayDate } from '../../utils/dateUtils';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta } from './Modal';
import { useMpActivity, useMpPayoutMatches } from './useMpActivity';

/** True when the chosen account id is the Mercado Pago account. */
export function useEsCuentaMp(accountId: string): boolean {
  const cuentas = useFinancialAccounts();
  const a = (cuentas.data ?? []).find((x: FinancialAccountRow) => x.id === accountId);
  return Boolean(a && isMercadoPagoAccount(a));
}

/** The Mercado Pago account's report activity and payout matches (empty while the account is not chosen). */
export function useActividadMp(accountId: string, activo: boolean) {
  const id = activo ? accountId : '';
  const actividad = useMpActivity(id);
  const matches = useMpPayoutMatches(id);
  return { rows: actividad.data ?? [], matches: matches.data ?? new Map(), cargando: activo && (actividad.isLoading || matches.isLoading), error: actividad.error ?? matches.error };
}

/** Client receipts in Mercado Pago of the last 120 days (report_mp_receipt_status), only while the account is Mercado Pago. */
export function useCobrosMp(activo: boolean) {
  const hasta = getTodayDate();
  const d = new Date(`${hasta}T12:00:00`); d.setDate(d.getDate() - 120);
  const desde = d.toISOString().slice(0, 10);
  const q = useQuery({ queryKey: ['mp', 'receipts', { from: desde, to: hasta, axisA: null, axisB: null }], enabled: activo,
    queryFn: () => listReceipts(supabase, { from: desde, to: hasta }) });
  return { rows: q.data ?? [], cargando: activo && q.isLoading, error: q.error };
}

/** C1 from a manual "Registrar cobro" on Mercado Pago: mp_allocate_to_client on the chosen receipt (never register_collection). */
export function useAsignarCobroMp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Parameters<typeof allocateToClient>[1]) => allocateToClient(supabase, p),
    onSuccess: () => Promise.all([['mp'], ['commercial'], ['treasury'], ['customer-collections']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

/**
 * The Mercado Pago movement of a manual form. Amount, date and SOURCE_ID come from the movement; without a candidate the
 * form is blocked with the fixed message (the database refuses an MP posting without SOURCE_ID anyway: 0091).
 */
export function SelectorMovimientoMp({ titulo, candidatos, cargando, value, onChange }: {
  titulo: string; candidatos: readonly MpCandidate[]; cargando: boolean; value: string; onChange: (sourceId: string) => void;
}) {
  if (cargando) return <p className="text-sm text-gray-500">Buscando movimientos de Mercado Pago…</p>;
  if (candidatos.length === 0) return <BloqueoMp mensaje={MP_SOURCE_MISSING_MESSAGE} />;
  const elegido = candidatos.find((c) => c.sourceId === value);
  return (
    <div className="space-y-1">
      <label className={etiqueta}>{titulo}
        <select aria-label={titulo} value={value} onChange={(e) => onChange(e.target.value)} className={campo}>
          <option value="">Elegir movimiento…</option>
          {candidatos.map((c) => <option key={c.sourceId} value={c.sourceId}>{c.label}</option>)}
        </select>
      </label>
      <p className="text-xs text-gray-500">
        {elegido ? `Importe y fecha del movimiento: ${elegido.date} · $ ${elegido.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}. ` : ''}
        Importe, fecha y número de operación salen del movimiento de Mercado Pago.
      </p>
    </div>
  );
}

/** Fixed blocking notice for Mercado Pago in a manual form. */
export function BloqueoMp({ mensaje = MP_ROUTE_BLOCKED_MESSAGE }: { mensaje?: string }) {
  return <div role="alert" className="bg-amber-50 border border-amber-300 text-amber-900 px-3 py-2 rounded-lg text-sm">{mensaje}</div>;
}
