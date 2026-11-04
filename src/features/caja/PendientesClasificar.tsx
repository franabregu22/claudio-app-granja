import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { isMercadoPagoAccount, type MpActivityRow, type MpPayoutMatch } from '../../target/mpActivity';
import {
  DESTINATION_STATUS_LABEL, HISTORICAL_ACTION, whatsappNoteText, maskedAccount, PENDING_KIND_LABEL, TECHNICAL_ISSUE_LABEL, type TechnicalRow,
} from '../../target/pendingClassification';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { ClasificarSalida, DestinoRetiro } from './AccionesMp';
import {
  useMpPayoutMatches, useMpWhatsappNotes, usePendingBySource, usePurchaseMpLinks, useRetryProvisional, useSettlePurchaseMp, useTechnicalReview,
} from './useMpActivity';
import { Comprobantes } from './Comprobantes';
import { useDocumentLinks } from './useInvoicePayments';
import { type PurchaseMpLinkRow, samePendingAmount } from '../../target/purchaseMpLink';

const hora = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : '');

/** The Mercado Pago account id (the payout destination proposal is read for it). */
function useMpAccountId(): string {
  const cuentas = useFinancialAccounts();
  return (cuentas.data ?? []).find((a) => isMercadoPagoAccount(a))?.id ?? '';
}

/**
 * Caja → Movimientos → Por resolver → Pendientes de clasificar (0116): the pending outflows are rows of the movement list (their
 * action is AccionPendienteMp); what is not a movement row stays here as a notice: purchases already recorded as paid with Mercado
 * Pago whose movement is still to link (Lote 4) and the technical exceptions.
 */
export function AvisosPendientesMp() {
  const tecnicos = useTechnicalReview();
  return (
    <div className="space-y-4">
      <GastosMpPendientes />
      <RevisionTecnica filas={tecnicos.data ?? []} cargando={tecnicos.isLoading} error={tecnicos.error} />
    </div>
  );
}

/**
 * Lote 4 (0111, ADR-021 §2.3(c)): purchases paid with Mercado Pago and ALREADY recorded (P&L + IVA, e.g. from WhatsApp) whose
 * movement is still to link. The user picks the real outflow (pending outflows of the same comparable gross are listed, never
 * chosen automatically); the link writes only the payment side, on the movement's date — no second purchase, IVA or outflow.
 */
