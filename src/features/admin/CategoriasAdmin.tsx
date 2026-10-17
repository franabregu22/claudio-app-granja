import { useState } from 'react';
import { categoryTree, GROUP_KIND_LABEL, NATURE_LABEL } from '../../target/expenseCategories';
import type { ExpenseCategoryGroupRow, ExpenseCategoryRow, PurchaseNatureValue } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { useMasterList, useMasterMutations } from './useMasters';

const CAMPO = 'border border-gray-300 rounded px-2 py-1 text-sm';
const BOTON = 'text-xs px-2 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50';
const NATURES: PurchaseNatureValue[] = ['OPERATING', 'REINVESTMENT', 'INVESTMENT'];

/**
 * ADR-024 — Administración → Categorías de gasto: the tree CATEGORY → SUBCATEGORY. ADMIN only; every insert / update is
 * audited by the database. Create / rename / activate / deactivate / order a category and set its kind; create / rename /
 * activate / deactivate a subcategory, set its default nature (pre-filled in purchases, editable per operation) and move it to
 * another category. Nothing is deleted (history keeps pointing to the same subcategory). DIRECT / INDIRECT is in standby: a new
 * subcategory takes its siblings' class in the database. IVA / Ganancias are fiscal-reserved (Fiscal route) and stay inactive.
 */
