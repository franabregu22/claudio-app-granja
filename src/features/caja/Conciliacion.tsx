import { useState } from 'react';
import {
  activeCutover, type AnchorCandidate, canMatch, canReverse, CUTOVER_CLASSES, CUTOVER_LABEL, type CutoverClass, type CutoverRow,
  DEFAULT_FILTERS, importe, type LineFilters, RECONCILIATION_LABEL, reconciliationErrorMessage, type ReconciliationStatus, type StatementLine,
} from '../../target/bankReconciliation';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from './Modal';
import { useStatementAccounts } from './useBankStatements';
import {
  useAccountFormat, useAnchorCandidates, useCutovers, useMatchDetail, usePostingCandidates, useReconciliationMutations, useStatementLines,
} from './useReconciliation';

const CLASE_ESTILO: Record<CutoverClass, string> = {
  CUTOVER_UNRESOLVED: 'bg-stone-200 text-stone-700', PRE_CUTOVER: 'bg-blue-100 text-blue-800',
  POST_CUTOVER: 'bg-amber-100 text-amber-900', CUTOVER_AMBIGUOUS_DAY: 'bg-purple-100 text-purple-800',
};
const ESTADO_ESTILO: Record<ReconciliationStatus, string> = { MATCHED: 'bg-green-100 text-green-800', UNMATCHED: 'bg-red-50 text-red-700' };
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const Error_ = ({ e }: { e: unknown }) => e
  ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{reconciliationErrorMessage(e)}</div> : null;

/**
 * Conciliación (ADR-018, ADMIN): statement lines of one bank account with the cut classification derived by
 * fin_statement_line_status, manual 1:1 match against financial_posting, reversal, and the account's statement cut.
 * Only the actions the contract allows are offered; the RPCs of 0075 remain the authority.
 */