function GastosMpPendientes() {
  const q = usePurchaseMpLinks();
  const filas = (q.data ?? []).filter((f) => f.status === 'PENDIENTE_VINCULACION_MP');
  if (q.isLoading || (!q.error && filas.length === 0)) return null;
  return (
    <section className="space-y-2" aria-label="Gastos pagados con Mercado Pago pendientes de vincular">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-[#3D3424]">Gastos registrados pagados con Mercado Pago, movimiento pendiente de vincular: {filas.length}</p>
        <p className="text-xs text-[#6B5D45]">Ya figuran en resultados (y su IVA). Vincular su movimiento solo registra el pago, sin otra compra ni otra salida de dinero.</p>
      </div>
      {q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p> : (
        <ul className="space-y-2">{filas.map((f) => <FilaGastoMp key={f.purchase_root_id} f={f} />)}</ul>
      )}
    </section>
  );
}

function FilaGastoMp({ f }: { f: PurchaseMpLinkRow }) {
  const vincular = useSettlePurchaseMp();
  const [origen, setOrigen] = useState('');
  const [clave] = useState(() => `PURCHASE-MP-${crypto.randomUUID()}`);   // idempotency: one per opened row
  const candidatos = f.candidates ?? [];
  const elegido = candidatos.find((c) => c.source_id === origen);
  return (
    <li className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {f.origin_code && <span className="font-semibold">{f.origin_code}</span>}
        <span>{f.concept ?? 'Gasto'}</span>
        <span className="text-[#8A7A5C]">{f.category_name ?? 'sin categoría'} · {formatearFechaLocal(f.economic_date)}{f.fiscal_document_id ? ' · con factura' : ''}</span>
        <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">MP pendiente de vincular · {f.age_days} día(s)</span>
        <span className="flex-1" />
        <span className="font-bold">{formatoPesos(f.amount_total)}</span>
      </div>
      {candidatos.length === 0 ? (
        <p className="text-xs text-[#8A7A5C]">Todavía no hay un egreso de Mercado Pago pendiente por ese importe. Aparece cuando se importe el movimiento.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select value={origen} onChange={(e) => setOrigen(e.target.value)} aria-label={`Movimiento de Mercado Pago para ${f.origin_code ?? f.concept ?? 'el gasto'}`}
            className="border border-[#E4DCC8] rounded px-2 py-1 bg-white text-sm">
            <option value="">Elegir movimiento…</option>
            {candidatos.map((c) => <option key={c.source_id} value={c.source_id}>Op {c.source_id} · {formatearFechaLocal(c.date)} · {formatoPesos(c.amount)}</option>)}
          </select>
          <button type="button" disabled={!origen || vincular.isPending}
            onClick={() => vincular.mutate({ purchaseId: f.purchase_id, sourceId: origen, idempotencyKey: clave, reason: 'Vinculación manual desde Pendientes de clasificar' })}
            className="text-xs px-3 py-1 rounded bg-[#A8552E] text-white hover:bg-[#8F4626] disabled:opacity-50">Vincular</button>
          {elegido && elegido.date !== f.economic_date && (
            <span className="text-xs text-[#8A7A5C]">El gasto conserva su fecha ({formatearFechaLocal(f.economic_date)}); el pago queda con la del movimiento ({formatearFechaLocal(elegido.date)}).</span>
          )}
        </div>
      )}
      {vincular.error && <p className="text-xs text-red-700">{errorMessage(vincular.error)}</p>}
    </li>
  );
}

export function Paginador({ pagina, paginas, total, onCambiar }: { pagina: number; paginas: number; total: number; onCambiar: (p: number) => void }) {
  if (paginas <= 1) return <p className="text-xs text-[#8A7A5C]">{total} en total</p>;
  return (
    <div className="flex items-center gap-2 text-xs text-[#6B5D45]" role="navigation" aria-label="Paginación">
      <button type="button" disabled={pagina === 0} onClick={() => onCambiar(pagina - 1)} className="px-2 py-0.5 rounded border border-[#E4DCC8] disabled:opacity-40">Anterior</button>
      <span>Página {pagina + 1} de {paginas} · {total} en total</span>
      <button type="button" disabled={pagina + 1 >= paginas} onClick={() => onCambiar(pagina + 1)} className="px-2 py-0.5 rounded border border-[#E4DCC8] disabled:opacity-40">Siguiente</button>
    </div>
  );
}

/**
 * 0116 — the action of a pending outflow inside its Caja → Movimientos row, read by SOURCE_ID: a current outflow is classified through
 * the existing routes (outbound: Clasificar salida; payout: its destination and Confirmar transferencia); a historical one shows its
 * destination status and no action yet. Nothing here moves money: the outflow is already in the balance.
 */
export function AccionPendienteMp({ sourceId }: { sourceId: string }) {
  const q = usePendingBySource(sourceId);
  const r = q.data;
  const actual = r && !r.is_historical ? [r.source_id] : [];
  const notas = useMpWhatsappNotes(actual);
  const docs = useDocumentLinks('MP_PENDING_OUTFLOW', actual);   // ADR-025 stage 4
  const mpId = useMpAccountId();
  const coincidencias = useMpPayoutMatches(r?.kind === 'PAYOUT' ? mpId : '');
  const matches: ReadonlyMap<string, MpPayoutMatch> = coincidencias.data ?? new Map();
  const gastosMp = usePurchaseMpLinks();
  if (q.isLoading) return <p className="text-xs text-gray-500">Buscando el pendiente...</p>;
  if (q.error) return <p className="text-xs text-red-700">{errorMessage(q.error)}</p>;
  if (!r) return <p className="text-xs text-green-800">Ya clasificado.</p>;
  const nota = notas.data?.get(r.source_id);
  const doc = docs.data?.get(r.source_id);
  const actividad = { description: r.description, source_id: r.source_id, coverage_status: 'PENDING_CLASSIFICATION' } as MpActivityRow;
  const posibles = r.is_historical ? [] : samePendingAmount(gastosMp.data ?? [], r.economic_amount);
  const destino = r.destination_status ? DESTINATION_STATUS_LABEL[r.destination_status] : null;
  const cuenta = r.matched_account_name ?? maskedAccount(r.destination_last4);
  return (
    <div className="space-y-1 text-sm" aria-label="Clasificación pendiente">
      <p>
        {PENDING_KIND_LABEL[r.kind]} · Nº Mercado Pago {r.source_id} · {formatearFechaLocal(r.business_date)} {hora(r.occurred_at)}
        {r.is_historical && <span className="text-[#8A7A5C]"> · histórico</span>}
        {r.charges_amount !== 0 && <span className="text-[#8A7A5C]"> · {formatoPesos(r.economic_amount)} + impuesto {formatoPesos(Math.abs(r.charges_amount))}</span>}
        {destino && <span className="text-[#8A7A5C]"> · Destino: {destino}{cuenta ? ` · ${cuenta}` : ''}</span>}
      </p>
      {nota && <p className="text-xs text-[#2C5E3A]" title={`Confirmado por WhatsApp el ${formatearFechaLocal(nota.confirmed_at.slice(0, 10))}; no generó otro movimiento`}>{whatsappNoteText(nota)}</p>}
      {doc && <Comprobantes docs={doc} />}
      {r.is_historical ? <p className="text-xs text-[#8A7A5C]">{HISTORICAL_ACTION}</p> : (
        <div>
          {r.kind === 'OUTBOUND' && <ClasificarSalida sourceId={r.source_id} conceptoInicial={nota?.concept} gastosMpPendientes={posibles} />}
          {r.kind === 'PAYOUT' && <DestinoRetiro r={actividad} matches={matches} />}
        </div>
      )}
    </div>
  );
}

/** Technical exceptions: an outflow whose provisional could not be posted (retry) or a report row in error. */
function RevisionTecnica({ filas, cargando, error }: { filas: TechnicalRow[]; cargando: boolean; error: unknown }) {
  const reintentar = useRetryProvisional();
  if (cargando) return null;
  if (error) return <p className="text-sm text-red-700">{errorMessage(error)}</p>;
  if (filas.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Revisión técnica">
      <p className="text-xs font-semibold text-red-800 uppercase tracking-wide">Revisión técnica ({filas.length})</p>
      <p className="text-xs text-[#8A7A5C]">Movimientos del reporte que no se pudieron registrar. Mientras existan, el día no figura como conciliado y el período no se puede cerrar.</p>
      <ul className="space-y-1">
        {filas.map((t) => (
          <li key={`${t.issue}:${t.source_id}:${t.description}`} className="bg-white border border-red-200 rounded-lg px-3 py-2 text-sm flex flex-wrap items-center gap-2">
            <span className="font-medium text-red-800">{TECHNICAL_ISSUE_LABEL[t.issue]}</span>
            <span>{formatearFechaLocal(t.business_date)}</span>
            <span className="text-[#8A7A5C]">{t.source_id}</span>
            {t.amount !== null && <span>{formatoPesos(t.amount)}</span>}
            {t.review_code && <span className="text-xs text-[#8A7A5C]">{t.review_code}</span>}
            {t.issue === 'UNPOSTED_OUTFLOW' && (
              <button type="button" disabled={reintentar.isPending} onClick={() => reintentar.mutate(t.source_id)}
                className="text-xs px-2 py-0.5 rounded border border-red-300 bg-white text-red-800 hover:bg-red-50 disabled:opacity-50">
                {reintentar.isPending ? 'Reintentando...' : 'Reintentar registro'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {reintentar.error && <p className="text-xs text-red-700">{errorMessage(reintentar.error)}</p>}
    </section>
  );
}