export function CategoriasAdmin() {
  const grupos = useMasterList<ExpenseCategoryGroupRow>('expense_category_group', 'display_order');
  const subs = useMasterList<ExpenseCategoryRow>('expense_category');
  const g = useMasterMutations('expense_category_group');
  const s = useMasterMutations('expense_category');
  const [nuevo, setNuevo] = useState({ nombre: '', kind: 'EXPENSE' as ExpenseCategoryGroupRow['kind'] });
  const error = grupos.error ?? subs.error ?? g.create.error ?? g.update.error ?? s.create.error ?? s.update.error;
  if (grupos.isLoading || subs.isLoading) return <p className="text-sm text-gray-500">Cargando categorías…</p>;
  const arbol = categoryTree(grupos.data ?? [], subs.data ?? []);
  const proximoOrden = Math.max(0, ...(grupos.data ?? []).map((x) => x.display_order)) + 1;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-amber-900">Categorías de gasto</h2>
      <p className="text-xs text-gray-600">Categoría → Subcategoría. La naturaleza por defecto se completa sola al cargar un gasto y se puede cambiar en cada operación. Nada se borra: se desactiva.</p>
      {error && <p className="text-sm text-red-700">{errorMessage(error)}</p>}
      <div className="flex flex-wrap items-end gap-2 bg-white border border-gray-200 rounded-lg p-3">
        <label className="text-xs text-gray-600">Nueva categoría<input className={`${CAMPO} block`} value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} placeholder="Ej: Combustible" /></label>
        <label className="text-xs text-gray-600">Tipo
          <select className={`${CAMPO} block`} value={nuevo.kind} onChange={(e) => setNuevo({ ...nuevo, kind: e.target.value as ExpenseCategoryGroupRow['kind'] })}>
            {(['EXPENSE', 'OWNER_WITHDRAWAL'] as const).map((k) => <option key={k} value={k}>{GROUP_KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <button className={BOTON} disabled={nuevo.nombre.trim() === '' || g.create.isPending}
          onClick={() => g.create.mutate({ nombre: nuevo.nombre, kind: nuevo.kind, display_order: proximoOrden }, { onSuccess: () => setNuevo({ nombre: '', kind: 'EXPENSE' }) })}>
          Crear categoría
        </button>
      </div>
      {arbol.map(({ group, subs: hijos }) => (
        <Grupo key={group.id} grupo={group} hijos={hijos} grupos={grupos.data ?? []} g={g} s={s} />
      ))}
    </div>
  );
}

type Mut = ReturnType<typeof useMasterMutations>;

function Grupo({ grupo, hijos, grupos, g, s }: { grupo: ExpenseCategoryGroupRow; hijos: ExpenseCategoryRow[]; grupos: ExpenseCategoryGroupRow[]; g: Mut; s: Mut }) {
  const [nombre, setNombre] = useState(grupo.nombre);
  const [orden, setOrden] = useState(String(grupo.display_order));
  const [nuevaSub, setNuevaSub] = useState('');
  const [naturaleza, setNaturaleza] = useState<PurchaseNatureValue>('OPERATING');
  const retiro = grupo.kind === 'OWNER_WITHDRAWAL';
  const cambiado = nombre.trim() !== grupo.nombre || Number(orden) !== grupo.display_order;
  return (
    <section className={`bg-white border rounded-lg p-3 space-y-2 ${grupo.activo ? 'border-gray-200' : 'border-gray-200 opacity-60'}`} aria-label={grupo.nombre}>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${CAMPO} font-semibold`} value={nombre} onChange={(e) => setNombre(e.target.value)} aria-label="Nombre de la categoría" />
        <input className={`${CAMPO} w-16`} type="number" value={orden} onChange={(e) => setOrden(e.target.value)} aria-label="Orden" />
        <select className={CAMPO} value={grupo.kind} aria-label="Tipo" onChange={(e) => g.update.mutate({ id: grupo.id, values: { kind: e.target.value } })}>
          {(['EXPENSE', 'OWNER_WITHDRAWAL'] as const).map((k) => <option key={k} value={k}>{GROUP_KIND_LABEL[k]}</option>)}
        </select>
        {cambiado && <button className={BOTON} onClick={() => g.update.mutate({ id: grupo.id, values: { nombre, display_order: Number(orden) } })}>Guardar</button>}
        <button className={BOTON} onClick={() => g.update.mutate({ id: grupo.id, values: { activo: !grupo.activo } })}>{grupo.activo ? 'Desactivar' : 'Activar'}</button>
        {retiro && <span className="text-xs text-gray-500">Socios del retiro: no se ofrecen en compras ni gastos.</span>}
      </div>
      <ul className="space-y-1 pl-4">
        {hijos.map((sub) => <Subcategoria key={sub.id} sub={sub} grupos={grupos} retiro={retiro} s={s} />)}
      </ul>
      <div className="flex flex-wrap items-center gap-2 pl-4">
        <input className={CAMPO} value={nuevaSub} onChange={(e) => setNuevaSub(e.target.value)} placeholder="Nueva subcategoría" aria-label={`Nueva subcategoría de ${grupo.nombre}`} />
        {!retiro && (
          <select className={CAMPO} value={naturaleza} onChange={(e) => setNaturaleza(e.target.value as PurchaseNatureValue)} aria-label="Naturaleza por defecto">
            {NATURES.map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
          </select>
        )}
        <button className={BOTON} disabled={nuevaSub.trim() === '' || s.create.isPending}
          onClick={() => s.create.mutate({ nombre: nuevaSub, group_id: grupo.id, default_nature: retiro ? null : naturaleza }, { onSuccess: () => setNuevaSub('') })}>
          Agregar
        </button>
      </div>
    </section>
  );
}

function Subcategoria({ sub, grupos, retiro, s }: { sub: ExpenseCategoryRow; grupos: ExpenseCategoryGroupRow[]; retiro: boolean; s: Mut }) {
  const [nombre, setNombre] = useState(sub.nombre);
  return (
    <li className={`flex flex-wrap items-center gap-2 text-sm ${sub.activo ? '' : 'opacity-60'}`}>
      <input className={CAMPO} value={nombre} onChange={(e) => setNombre(e.target.value)} aria-label="Nombre de la subcategoría" />
      {nombre.trim() !== sub.nombre && <button className={BOTON} onClick={() => s.update.mutate({ id: sub.id, values: { nombre } })}>Guardar</button>}
      {!retiro && !sub.fiscal_reserved && (
        <select className={CAMPO} value={sub.default_nature ?? 'OPERATING'} aria-label="Naturaleza por defecto"
          onChange={(e) => s.update.mutate({ id: sub.id, values: { default_nature: e.target.value } })}>
          {NATURES.map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
        </select>
      )}
      <select className={CAMPO} value={sub.group_id} aria-label="Mover a la categoría" onChange={(e) => s.update.mutate({ id: sub.id, values: { group_id: e.target.value } })}>
        {grupos.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
      </select>
      {sub.fiscal_reserved
        ? <span className="text-xs text-gray-500">Se registra por Fiscal (no es un gasto común)</span>
        : <button className={BOTON} onClick={() => s.update.mutate({ id: sub.id, values: { activo: !sub.activo } })}>{sub.activo ? 'Desactivar' : 'Activar'}</button>}
    </li>
  );
}