export function Conciliacion() {
  const cuentas = useStatementAccounts();
  const [cuentaId, setCuentaId] = useState('');
  const [filtros, setFiltros] = useState<Omit<LineFilters, 'accountId'>>(DEFAULT_FILTERS);
  const [busqueda, setBusqueda] = useState('');
  const [conciliar, setConciliar] = useState<StatementLine | null>(null);
  const [revertir, setRevertir] = useState<StatementLine | null>(null);
  const lineas = useStatementLines({ accountId: cuentaId, ...filtros, search: busqueda });
  const set = (p: Partial<typeof filtros>) => setFiltros((f) => ({ ...f, ...p }));

  return (
    <div className="space-y-6">
      <section className="bg-white rounded-lg border border-[#E4DCC8] p-4">
        <label className={`${etiqueta} max-w-md`}>Cuenta bancaria
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo} aria-label="Cuenta bancaria">
            <option value="">{cuentas.isLoading ? 'Cargando cuentas…' : 'Elegir cuenta…'}</option>
            {(cuentas.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        {cuentas.error ? <p className="text-sm text-red-700 mt-2">{reconciliationErrorMessage(cuentas.error)}</p> : null}
        {!cuentaId && <p className="text-sm text-[#8A7A5C] mt-2">Elegí una cuenta para ver sus líneas de extracto y su corte.</p>}
      </section>

      {cuentaId && <BloqueCorte accountId={cuentaId} />}

      {cuentaId && (
        <section>
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Líneas del extracto</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3 bg-white rounded-lg border border-[#E4DCC8] p-3">
            <label className={etiqueta}>Corte
              <select value={filtros.cutover} onChange={(e) => set({ cutover: e.target.value as LineFilters['cutover'] })} className={campo} aria-label="Filtro de corte">
                <option value="ALL">Todas</option>
                {CUTOVER_CLASSES.map((c) => <option key={c} value={c}>{CUTOVER_LABEL[c]}</option>)}
              </select>
            </label>
            <label className={etiqueta}>Conciliación
              <select value={filtros.reconciliation} onChange={(e) => set({ reconciliation: e.target.value as LineFilters['reconciliation'] })} className={campo}
                aria-label="Filtro de conciliación">
                <option value="ALL">Todas</option>
                <option value="UNMATCHED">{RECONCILIATION_LABEL.UNMATCHED}</option>
                <option value="MATCHED">{RECONCILIATION_LABEL.MATCHED}</option>
              </select>
            </label>
            <label className={etiqueta}>Desde
              <input type="date" value={filtros.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} className={campo} />
            </label>
            <label className={etiqueta}>Hasta
              <input type="date" value={filtros.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} className={campo} />
            </label>
            <label className={`${etiqueta} col-span-2 md:col-span-1`}>Buscar
              <input type="search" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} className={campo} placeholder="Descripción o referencia" />
            </label>
          </div>
          {lineas.isLoading ? <p className="text-sm text-gray-500">Cargando líneas...</p>
            : lineas.error ? <p className="text-sm text-red-700">{reconciliationErrorMessage(lineas.error)}</p>
              : (lineas.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay líneas con esos filtros.</p>
                : <TablaLineas lineas={lineas.data ?? []} onConciliar={setConciliar} onRevertir={setRevertir} />}
          {(lineas.data ?? []).length > 0 && <p className="text-xs text-[#8A7A5C] mt-2">Se muestran hasta 200 líneas, las más recientes primero.</p>}
        </section>
      )}

      {conciliar && <ConciliarModal linea={conciliar} onClose={() => setConciliar(null)} />}
      {revertir && <RevertirModal linea={revertir} onClose={() => setRevertir(null)} />}
    </div>
  );
}

function TablaLineas({ lineas, onConciliar, onRevertir }: {
  lineas: StatementLine[]; onConciliar: (l: StatementLine) => void; onRevertir: (l: StatementLine) => void;
}) {
  return (
    <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
      <table className="w-full text-sm" aria-label="Líneas del extracto">
        <thead>
          <tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
            <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Descripción</th><th className="px-3 py-2">Referencia</th>
            <th className="px-3 py-2 text-right">Importe</th><th className="px-3 py-2 text-right">Saldo informado por banco</th>
            <th className="px-3 py-2">Corte</th><th className="px-3 py-2">Conciliación</th><th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {lineas.map((l) => (
            <tr key={l.statement_line_id} className="border-b border-stone-100 last:border-0">
              <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(l.value_date)}</td>
              <td className="px-3 py-2 max-w-[18rem] truncate" title={l.description_raw}>{l.description_raw}</td>
              <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{l.bank_reference || '—'}</td>
              <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${l.signed_amount < 0 ? 'text-red-700' : 'text-green-800'}`}>{importe(l.signed_amount, true)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap text-[#8A7A5C]">{importe(l.running_balance)}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {l.cutover_classification
                  ? <span className={`text-xs px-2 py-0.5 rounded ${CLASE_ESTILO[l.cutover_classification]}`}>{CUTOVER_LABEL[l.cutover_classification]}</span>
                  : <span className="text-xs text-[#8A7A5C]">Sin clasificar</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <span className={`text-xs px-2 py-0.5 rounded ${ESTADO_ESTILO[l.reconciliation_status]}`}>{RECONCILIATION_LABEL[l.reconciliation_status]}</span>
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-right">
                {canMatch(l) && <button onClick={() => onConciliar(l)} className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Conciliar</button>}
                {canReverse(l) && <button onClick={() => onRevertir(l)} className="text-xs px-2 py-1 rounded bg-red-50 text-red-700 hover:bg-red-100">Revertir conciliación</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConciliarModal({ linea, onClose }: { linea: StatementLine; onClose: () => void }) {
  const candidatos = usePostingCandidates(linea);
  const { match } = useReconciliationMutations();
  const [postingId, setPostingId] = useState<number | null>(null);
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo="Conciliar línea del extracto" onClose={onClose} puedeGuardar={postingId !== null} guardando={match.isPending} textoGuardar="Conciliar"
      onSubmit={() => postingId !== null && match.mutate({ statementLineId: linea.statement_line_id, postingId, reason: motivo }, { onSuccess: onClose })}>
      <div className="text-sm bg-stone-50 rounded-lg p-3">
        <p className="font-medium text-[#2C2419]">{linea.description_raw}</p>
        <p className="text-[#8A7A5C]">{formatearFechaLocal(linea.value_date)} · {linea.bank_reference || 'sin referencia'} · <b>{importe(linea.signed_amount, true)}</b></p>
      </div>
      <p className="text-xs text-gray-500">Movimientos de la misma cuenta con el mismo importe exacto. La cercanía de fecha es solo una ayuda: elegí uno.</p>
      {candidatos.isLoading ? <p className="text-sm text-gray-500">Buscando movimientos...</p>
        : candidatos.error ? <Error_ e={candidatos.error} />
          : (candidatos.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay movimientos de esta cuenta con ese importe exacto.</p>
            : (
              <div className="space-y-2 max-h-72 overflow-y-auto" role="radiogroup" aria-label="Movimientos candidatos">
                {(candidatos.data ?? []).map((c) => (
                  <label key={c.id} className={`flex items-start gap-2 p-2 rounded-lg border text-sm ${c.already_matched ? 'opacity-50 border-stone-200' : postingId === c.id ? 'border-amber-500 bg-amber-50' : 'border-stone-200 hover:bg-stone-50'}`}>
                    <input type="radio" name="posting" className="mt-1" disabled={c.already_matched} checked={postingId === c.id} onChange={() => setPostingId(c.id)} aria-label={`Movimiento ${c.id}`} />
                    <span className="flex-1">
                      <span className="flex justify-between gap-2"><span className="font-medium">{formatearFechaLocal(c.effective_date)}</span><span className="font-medium">{importe(c.signed_amount, true)}</span></span>
                      <span className="block text-[#8A7A5C]">{c.operation_type}{c.external_ref ? ` · ${c.external_ref}` : ''}{c.reason ? ` · ${c.reason}` : ''}</span>
                      <span className="block text-xs text-[#8A7A5C]">
                        {c.already_matched ? 'Ya conciliado con otra línea' : c.days_from_line === 0 ? 'Misma fecha' : `${c.days_from_line} día(s) de diferencia`}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
      <label className={etiqueta}>Motivo (opcional)
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} maxLength={200} />
      </label>
      <Error_ e={match.error} />
    </Modal>
  );
}

function RevertirModal({ linea, onClose }: { linea: StatementLine; onClose: () => void }) {
  const detalle = useMatchDetail(linea.active_match_id);
  const { reverse } = useReconciliationMutations();
  const [motivo, setMotivo] = useState('');
  const d = detalle.data;
  return (
    <Modal titulo="Revertir conciliación" onClose={onClose} puedeGuardar={motivo.trim() !== '' && linea.active_match_id !== null} guardando={reverse.isPending}
      textoGuardar="Revertir conciliación"
      onSubmit={() => reverse.mutate({ matchId: linea.active_match_id as number, reason: motivo }, { onSuccess: onClose })}>
      <div className="text-sm bg-stone-50 rounded-lg p-3 space-y-1">
        <p className="font-medium text-[#2C2419]">{linea.description_raw} · {importe(linea.signed_amount, true)}</p>
        {detalle.isLoading ? <p className="text-gray-500">Cargando conciliación...</p> : d ? (
          <>
            <p className="text-[#4A4338]">Movimiento: {d.posting_date ? formatearFechaLocal(d.posting_date) : '—'} · {importe(d.posting_amount, true)}</p>
            <p className="text-[#4A4338]">Operación: {d.operation_type ?? '—'}{d.external_ref ? ` · ${d.external_ref}` : ''}</p>
            <p className="text-[#8A7A5C]">Conciliado el {fechaHora(d.matched_at)}{d.reason ? ` · ${d.reason}` : ''}</p>
          </>
        ) : <Error_ e={detalle.error} />}
      </div>
      <label className={etiqueta}>Motivo (obligatorio)
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} maxLength={200} aria-label="Motivo de la reversión" />
      </label>
      <p className="text-xs text-gray-500">La conciliación queda en el historial como revertida; la línea vuelve a “Sin conciliar”.</p>
      <Error_ e={reverse.error} />
    </Modal>
  );
}

function BloqueCorte({ accountId }: { accountId: string }) {
  const cortes = useCutovers(accountId);
  const [editando, setEditando] = useState(false);
  const activo = activeCutover(cortes.data ?? []);
  const historial = (cortes.data ?? []).filter((c) => c.superseded_at !== null);
  return (
    <section className="bg-white rounded-lg border border-[#E4DCC8] p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Corte del extracto</p>
        {!cortes.isLoading && !cortes.error && (
          <button onClick={() => setEditando(true)} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">
            {activo ? 'Cambiar corte' : 'Definir corte'}
          </button>
        )}
      </div>
      {cortes.isLoading ? <p className="text-sm text-gray-500">Cargando corte...</p>
        : cortes.error ? <p className="text-sm text-red-700">{reconciliationErrorMessage(cortes.error)}</p>
          : !activo ? <p className="text-sm text-[#4A4338]"><span className="text-xs px-2 py-0.5 rounded bg-stone-200 text-stone-700 mr-2">Corte pendiente</span>
              Hasta definir el corte, ninguna línea se puede conciliar.</p>
            : <DatosCorte c={activo} />}
      {historial.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-[#A8552E]">Cortes anteriores ({historial.length})</summary>
          <div className="space-y-2 mt-2">
            {historial.map((c) => (
              <div key={c.id} className="border border-stone-200 rounded-lg p-2 opacity-80">
                <DatosCorte c={c} />
                <p className="text-xs text-[#8A7A5C] mt-1">Reemplazado el {fechaHora(c.superseded_at as string)} · Motivo: {c.supersede_reason}</p>
              </div>
            ))}
          </div>
        </details>
      )}
      {editando && <CorteModal accountId={accountId} activo={activo} onClose={() => setEditando(false)} />}
    </section>
  );
}

function DatosCorte({ c }: { c: CutoverRow }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
      <p><span className="text-[#8A7A5C]">Línea ancla: </span>{c.anchor ? `${formatearFechaLocal(c.anchor.value_date)} · ${c.anchor.description_raw}` : `#${c.cutoff_statement_line_id}`}</p>
      <p><span className="text-[#8A7A5C]">Saldo informado por banco en la ancla: </span>{importe(c.anchor?.running_balance ?? null)}</p>
      <p><span className="text-[#8A7A5C]">Saldo inicial reconocido: </span><b>{importe(c.opening_balance)}</b></p>
      <p><span className="text-[#8A7A5C]">Definido el: </span>{fechaHora(c.resolved_at)}</p>
      <p className="md:col-span-2"><span className="text-[#8A7A5C]">Evidencia: </span>{c.evidence_note}</p>
    </div>
  );
}

function CorteModal({ accountId, activo, onClose }: { accountId: string; activo: CutoverRow | null; onClose: () => void }) {
  const candidatas = useAnchorCandidates(accountId);
  const formato = useAccountFormat(accountId);
  const { resolveCutover } = useReconciliationMutations();
  const [ancla, setAncla] = useState<AnchorCandidate | null>(null);
  const [evidencia, setEvidencia] = useState('');
  const [motivo, setMotivo] = useState('');
  const patagonia = formato.data === 'PATAGONIA_STATEMENT_PDF_V1';
  const puede = ancla !== null && evidencia.trim() !== '' && (!activo || motivo.trim() !== '');
  return (
    <Modal titulo={activo ? 'Cambiar corte del extracto' : 'Definir corte del extracto'} onClose={onClose} puedeGuardar={puede}
      guardando={resolveCutover.isPending} textoGuardar={activo ? 'Cambiar corte' : 'Definir corte'}
      onSubmit={() => ancla && resolveCutover.mutate({ accountId, anchor: ancla, evidenceNote: evidencia, hasActiveCut: activo !== null, supersedeReason: motivo },
        { onSuccess: onClose })}>
      <p className="text-xs text-gray-500">
        Elegí la línea del extracto hasta la cual los movimientos ya están incluidos en el saldo inicial. El saldo inicial reconocido es
        exactamente el saldo informado por el banco en esa línea.{activo ? ' El corte actual queda en el historial.' : ''}
      </p>
      {candidatas.isLoading ? <p className="text-sm text-gray-500">Cargando líneas...</p>
        : candidatas.error ? <Error_ e={candidatas.error} />
          : (candidatas.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay líneas con saldo informado por el banco.</p>
            : (
              <div className="space-y-1 max-h-60 overflow-y-auto" role="radiogroup" aria-label="Línea ancla">
                {(candidatas.data ?? []).map((a) => {
                  const ambigua = patagonia && a.same_day_lines > 0;
                  return (
                    <label key={a.statement_line_id} className={`flex items-start gap-2 p-2 rounded-lg border text-sm ${ancla?.statement_line_id === a.statement_line_id ? 'border-amber-500 bg-amber-50' : 'border-stone-200 hover:bg-stone-50'}`}>
                      <input type="radio" name="ancla" className="mt-1" checked={ancla?.statement_line_id === a.statement_line_id} onChange={() => setAncla(a)}
                        aria-label={`Ancla ${a.statement_line_id}`} />
                      <span className="flex-1">
                        <span className="flex justify-between gap-2"><span>{formatearFechaLocal(a.value_date)} · {a.description_raw}</span><span>{importe(a.signed_amount, true)}</span></span>
                        <span className="block text-xs text-[#8A7A5C]">Saldo informado por banco: {importe(a.running_balance)}</span>
                        {ambigua && <span className="block text-xs text-purple-800">Hay otros movimientos ese día: el sistema no aceptará esta línea como corte.</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
      <label className={etiqueta}>Saldo inicial reconocido
        <input type="text" readOnly value={ancla ? importe(ancla.running_balance) : ''} placeholder="Se toma de la línea elegida" className={`${campo} bg-stone-100`}
          aria-label="Saldo inicial reconocido" />
      </label>
      <label className={etiqueta}>Evidencia / nota (obligatoria)
        <input type="text" value={evidencia} onChange={(e) => setEvidencia(e.target.value)} className={campo} maxLength={300} aria-label="Evidencia" />
      </label>
      {activo && (
        <label className={etiqueta}>Motivo del cambio de corte (obligatorio)
          <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} maxLength={300} aria-label="Motivo del cambio de corte" />
        </label>
      )}
      <Error_ e={resolveCutover.error} />
    </Modal>
  );
}
