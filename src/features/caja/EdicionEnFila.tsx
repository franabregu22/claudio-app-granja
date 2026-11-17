import { Lock } from 'lucide-react';
import { useRef, useState } from 'react';
import { defaultNatureOf, selectableGroups, selectableSubcategories } from '../../target/expenseCategories';
import { reglasDeCompra, type VinculosGasto } from '../../target/expenses';
import { errorMessage } from '../../target/messages';
import type { OperationRow } from '../../target/operations';
import type { MovementRow } from '../../target/movementHistory';
import type { PurchaseRow } from '../../target/treasury';
import { NumeroInput } from '../../components/NumeroInput';
import { NATURALEZA_LABEL, type OperationNature } from '../../target/operations';
import { useClassifyMp } from './useMpActivity';
import { useGastoItems, vinculosDe } from './Gastos';
import { useEtiquetaMutations, useEtiquetas, useEtiquetasDeGastos } from './useEtiquetas';
import { useRectifyExpense } from './useExpenses';
import { useExpenseCategories, useExpenseGroups, useMovementList, usePurchase } from './useTreasury';

/**
 * Owner 2026-11-17: an expense is corrected right in its row of Todas las operaciones, like a spreadsheet — a double click on a cell
 * opens it. Each change is the same audited rectification as «Editar» (rectify_purchase_details: a new version, the old one and every
 * field before / after in the history) or the audited tag change (set_purchase_tag). No reason is typed: the backend's required reason
 * is recorded as MOTIVO_TABLA. The same locks as «Editar» apply (paid, linked to Mercado Pago, cheques assigned, fiscal document).
 */
export type CampoFila = 'fecha' | 'concepto' | 'categoria' | 'naturaleza' | 'etiqueta' | 'importe';
export const MOTIVO_TABLA = 'Edición en la tabla';
/** Only an expense row is edited in place; income, transfers, cheques and the automatic Mercado Pago / bank rows are not. */
export const editableEnFila = (r: OperationRow) => r.purchase_id !== null && r.tipo === 'EGRESO' && !r.informativo && r.row_kind !== 'CHEQUE';
/** Owner 2026-11-17: a Mercado Pago outflow still unclassified is classified from its Categoría / Subcategoría cell (a gasto without
 * supplier in the chosen subcategory — mp_classify_payout_outflow CASUAL_PURCHASE); a supplier payment or a partner withdrawal is
 * chosen from «⋯ → Clasificar». */
export const clasificableEnFila = (r: OperationRow) => r.clasificacion === 'MP_SIN_CLASIFICAR' && r.operation_id !== null && r.tipo === 'EGRESO';

const SIN_VINCULOS: VinculosGasto = { pendienteSinProveedor: false, mpVinculado: false, asignado: 0, estadoPago: '', comoPagar: '' };
const INPUT = 'w-full min-w-[7rem] border border-amber-500 rounded px-1.5 py-0.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-600';

export function EditorCelda({ r, campo, onFin }: { r: OperationRow; campo: CampoFila; onFin: () => void }) {
  if (clasificableEnFila(r)) return <ClasificarMpCelda r={r} onFin={onFin} />;
  return <EditorGasto r={r} campo={campo} onFin={onFin} />;
}

function EditorGasto({ r, campo, onFin }: { r: OperationRow; campo: CampoFila; onFin: () => void }) {
  const compra = usePurchase(r.purchase_id);
  const { todos } = useGastoItems();
  const c = compra.data;
  if (compra.error) return <Aviso texto={errorMessage(compra.error)} onFin={onFin} />;
  if (!c) return <span className="text-xs text-gray-500">Abriendo…</span>;
  const it = todos.find((x) => x.purchaseId === c.id);
  return <Editor r={r} c={c} vinculos={it ? vinculosDe(it, c) : SIN_VINCULOS} campo={campo} onFin={onFin} />;
}

function Aviso({ texto, onFin, bloqueo = false }: { texto: string; onFin: () => void; bloqueo?: boolean }) {
  return (
    <span className={`inline-flex items-start gap-1 text-xs ${bloqueo ? 'text-[#8A7A5C]' : 'text-red-700'}`}>
      {bloqueo && <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />}{texto}
      <button type="button" onClick={onFin} className="ml-1 underline">Cerrar</button>
    </span>
  );
}

