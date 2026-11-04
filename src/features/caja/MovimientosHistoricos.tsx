import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { importe } from '../../target/bankReconciliation';
import { errorMessage } from '../../target/messages';
import {
  type BankLineRow, type ListRow, movementAccounts, movementAmount, MOVEMENT_KIND_LABEL, MOVEMENT_PAGE, movementNote, movementSign, type MovementFilter,
  type MovementKind, type MovementRow, pendingHasScope, PENDING_FILTER_LABEL, PENDING_FILTER_REQUIRED, pendingMpSource, type PendingFilter, type PendingScopeFilter,
  rowKey, rowStatusLabel, rowStatusTone,
} from '../../target/movementHistory';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { AccionEntrada, IngresosSinAplicar } from './EntradasSinVincular';
import { AccionGastoSinClasificar } from './GastosSinClasificar';
import { AccionPendienteMp, AvisosPendientesMp, Paginador } from './PendientesClasificar';
import { useProfileEmails } from './useUnclassified';
import { useMovementList } from './useTreasury';

const campo = 'border border-[#E4DCC8] rounded px-2 py-1 text-sm bg-white w-full';
const etiqueta = 'text-xs text-[#8A7A5C] min-w-0';
const VACIO = { from: '', to: '', kind: '', search: '' };
const TONO = { IN: 'text-green-800', OUT: 'text-red-700', NEUTRAL: 'text-[#2C2419]' };
const ESTADO = { action: 'bg-amber-100 text-amber-900', done: 'bg-green-100 text-green-800', neutral: 'bg-stone-100 text-stone-600' };
const chip = 'inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border';
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ALCANCES: { id: PendingScopeFilter | ''; label: string }[] = [{ id: 'CURRENT', label: 'Actuales' }, { id: 'HISTORICAL', label: 'Históricos' }, { id: '', label: 'Todos' }];
/** The scope each indicator counts: Pendientes de clasificar counts current + historical; Entradas sin vincular, the current ones. */
const ALCANCE_INICIAL: Record<PendingFilter, PendingScopeFilter | ''> = { MP_CLASIFICAR: '', GASTO_SIN_CLASIFICAR: '', ENTRADA_SIN_VINCULAR: 'CURRENT' };

/**
 * Caja → Movimientos → Movimientos históricos (0116; the unified history of 0113). One list: every financial operation once with its
 * state (registered, reconciled with the bank / Mercado Pago, or still to reconcile / classify) and its evidence in the detail, plus
 * the bank statement lines after the cut with no match (bank evidence still to resolve; a matched line is shown inside its operation,
 * never twice). The account cards and the Por resolver indicators are filters of this same list. Period, account, kind, search,
 * pending filter, page and total are the server's: nothing is downloaded to filter. Money moves only through the row actions, which
 * are the existing routes.
 */
