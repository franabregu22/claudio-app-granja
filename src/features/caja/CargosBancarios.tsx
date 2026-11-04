import { useMemo, useState } from 'react';
import {
  CHARGE_KIND_EFFECT, CHARGE_KIND_LABEL, type ChargeProposal, REVIEW_LABEL, summarizeCharges,
} from '../../target/bankCharges';
import { importe, reconciliationErrorMessage } from '../../target/bankReconciliation';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { Modal } from './Modal';
import { useChargeProposals, useReconciliationMutations } from './useReconciliation';

/**
 * Conciliación → Cargos bancarios detectados (ADR-018 §23, 0114). The server proposes the post-cut debits it recognises (debits /
 * credits tax, fees, eCheq charges, IVA on fees); the user chooses which to confirm. Confirming books each line as its own operation
 * and match, all in one transaction. Lines without a proposal (cheques, fiscal instalments, transfers, unknown concepts) are only
 * listed for review: nothing here records them.
 */
export function CargosBancarios({ accountId }: { accountId: string }) {
  const q = useChargeProposals(accountId);
  const filas = q.data ?? [];
  const propuestas = filas.filter((r) => r.status === 'PROPOSED');
  const registrados = filas.filter((r) => r.status === 'RECORDED');   // 0116: already recorded (e.g. with its transfer): matched, never booked again
  const revisar = filas.filter((r) => r.status !== 'PROPOSED' && r.status !== 'RECORDED');
  const [excluidas, setExcluidas] = useState<Set<number>>(new Set());
  const [confirmando, setConfirmando] = useState(false);
  const [hecho, setHecho] = useState<string | null>(null);
  const elegidas = propuestas.filter((r) => !excluidas.has(r.statement_line_id));
  const resumen = useMemo(() => summarizeCharges(elegidas), [elegidas]);
  const alternar = (id: number) => setExcluidas((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  if (q.isLoading) return <p className="text-sm text-gray-500">Buscando cargos bancarios...</p>;
  if (q.error) return <p className="text-sm text-red-700">{reconciliationErrorMessage(q.error)}</p>;
  if (filas.length === 0 && !hecho) return null;

  return (
    <section className="bg-white rounded-lg border border-[#E4DCC8] p-4 space-y-3" aria-label="Cargos bancarios detectados">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Cargos bancarios detectados</p>
        <p className="text-xs text-[#8A7A5C]">Se reconocen por su descripción. Nada se registra hasta que confirmes.</p>
      </div>
      {hecho && <p className="text-sm bg-green-50 border border-green-200 text-green-900 rounded-lg px-3 py-2" role="status">{hecho}</p>}
      {propuestas.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cargos para confirmar.</p> : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={excluidas.size === 0} onChange={() => setExcluidas(excluidas.size === 0 ? new Set(propuestas.map((r) => r.statement_line_id)) : new Set())} />
              Todas ({propuestas.length})
            </label>
            <button type="button" disabled={resumen.count === 0} onClick={() => { setHecho(null); setConfirmando(true); }}
              className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50">
              Confirmar {resumen.count} · {importe(resumen.total)}
            </button>
          </div>
          <ul className="divide-y divide-stone-100 border border-[#E4DCC8] rounded-lg" aria-label="Propuestas">
            {propuestas.map((r) => (
              <li key={r.statement_line_id}>
                <label className="flex items-start gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-stone-50">
                  <input type="checkbox" className="mt-1" checked={!excluidas.has(r.statement_line_id)} onChange={() => alternar(r.statement_line_id)} aria-label={`Línea ${r.statement_line_id}`} />
                  <span className="flex-1 min-w-0 md:grid md:grid-cols-[6rem_1fr_14rem] md:gap-3">
                    <span className="block text-xs md:text-sm text-[#8A7A5C]">{formatearFechaLocal(r.value_date)}</span>
                    <span className="block truncate" title={r.description_raw}>{r.description_raw}</span>
                    <span className="block text-xs md:text-sm text-[#6B5D45]">{r.label}{r.kind === 'BANK_FEE' && r.category_name ? ` · ${r.category_name}` : ''}</span>
                  </span>
                  <span className="shrink-0 md:w-32 text-right font-medium text-red-700 whitespace-nowrap">{importe(r.signed_amount, true)}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {registrados.length > 0 && <YaRegistrados filas={registrados} />}
      {revisar.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-[#A8552E]">Para revisar, sin propuesta ({revisar.length} · {importe(revisar.reduce((t, r) => t + r.signed_amount, 0), true)})</summary>
          <p className="text-xs text-[#8A7A5C] mt-1">Cheques, cuotas fiscales, transferencias y conceptos sin regla no se registran desde acá.</p>
          <ul className="mt-2 space-y-1">
            {revisar.map((r) => (
              <li key={r.statement_line_id} className="flex flex-wrap items-center gap-2 border border-stone-200 rounded px-2 py-1">
                <span className="text-xs text-[#8A7A5C] w-20">{formatearFechaLocal(r.value_date)}</span>
                <span className="flex-1 min-w-0 truncate" title={r.description_raw}>{r.description_raw}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-stone-100 text-stone-700">{REVIEW_LABEL[r.status as keyof typeof REVIEW_LABEL]}</span>
                <span className="font-medium whitespace-nowrap">{importe(r.signed_amount, true)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {confirmando && <ConfirmarModal accountId={accountId} lineas={elegidas} onClose={() => setConfirmando(false)} onRechazo={() => q.refetch()}
        onHecho={(t) => { setConfirmando(false); setExcluidas(new Set()); setHecho(t); }} />}
    </section>
  );
}

/**
 * 0116 — a tax line whose charge is already recorded (by hand with its transfer, before the statement): it is matched to that posting
 * (one click when exactly one recorded charge qualifies), never booked again. More than one candidate: matched by hand below.
 */
function YaRegistrados({ filas }: { filas: ChargeProposal[] }) {
  const { match } = useReconciliationMutations();
  return (
    <div className="space-y-1" aria-label="Cargos ya registrados">
      <p className="text-sm font-medium text-[#3D3424]">Ya registrados antes del extracto ({filas.length})</p>
      <p className="text-xs text-[#8A7A5C]">El impuesto ya figura en el ERP (por ejemplo, cargado con su transferencia): se concilia con ese registro y no se descuenta otra vez.</p>
      <ul className="space-y-1">
        {filas.map((r) => (
          <li key={r.statement_line_id} className="flex flex-wrap items-center gap-2 border border-sky-200 bg-sky-50/40 rounded px-2 py-1 text-sm">
            <span className="text-xs text-[#8A7A5C] w-20">{formatearFechaLocal(r.value_date)}</span>
            <span className="flex-1 min-w-0 truncate" title={r.description_raw}>{r.description_raw}</span>
            <span className="font-medium whitespace-nowrap">{importe(r.signed_amount, true)}</span>
            {r.recorded_count === 1 && r.recorded_posting_id ? (
              <button type="button" disabled={match.isPending}
                onClick={() => match.mutate({ statementLineId: r.statement_line_id, postingId: r.recorded_posting_id as number, reason: 'Impuesto ya registrado' })}
                className="text-xs px-2 py-0.5 rounded border border-sky-300 bg-white text-sky-900 hover:bg-sky-50 disabled:opacity-50">
                {match.isPending ? 'Conciliando...' : 'Conciliar con el registrado'}
              </button>
            ) : <span className="text-xs text-[#8A7A5C]">{r.recorded_count} registros posibles: conciliá a mano abajo</span>}
          </li>
        ))}
      </ul>
      {match.error ? <p className="text-xs text-red-700">{reconciliationErrorMessage(match.error)}</p> : null}
    </div>
  );
}

function ConfirmarModal({ accountId, lineas, onClose, onHecho, onRechazo }: {
  accountId: string; lineas: ChargeProposal[]; onClose: () => void; onHecho: (texto: string) => void; onRechazo: () => void;
}) {
  const { bookCharges } = useReconciliationMutations();
  const [clave] = useState(() => `CARGOS-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const r = summarizeCharges(lineas);
  return (
    <Modal titulo="Confirmar cargos bancarios" onClose={onClose} puedeGuardar={r.count > 0} guardando={bookCharges.isPending} error={null}
      textoGuardar={`Registrar ${r.count} · ${importe(r.total)}`}
      onSubmit={() => bookCharges.mutate({ accountId, lines: lineas, idempotencyKey: clave }, {
        onSuccess: (res) => onHecho(`${res.replayed ? 'Ya estaban registradas' : 'Registradas'} ${res.booked} línea(s) por ${importe(res.total)}: cada una con su operación y su conciliación.`),
        onError: onRechazo,   // nothing was booked; the list is re-read so a stale proposal shows its new state
      })}>
      <p className="text-xs text-[#6B5D45]">Cada línea queda como su propia operación, conciliada con su línea del extracto. Todo o nada: si una falla, no se registra ninguna.</p>
      <div className="space-y-1 text-sm" aria-label="Totales por categoría">
        {r.groups.map((g) => (
          <div key={g.key}>
            <p className="flex justify-between gap-2"><span>{g.title} ({g.count})</span><b>{importe(g.total)}</b></p>
            <p className="text-xs text-[#8A7A5C]">{CHARGE_KIND_EFFECT[g.kind]}</p>
          </div>
        ))}
        <p className="flex justify-between gap-2 border-t border-[#E4DCC8] pt-1"><span>Total</span><b>{importe(r.total)}</b></p>
      </div>
      <ul className="max-h-56 overflow-y-auto text-xs border border-[#E4DCC8] rounded divide-y divide-stone-100" aria-label="Líneas a registrar">
        {lineas.map((l) => (
          <li key={l.statement_line_id} className="flex justify-between gap-2 px-2 py-1">
            <span className="truncate">{formatearFechaLocal(l.value_date)} · {l.description_raw}</span>
            <span className="whitespace-nowrap">{l.kind ? CHARGE_KIND_LABEL[l.kind] : ''} · {importe(l.signed_amount, true)}</span>
          </li>
        ))}
      </ul>
      {bookCharges.error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{reconciliationErrorMessage(bookCharges.error)}</div> : null}
    </Modal>
  );
}