function Editor({ r, c, vinculos, campo, onFin }: { r: OperationRow; c: PurchaseRow; vinculos: VinculosGasto; campo: CampoFila; onFin: () => void }) {
  const reglas = reglasDeCompra(c, vinculos);
  const rectificar = useRectifyExpense();
  const etiquetas = useEtiquetas();
  const tagsDe = useEtiquetasDeGastos();
  const tag = useEtiquetaMutations();
  const grupos = useExpenseGroups();
  const subs = useExpenseCategories();
  const hecho = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [importe, setImporte] = useState(String(c.amount_total));   // dot-decimal, shown with a comma by NumeroInput
  const concepto = c.subcategory ?? c.lineas[0]?.descripcion ?? r.concepto;

  const rectificarCon = async (cambio: { concept?: string; categoryId?: string; fecha?: string; amountTotal?: number; nature?: OperationNature }) => {
    const importe = cambio.amountTotal ?? c.amount_total;
    const categoryId = cambio.categoryId ?? c.expense_category_id;
    await rectificar.mutateAsync({
      purchaseId: c.id, concept: (cambio.concept ?? concepto).trim(), categoryId,
      nature: cambio.nature ?? (cambio.categoryId ? defaultNatureOf(subs.data ?? [], categoryId) : c.nature),
      fecha: cambio.fecha ?? c.economic_date, supplierId: c.supplier_id, invoiceNumber: c.supplier_invoice_number,
      amountTotal: importe, amountNet: importe === c.amount_total ? c.amount_net : importe, reason: MOTIVO_TABLA, fiscal: null,
    });
  };
  /** One save per opened cell (Enter and then blur do not save twice); nothing is saved when the value did not change. */
  const guardar = async (cambiado: boolean, accion: () => Promise<unknown>) => {
    if (hecho.current) return;
    hecho.current = true;
    if (!cambiado) { onFin(); return; }
    try { await accion(); onFin(); } catch (e) { hecho.current = false; setError(e); }
  };
  const teclas = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') { hecho.current = true; onFin(); }
  };
  const ocupado = rectificar.isPending || tag.asignar.isPending;

  let editor: React.ReactNode;
  if (campo === 'fecha' && !reglas.fecha) return <Aviso bloqueo texto={reglas.porque.fecha ?? 'La fecha no se puede cambiar.'} onFin={onFin} />;
  if (campo === 'importe' && !reglas.importe) return <Aviso bloqueo texto={reglas.porque.importe ?? 'El importe no se puede cambiar.'} onFin={onFin} />;
  if (campo === 'concepto') {
    editor = <input type="text" defaultValue={concepto} maxLength={100} autoFocus onKeyDown={teclas} aria-label="Concepto" className={INPUT}
      onBlur={(e) => { const v = e.target.value.trim(); void guardar(v !== '' && v !== concepto.trim(), () => rectificarCon({ concept: v })); }} />;
  } else if (campo === 'fecha') {
    editor = <input type="date" defaultValue={c.economic_date} autoFocus onKeyDown={teclas} aria-label="Fecha" className={INPUT}
      onBlur={(e) => { const v = e.target.value; void guardar(v !== '' && v !== c.economic_date, () => rectificarCon({ fecha: v })); }} />;
  } else if (campo === 'importe') {
    editor = <NumeroInput value={importe} onChange={(e) => setImporte(e.target.value)} min="0" step="0.01" autoFocus onKeyDown={teclas} aria-label="Importe" className={`${INPUT} text-right`}
      onBlur={() => { const v = Number(importe); void guardar(v > 0 && v !== c.amount_total, () => rectificarCon({ amountTotal: v })); }} />;
  } else if (campo === 'naturaleza') {
    editor = (
      <select defaultValue={c.nature} autoFocus aria-label="Naturaleza" className={INPUT}
        onChange={(e) => { const v = e.target.value as OperationNature; void guardar(v !== c.nature, () => rectificarCon({ nature: v })); }}
        onBlur={() => { if (!hecho.current) { hecho.current = true; onFin(); } }} onKeyDown={(e) => { if (e.key === 'Escape') { hecho.current = true; onFin(); } }}>
        {(Object.keys(NATURALEZA_LABEL) as OperationNature[]).map((n) => <option key={n} value={n}>{NATURALEZA_LABEL[n]}</option>)}
      </select>
    );
  } else if (campo === 'categoria') {
    const g = grupos.data ?? []; const s = subs.data ?? [];
    editor = (
      <select defaultValue={c.expense_category_id} autoFocus aria-label="Subcategoría" className={INPUT}
        onChange={(e) => { const v = e.target.value; void guardar(v !== c.expense_category_id, () => rectificarCon({ categoryId: v })); }}
        onBlur={() => { if (!hecho.current) { hecho.current = true; onFin(); } }} onKeyDown={(e) => { if (e.key === 'Escape') { hecho.current = true; onFin(); } }}>
        {s.some((x) => x.id === c.expense_category_id) ? null : <option value={c.expense_category_id}>{c.categoria_nombre}</option>}
        {selectableGroups(g, s).map((grupo) => (
          <optgroup key={grupo.id} label={grupo.nombre}>
            {selectableSubcategories(g, s, grupo.id).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
          </optgroup>
        ))}
      </select>
    );
  } else {
    const actual = tagsDe.data?.get(c.id)?.id ?? '';
    editor = (
      <select defaultValue={actual} autoFocus aria-label="Etiqueta" className={INPUT}
        onChange={(e) => { const v = e.target.value; void guardar(v !== actual, () => tag.asignar.mutateAsync({ purchaseId: c.id, etiquetaId: v || null })); }}
        onBlur={() => { if (!hecho.current) { hecho.current = true; onFin(); } }} onKeyDown={(e) => { if (e.key === 'Escape') { hecho.current = true; onFin(); } }}>
        <option value="">Sin etiqueta</option>
        {(etiquetas.data ?? []).filter((x) => x.status === 'ACTIVE' || x.id === actual).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
      </select>
    );
  }
  return (
    <span className="block" onClick={(e) => e.stopPropagation()}>
      {editor}
      {ocupado && <span className="block text-[11px] text-[#8A7A5C]">Guardando…</span>}
      {error ? <Aviso texto={errorMessage(error)} onFin={onFin} /> : null}
    </span>
  );
}

/** The subcategory of an unclassified Mercado Pago outflow: it becomes a gasto without supplier (its concept = the subcategory name,
 * editable afterwards in its cell; nature = the subcategory default). The movement's source is read from its operation. */
function ClasificarMpCelda({ r, onFin }: { r: OperationRow; onFin: () => void }) {
  const mov = useMovementList({ search: String(r.operation_id), pending: 'MP_CLASIFICAR' }, 0);   // the Por resolver key carries the MP source
  const grupos = useExpenseGroups();
  const subs = useExpenseCategories();
  const { outflow } = useClassifyMp();
  const hecho = useRef(false);
  const fila = (mov.data?.rows ?? []).find((x): x is MovementRow => x.row_type === 'OP' && x.operation_id === r.operation_id);
  const fuente = (fila?.pending?.type === 'MP_CLASIFICAR' ? fila.pending.source_id : null) ?? fila?.mp.find((m) => m.source_id)?.source_id ?? null;
  if (mov.isLoading) return <span className="text-xs text-gray-500">Abriendo…</span>;
  if (!fuente) return <Aviso texto="No encontré el movimiento de Mercado Pago: clasificalo desde ⋯." onFin={onFin} />;
  const g = grupos.data ?? []; const s = subs.data ?? [];
  const elegir = async (id: string) => {
    if (hecho.current || !id) return;
    hecho.current = true;
    const sub = s.find((x) => x.id === id);
    try {
      await outflow.mutateAsync({ sourceId: fuente, classification: 'CASUAL_PURCHASE', expenseCategoryId: id, nature: defaultNatureOf(s, id),
        concept: (sub?.nombre ?? 'Gasto').slice(0, 100), counterpartyName: null });
      onFin();
    } catch { hecho.current = false; }
  };
  return (
    <span className="block" onClick={(e) => e.stopPropagation()}>
      <select defaultValue="" autoFocus aria-label="Clasificar como gasto" className={INPUT} onChange={(e) => { void elegir(e.target.value); }}
        onBlur={() => { if (!hecho.current) onFin(); }} onKeyDown={(e) => { if (e.key === 'Escape') { hecho.current = true; onFin(); } }}>
        <option value="">Gasto en…</option>
        {selectableGroups(g, s).map((grupo) => (
          <optgroup key={grupo.id} label={grupo.nombre}>
            {selectableSubcategories(g, s, grupo.id).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
          </optgroup>
        ))}
      </select>
      {outflow.isPending && <span className="block text-[11px] text-[#8A7A5C]">Clasificando…</span>}
      {outflow.error ? <Aviso texto={errorMessage(outflow.error)} onFin={onFin} /> : null}
    </span>
  );
}