export function MovimientosHistoricos({ cuentas, cuentaId, onCuenta, pendiente, onPendiente, onIrAExtractos }: {
  cuentas: { id: string; nombre: string }[]; cuentaId: string; onCuenta: (id: string) => void;
  pendiente: PendingFilter | null; onPendiente: (p: PendingFilter | null) => void; onIrAExtractos?: () => void;
}) {
  const [borrador, setBorrador] = useState(VACIO);
  const [aplicado, setAplicado] = useState(VACIO);
  const [alcances, setAlcances] = useState<Partial<Record<PendingFilter, PendingScopeFilter | ''>>>({});
  const alcance = pendiente ? alcances[pendiente] ?? ALCANCE_INICIAL[pendiente] : '';
  const filtro: MovementFilter = {
    from: aplicado.from || undefined, to: aplicado.to || undefined, kind: (aplicado.kind || undefined) as MovementKind | undefined, search: aplicado.search.trim() || undefined,
    accountId: cuentaId || undefined, pending: pendiente ?? undefined, scope: pendiente && pendingHasScope(pendiente) ? alcance || undefined : undefined,
  };
  // any filter change goes back to the first page and closes the open row
  const firma = JSON.stringify(filtro);
  const [pag, setPag] = useState({ firma, n: 0, abierta: null as string | null });
  const pagina = pag.firma === firma ? pag.n : 0;
  const abierta = pag.firma === firma ? pag.abierta : null;
  const q = useMovementList(filtro, pagina);
  const filas = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const set = (p: Partial<typeof VACIO>) => setBorrador((b) => ({ ...b, ...p }));
  const rango = borrador.from !== '' && borrador.to !== '' && borrador.from > borrador.to;
  const hayFiltro = Object.values(borrador).some((v) => v !== '') || Object.values(aplicado).some((v) => v !== '') || cuentaId !== '' || pendiente !== null;
  const limpiar = () => { setBorrador(VACIO); setAplicado(VACIO); onCuenta(''); onPendiente(null); };
  const cuentaNombre = cuentas.find((c) => c.id === cuentaId)?.nombre;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Movimientos históricos</p>
        <p className="text-xs text-[#8A7A5C]">Tocá una cuenta o un indicador para filtrar esta lista.</p>
      </div>
      {(cuentaId || pendiente) && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Filtros activos">
          {cuentaId && (
            <button type="button" onClick={() => onCuenta('')} className={`${chip} bg-amber-50 border-amber-300 text-amber-900`} aria-label="Ver todas las cuentas">
              Cuenta: {cuentaNombre ?? '—'} <X className="w-3 h-3" />
            </button>
          )}
          {pendiente && (
            <button type="button" onClick={() => onPendiente(null)} aria-label="Quitar el filtro por resolver"
              className={`${chip} ${PENDING_FILTER_REQUIRED[pendiente] ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-sky-50 border-sky-300 text-sky-900'}`}>
              {PENDING_FILTER_LABEL[pendiente]} · {PENDING_FILTER_REQUIRED[pendiente] ? 'requiere acción' : 'opcional'} <X className="w-3 h-3" />
            </button>
          )}
          {pendiente && pendingHasScope(pendiente) && (
            <div className="flex gap-1" role="group" aria-label="Alcance">
              {ALCANCES.map((a) => (
                <button key={a.id || 'all'} type="button" aria-pressed={alcance === a.id} onClick={() => setAlcances((s) => ({ ...s, [pendiente]: a.id }))}
                  className={`text-xs px-2 py-1 rounded border ${alcance === a.id ? 'bg-[#3D3424] text-white border-[#3D3424]' : 'bg-white border-[#E4DCC8]'}`}>{a.label}</button>
              ))}
            </div>
          )}
          {cuentaId && <button type="button" onClick={() => onCuenta('')} className="text-xs text-[#A8552E] hover:underline">Todas las cuentas</button>}
        </div>
      )}
      {pendiente === 'MP_CLASIFICAR' && <AvisosPendientesMp />}
      {pendiente === 'ENTRADA_SIN_VINCULAR' && <IngresosSinAplicar />}
      <form className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end bg-white rounded-lg border border-[#E4DCC8] p-3" aria-label="Filtros del historial"
        onSubmit={(e) => { e.preventDefault(); if (!rango) setAplicado(borrador); }}>
        <label className={etiqueta}>Desde<input type="date" value={borrador.from} onChange={(e) => set({ from: e.target.value })} className={campo} /></label>
        <label className={etiqueta}>Hasta<input type="date" value={borrador.to} onChange={(e) => set({ to: e.target.value })} className={campo} /></label>
        <label className={etiqueta}>Cuenta
          <select value={cuentaId} onChange={(e) => onCuenta(e.target.value)} className={campo}>
            <option value="">Todas</option>
            {cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        <label className={etiqueta}>Tipo
          <select value={borrador.kind} onChange={(e) => set({ kind: e.target.value })} className={campo}>
            <option value="">Todos</option>
            {(Object.keys(MOVEMENT_KIND_LABEL) as MovementKind[]).map((k) => <option key={k} value={k}>{MOVEMENT_KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className={`${etiqueta} col-span-2`}>Buscar
          <input type="search" value={borrador.search} maxLength={100} onChange={(e) => set({ search: e.target.value })} className={campo} placeholder="Concepto, referencia o importe" />
        </label>
        <div className="col-span-2 md:col-span-1 flex gap-2">
          <button type="submit" disabled={rango} className="flex-1 text-sm px-3 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">Filtrar</button>
          {hayFiltro && <button type="button" onClick={limpiar} className="text-sm px-2 py-1 rounded-lg border border-[#E4DCC8] bg-white hover:bg-stone-50">Limpiar</button>}
        </div>
        {rango && <p className="col-span-2 md:col-span-7 text-xs text-red-700">La fecha Desde no puede ser posterior a Hasta.</p>}
      </form>
      {!pendiente && (q.data?.linesTotal ?? 0) > 0 && aplicado.kind !== 'SIN_VINCULAR' && (
        <p className="text-xs text-[#6B5D45]">
          {q.data?.linesTotal} movimiento(s) bancario(s) sin vincular en esta vista.{' '}
          <button type="button" className="text-[#A8552E] hover:underline" onClick={() => { const b = { ...borrador, kind: 'SIN_VINCULAR' }; setBorrador(b); setAplicado(b); }}>Ver solo esos</button>
        </p>
      )}
      {q.isLoading ? <p className="text-sm text-gray-500">Cargando movimientos...</p>
        : q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p>
          : filas.length === 0 ? <p className="text-sm text-[#8A7A5C]">{pendiente ? 'No hay pendientes con esos filtros.' : 'No hay movimientos con esos filtros.'}</p> : (
            <ul className="bg-white rounded-lg border border-[#E4DCC8] divide-y divide-stone-100" aria-label="Movimientos">
              {filas.map((r) => {
                const k = rowKey(r);
                return <Fila key={k} r={r} abierta={abierta === k} onToggle={() => setPag({ firma, n: pagina, abierta: abierta === k ? null : k })} onIrAExtractos={onIrAExtractos} />;
              })}
            </ul>
          )}
      {filas.length > 0 && <Paginador pagina={pagina} paginas={Math.max(1, Math.ceil(total / MOVEMENT_PAGE))} total={total} onCambiar={(p) => setPag({ firma, n: p, abierta: null })} />}
    </div>
  );
}

function Estado({ r }: { r: ListRow }) {
  return <span className={`text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${ESTADO[rowStatusTone(r.status)]}`}>{rowStatusLabel(r)}</span>;
}

function Fila({ r, abierta, onToggle, onIrAExtractos }: { r: ListRow; abierta: boolean; onToggle: () => void; onIrAExtractos?: () => void }) {
  const linea = r.row_type === 'LINE';
  const signo = linea ? (r.signed_amount < 0 ? 'OUT' : 'IN') : movementSign(r);
  const nota = linea ? r.description_raw : movementNote(r);
  return (
    <li className={linea ? 'bg-amber-50/30' : undefined}>
      <button type="button" onClick={onToggle} aria-expanded={abierta} className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-stone-50">
        <ChevronDown className={`w-4 h-4 shrink-0 text-[#8A7A5C] transition ${abierta ? 'rotate-180' : ''}`} />
        <span className="flex-1 min-w-0 md:grid md:grid-cols-[6rem_1fr_11rem_9rem] md:gap-3 md:items-center">
          <span className="block text-xs md:text-sm text-[#8A7A5C] md:text-inherit whitespace-nowrap">{formatearFechaLocal(r.effective_date)}</span>
          <span className="block min-w-0">
            <span className="block text-sm font-medium text-[#2C2419] truncate">{r.label}</span>
            {nota && <span className="block text-xs text-[#8A7A5C] truncate" title={nota}>{nota}</span>}
          </span>
          <span className="block text-xs md:text-sm text-[#6B5D45] truncate">{linea ? r.account_name : movementAccounts(r)}</span>
          <span className="block mt-0.5 md:mt-0"><Estado r={r} /></span>
        </span>
        <span className={`shrink-0 md:w-36 text-right text-sm font-semibold whitespace-nowrap ${TONO[signo]}`}>{linea ? importe(r.signed_amount, true) : movementAmount(r)}</span>
      </button>
      {abierta && (linea ? <DetalleLinea r={r} onIrAExtractos={onIrAExtractos} /> : <Detalle r={r} />)}
    </li>
  );
}

const dato = (titulo: string, valor: string) => <div className="min-w-0"><dt className="text-xs text-[#8A7A5C]">{titulo}</dt><dd className="break-words">{valor}</dd></div>;

function Detalle({ r }: { r: MovementRow }) {
  const emails = useProfileEmails();
  const autor = r.created_by ? emails.data?.get(r.created_by) ?? '—' : 'Automático';
  const fuenteMp = r.pending?.type === 'MP_CLASIFICAR' ? r.pending.source_id : r.status === 'PENDIENTE_CLASIFICAR' ? pendingMpSource(r) : null;
  return (
    <div className="px-3 pb-3 pt-1 bg-[#FAF6EE] text-sm space-y-3" aria-label={`Operación ${r.operation_id}`}>
      {fuenteMp && <Bloque titulo="Requiere acción"><AccionPendienteMp sourceId={fuenteMp} /></Bloque>}
      {(r.pending?.type === 'GASTO_SIN_CLASIFICAR' || r.status === 'SIN_CLASIFICAR') && (
        <Bloque titulo="Requiere acción">
          {r.pending?.type === 'GASTO_SIN_CLASIFICAR' ? <AccionGastoSinClasificar pendingId={r.pending.pending_id} /> : <AccionGastoSinClasificar paymentOperationId={r.operation_id} />}
        </Bloque>
      )}
      {r.pending?.type === 'ENTRADA_SIN_VINCULAR' && <Bloque titulo="Vinculación opcional"><AccionEntrada movementId={r.pending.movement_id} /></Bloque>}
      <div>
        <p className="text-xs text-[#8A7A5C] mb-1">Cuentas involucradas</p>
        <ul className="space-y-1">
          {r.postings.map((p) => (
            <li key={p.posting_id} className="flex justify-between gap-2">
              <span className="truncate">{p.account_name}</span>
              <span className={`font-medium whitespace-nowrap ${p.signed_amount < 0 ? 'text-red-700' : 'text-green-800'}`}>{importe(p.signed_amount, true)}</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {dato('Operación', `Nº ${r.operation_id} · ${MOVEMENT_KIND_LABEL[r.kind]}`)}
        {dato('Estado', rowStatusLabel(r))}
        {dato('Referencia', r.external_ref ?? '—')}
        {r.reason ? dato('Motivo', r.reason) : null}
        {dato('Registrada', `${fechaHora(r.created_at)} · ${autor}`)}
        {r.transfer_intent ? dato('Registrada antes del movimiento', `Transferencia anticipada Nº ${r.transfer_intent.intent_id} del ${formatearFechaLocal(r.transfer_intent.effective_date)}`) : null}
      </dl>
      <Evidencia r={r} />
      {r.related_taxes && r.related_taxes.length > 0 && (
        <div>
          <p className="text-xs text-[#8A7A5C] mb-1">Impuesto bancario de esta transferencia</p>
          <ul className="space-y-1">
            {r.related_taxes.map((t) => (
              <li key={t.operation_id} className="flex justify-between gap-2">
                <span>{t.account_name} · operación {t.operation_id} · {t.matched ? 'conciliado con el extracto' : 'sin conciliar'}</span>
                <span className="font-medium text-red-700 whitespace-nowrap">{importe(-t.amount, true)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-amber-200 rounded-lg p-2">
      <p className="text-[11px] font-semibold text-amber-900 uppercase tracking-wide mb-1">{titulo}</p>
      {children}
    </div>
  );
}

/** The evidence of the operation: the statement lines matched to its postings and the Mercado Pago movements reconciled to it. */
function Evidencia({ r }: { r: MovementRow }) {
  if (r.bank.length === 0 && r.mp.length === 0) {
    return <p className="text-xs text-[#8A7A5C]">{r.status === 'SIN_CONCILIAR' ? 'Sin evidencia bancaria todavía: se concilia cuando llega su línea del extracto (Extractos → Conciliación).' : 'Sin evidencia externa vinculada.'}</p>;
  }
  return (
    <div className="space-y-2">
      {r.bank.length > 0 && (
        <div>
          <p className="text-xs text-[#8A7A5C] mb-1">Evidencia bancaria (extracto)</p>
          <ul className="space-y-1">
            {r.bank.map((b) => (
              <li key={b.statement_line_id} className="border border-[#E4DCC8] bg-white rounded px-2 py-1">
                <p className="flex justify-between gap-2"><span className="truncate">{formatearFechaLocal(b.value_date)} · {b.account_name} · {b.description_raw}</span>
                  <span className="font-medium whitespace-nowrap">{importe(b.signed_amount, true)}</span></p>
                <p className="text-xs text-[#8A7A5C]">Línea {b.statement_line_id} · referencia {b.bank_reference || '—'} · saldo informado por el banco {importe(b.running_balance)}{b.matched_at ? ` · conciliada ${fechaHora(b.matched_at)}` : ''}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.mp.length > 0 && (
        <div>
          <p className="text-xs text-[#8A7A5C] mb-1">Evidencia Mercado Pago (reporte)</p>
          <ul className="space-y-1">
            {r.mp.map((m) => (
              <li key={m.movement_id} className="border border-[#E4DCC8] bg-white rounded px-2 py-1 text-xs">
                {formatearFechaLocal(m.occurred_date)} · Nº Mercado Pago {m.source_id ?? '—'} · bruto {importe(m.gross_amount)} · neto {importe(m.net_amount)} · aplicado {importe(m.assigned_amount, true)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A statement line with no match: the original bank data, what it probably is, and where it is resolved. */
function DetalleLinea({ r, onIrAExtractos }: { r: BankLineRow; onIrAExtractos?: () => void }) {
  const cargo = r.charge && (r.charge.status === 'PROPOSED' || r.charge.status === 'RECORDED');
  return (
    <div className="px-3 pb-3 pt-1 bg-[#FAF6EE] text-sm space-y-2" aria-label={`Línea bancaria ${r.statement_line_id}`}>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {dato('Descripción del banco', r.description_raw)}
        {dato('Referencia', r.bank_reference || '—')}
        {dato('Cuenta', r.account_name)}
        {dato('Saldo informado por el banco', importe(r.running_balance))}
      </dl>
      <p className="text-xs text-[#6B5D45]">
        {cargo ? (r.charge?.status === 'RECORDED' ? `${r.charge.label ?? 'Cargo bancario'}: ya está registrado en el ERP; conciliá la línea con ese registro (no se descuenta otra vez).`
          : `${r.charge?.label ?? 'Cargo bancario'} reconocido: confirmalo en Extractos → Conciliación → Cargos bancarios detectados.`)
          : 'Es evidencia del banco: no cambia el saldo ERP. Vinculala con su operación (o registrá la operación que falta) en Extractos → Conciliación.'}
      </p>
      {onIrAExtractos && <button type="button" onClick={onIrAExtractos} className="text-xs px-2 py-1 rounded border border-[#A8552E] text-[#A8552E] bg-white hover:bg-amber-50">Resolver en Extractos</button>}
    </div>
  );
}
