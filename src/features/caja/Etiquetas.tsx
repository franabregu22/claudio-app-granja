import { useState } from 'react';
import { Pencil, Tag } from 'lucide-react';
import { SIN_ETIQUETA } from '../../target/etiquetas';
import { errorMessage } from '../../target/messages';
import { formatoPesos } from '../pedidos/helpers';
import { campo, etiqueta as etiquetaCls, Modal } from './Modal';
import { useEtiquetaMutations, useEtiquetas, useTotalesEtiqueta } from './useEtiquetas';

/** Tag selector: «Sin etiqueta» (default), the active tags, or a new one typed right here. `value` '' = Sin etiqueta. */
export function SelectorEtiqueta({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const etiquetas = useEtiquetas();
  const { crear } = useEtiquetaMutations();
  const [nueva, setNueva] = useState<string | null>(null);
  const activas = (etiquetas.data ?? []).filter((e) => e.status === 'ACTIVE' || e.id === value);
  if (nueva !== null) {
    return (
      <div className={etiquetaCls}>Nueva etiqueta
        <div className="flex gap-2 mt-1">
          <input autoFocus value={nueva} onChange={(e) => setNueva(e.target.value)} placeholder="Ej: Maíz 2027" className={`${campo} mt-0`} maxLength={150} />
          <button type="button" disabled={nueva.trim() === '' || crear.isPending} className="text-sm px-3 rounded-lg bg-amber-600 text-white disabled:opacity-50"
            onClick={() => crear.mutate(nueva, { onSuccess: (e) => { onChange(e.id); setNueva(null); } })}>Crear</button>
          <button type="button" className="text-sm px-2 text-gray-600" onClick={() => setNueva(null)}>Cancelar</button>
        </div>
        {crear.error ? <span className="block text-xs text-red-700 mt-1">{errorMessage(crear.error)}</span> : null}
      </div>
    );
  }
  return (
    <label className={etiquetaCls}>Etiqueta
      <select value={value} onChange={(e) => (e.target.value === '__nueva' ? setNueva('') : onChange(e.target.value))} className={campo}>
        <option value="">{SIN_ETIQUETA}</option>
        {activas.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
        <option value="__nueva">+ Nueva etiqueta…</option>
      </select>
    </label>
  );
}

/** The tag chip of a list row (nothing when «Sin etiqueta»). */
export function ChipEtiqueta({ nombre }: { nombre?: string }) {
  if (!nombre) return null;
  return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-violet-50 text-violet-800"><Tag className="w-3 h-3" aria-hidden />{nombre}</span>;
}

/** «Etiqueta: X ✎» in the expense detail: change or remove it (Sin etiqueta). */
export function EtiquetaDelGasto({ purchaseId, actual }: { purchaseId: string; actual?: { id: string; nombre: string } }) {
  const [editando, setEditando] = useState(false);
  return (
    <>
      <p className="flex items-center gap-1.5">Etiqueta: <b>{actual?.nombre ?? SIN_ETIQUETA}</b>
        <button type="button" aria-label="Cambiar etiqueta" title="Cambiar o quitar la etiqueta" className="text-[#A8552E] hover:text-[#8B4423]" onClick={() => setEditando(true)}>
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </p>
      {editando && <CambiarEtiquetaModal purchaseId={purchaseId} actual={actual?.id ?? ''} onClose={() => setEditando(false)} />}
    </>
  );
}

function CambiarEtiquetaModal({ purchaseId, actual, onClose }: { purchaseId: string; actual: string; onClose: () => void }) {
  const { asignar } = useEtiquetaMutations();
  const [valor, setValor] = useState(actual);
  return (
    <Modal titulo="Etiqueta del gasto" onClose={onClose} guardando={asignar.isPending} error={asignar.error} puedeGuardar={valor !== actual}
      onSubmit={() => asignar.mutate({ purchaseId, etiquetaId: valor || null }, { onSuccess: onClose })}>
      <SelectorEtiqueta value={valor} onChange={setValor} />
      <p className="text-xs text-gray-500">Para quitarla, elegí «{SIN_ETIQUETA}». El cambio queda registrado.</p>
    </Modal>
  );
}

/** «Totales por etiqueta»: how much was spent on each tag (current, non-annulled expenses). */
export function TotalesEtiqueta() {
  const totales = useTotalesEtiqueta();
  const conGastos = (totales.data ?? []).filter((t) => t.expenses > 0);
  return (
    <details className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
      <summary className="cursor-pointer font-semibold text-amber-900">Totales por etiqueta</summary>
      {totales.error ? <p className="text-red-700 mt-2">{errorMessage(totales.error)}</p> : conGastos.length === 0 ? <p className="text-[#8A7A5C] mt-2">Todavía no hay gastos con etiqueta.</p> : (
        <ul className="mt-2 divide-y divide-[#F1EBDD]">
          {conGastos.map((t) => (
            <li key={t.project_id} className="flex justify-between gap-2 py-1.5">
              <span><ChipEtiqueta nombre={t.tag_nombre} /> <span className="text-xs text-gray-500">{t.expenses} gasto{t.expenses === 1 ? '' : 's'}</span></span>
              <b>{formatoPesos(t.total)}</b>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
