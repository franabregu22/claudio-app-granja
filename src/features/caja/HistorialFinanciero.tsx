import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { importe } from '../../target/bankReconciliation';
import { errorMessage } from '../../target/messages';
import {
  movementAccounts, movementAmount, MOVEMENT_KIND_LABEL, MOVEMENT_PAGE, movementNote, movementSign, type MovementFilter, type MovementKind, type MovementRow,
} from '../../target/movementHistory';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { Paginador } from './PendientesClasificar';
import { useProfileEmails } from './useUnclassified';
import { useMovementHistory } from './useTreasury';

const campo = 'border border-[#E4DCC8] rounded px-2 py-1 text-sm bg-white w-full';
const etiqueta = 'text-xs text-[#8A7A5C] min-w-0';
const VACIO = { from: '', to: '', accountId: '', kind: '', search: '' };
const TONO = { IN: 'text-green-800', OUT: 'text-red-700', NEUTRAL: 'text-[#2C2419]' };
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Caja → Movimientos: the unified history (0113). Every financial operation once, newest first, from the first one; period, account,
 * kind and search are applied by the server, which also pages and counts. Read-only: nothing here moves money. The per-account
 * detail (CuentaDetalle) stays: a card still opens it.
 */
export function HistorialFinanciero({ cuentas }: { cuentas: { id: string; nombre: string }[] }) {
  const [borrador, setBorrador] = useState(VACIO);
  const [filtro, setFiltro] = useState<MovementFilter>({});
  const [pagina, setPagina] = useState(0);
  const [abierta, setAbierta] = useState<number | null>(null);
  const q = useMovementHistory(filtro, pagina);
  const filas = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const set = (p: Partial<typeof VACIO>) => setBorrador((b) => ({ ...b, ...p }));
  const aplicar = (b: typeof VACIO) => {
    setFiltro({ from: b.from || undefined, to: b.to || undefined, accountId: b.accountId || undefined, kind: (b.kind || undefined) as MovementKind | undefined, search: b.search.trim() || undefined });
    setPagina(0); setAbierta(null);
  };
  const hayFiltro = Object.values(borrador).some((v) => v !== '') || Object.values(filtro).some(Boolean);
  const rango = borrador.from !== '' && borrador.to !== '' && borrador.from > borrador.to;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Historial financiero</p>
        <p className="text-xs text-[#8A7A5C]">Tocá una cuenta para ver su detalle.</p>
      </div>
      <form className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end bg-white rounded-lg border border-[#E4DCC8] p-3" aria-label="Filtros del historial"
        onSubmit={(e) => { e.preventDefault(); if (!rango) aplicar(borrador); }}>
        <label className={etiqueta}>Desde<input type="date" value={borrador.from} onChange={(e) => set({ from: e.target.value })} className={campo} /></label>
        <label className={etiqueta}>Hasta<input type="date" value={borrador.to} onChange={(e) => set({ to: e.target.value })} className={campo} /></label>
        <label className={etiqueta}>Cuenta
          <select value={borrador.accountId} onChange={(e) => set({ accountId: e.target.value })} className={campo}>
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
          {hayFiltro && <button type="button" onClick={() => { setBorrador(VACIO); aplicar(VACIO); }} className="text-sm px-2 py-1 rounded-lg border border-[#E4DCC8] bg-white hover:bg-stone-50">Limpiar</button>}
        </div>
        {rango && <p className="col-span-2 md:col-span-7 text-xs text-red-700">La fecha Desde no puede ser posterior a Hasta.</p>}
      </form>
      {q.isLoading ? <p className="text-sm text-gray-500">Cargando movimientos...</p>
        : q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p>
          : filas.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay movimientos con esos filtros.</p> : (
            <ul className="bg-white rounded-lg border border-[#E4DCC8] divide-y divide-stone-100" aria-label="Movimientos">
              {filas.map((r) => <Fila key={r.operation_id} r={r} abierta={abierta === r.operation_id} onToggle={() => setAbierta(abierta === r.operation_id ? null : r.operation_id)} />)}
            </ul>
          )}
      {filas.length > 0 && <Paginador pagina={pagina} paginas={Math.max(1, Math.ceil(total / MOVEMENT_PAGE))} total={total} onCambiar={(p) => { setPagina(p); setAbierta(null); }} />}
    </div>
  );
}

function Fila({ r, abierta, onToggle }: { r: MovementRow; abierta: boolean; onToggle: () => void }) {
  const signo = movementSign(r);
  const nota = movementNote(r);
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={abierta} className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-stone-50">
        <ChevronDown className={`w-4 h-4 shrink-0 text-[#8A7A5C] transition ${abierta ? 'rotate-180' : ''}`} />
        <span className="flex-1 min-w-0 md:grid md:grid-cols-[6rem_1fr_12rem] md:gap-3 md:items-center">
          <span className="block text-xs md:text-sm text-[#8A7A5C] md:text-inherit whitespace-nowrap">{formatearFechaLocal(r.effective_date)}</span>
          <span className="block min-w-0">
            <span className="block text-sm font-medium text-[#2C2419] truncate">{r.label}</span>
            {nota && <span className="block text-xs text-[#8A7A5C] truncate" title={nota}>{nota}</span>}
          </span>
          <span className="block text-xs md:text-sm text-[#6B5D45] truncate">{movementAccounts(r)}</span>
        </span>
        <span className={`shrink-0 md:w-36 text-right text-sm font-semibold whitespace-nowrap ${TONO[signo]}`}>{movementAmount(r)}</span>
      </button>
      {abierta && <Detalle r={r} />}
    </li>
  );
}

function Detalle({ r }: { r: MovementRow }) {
  const emails = useProfileEmails();
  const autor = r.created_by ? emails.data?.get(r.created_by) ?? '—' : 'Automático';
  const dato = (titulo: string, valor: string) => <div className="min-w-0"><dt className="text-xs text-[#8A7A5C]">{titulo}</dt><dd className="break-words">{valor}</dd></div>;
  return (
    <div className="px-3 pb-3 pt-1 bg-[#FAF6EE] text-sm space-y-3" aria-label={`Operación ${r.operation_id}`}>
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
        {dato('Referencia', r.external_ref ?? '—')}
        {r.reason ? dato('Motivo', r.reason) : null}
        {dato('Registrada', `${fechaHora(r.created_at)} · ${autor}`)}
      </dl>
    </div>
  );
}
