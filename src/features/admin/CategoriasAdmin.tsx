import { useState } from 'react';
import { ChevronDown, Pencil, Plus } from 'lucide-react';
import { categoryTree, GROUP_KIND_LABEL, NATURE_LABEL } from '../../target/expenseCategories';
import type { ExpenseCategoryGroupRow, ExpenseCategoryRow, PurchaseNatureValue } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useAlimentoMutations } from '../production/alimento/useAlimento';
import { useMasterList, useMasterMutations } from './useMasters';

const NATURES: PurchaseNatureValue[] = ['OPERATING', 'REINVESTMENT', 'INVESTMENT'];
const CHIP = 'text-[11px] px-1.5 py-0.5 rounded';
type Ingrediente = { id: string; nombre: string; activo: boolean };
type Editor =
  | { tipo: 'categoria'; grupo?: ExpenseCategoryGroupRow }
  | { tipo: 'sub'; grupo: ExpenseCategoryGroupRow; sub?: ExpenseCategoryRow }
  | null;

/**
 * ADR-024 — Administración → Categorías de gasto: the tree CATEGORY → SUBCATEGORY, ADMIN only, every insert / update
 * audited by the database; nothing is deleted (deactivate). The list folds by category; each change is a short form
 * (pencil): category = name, kind, order; subcategory = name, category (move), default nature and — 0126 — whether it is
 * a feed ingredient or feed freight (its purchases are stock, not expense, from November 2026). DIRECT / INDIRECT stays in
 * standby. IVA / Ganancias are fiscal-reserved (Fiscal route).
 */
export function CategoriasAdmin() {
  const grupos = useMasterList<ExpenseCategoryGroupRow>('expense_category_group', 'display_order');
  const subs = useMasterList<ExpenseCategoryRow>('expense_category');
  const ingredientes = useMasterList<Ingrediente>('feed_ingredient');
  const g = useMasterMutations('expense_category_group');
  const s = useMasterMutations('expense_category');
  const [abierta, setAbierta] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const error = grupos.error ?? subs.error ?? g.update.error ?? s.update.error;
  if (grupos.isLoading || subs.isLoading) return <p className="text-sm text-gray-500">Cargando categorías…</p>;
  const arbol = categoryTree(grupos.data ?? [], subs.data ?? []);
  const nombreIng = (id?: string | null) => (ingredientes.data ?? []).find((i) => i.id === id)?.nombre;
  // active categories first; the deactivated ones in their own section below (nothing is deleted)
  const activas = arbol.filter((x) => x.group.activo);
  const inactivas = arbol.filter((x) => !x.group.activo);
  const fila = ({ group, subs: hijos }: (typeof arbol)[number]) => {
      const abiertaEsta = abierta === group.id;
      const retiro = group.kind === 'OWNER_WITHDRAWAL';
      return (
        <section key={group.id} aria-label={group.nombre} className={`bg-white border border-gray-200 rounded-lg ${group.activo ? '' : 'opacity-60'}`}>
          <div className="flex items-center gap-2 p-3">
            <button className="flex items-center gap-2 flex-1 text-left" onClick={() => setAbierta(abiertaEsta ? null : group.id)}>
              <ChevronDown className={`w-4 h-4 transition ${abiertaEsta ? 'rotate-180' : ''}`} />
              <span className="font-semibold text-[#2C2419]">{group.nombre}</span>
              <span className="text-xs text-gray-500">({hijos.filter((h) => h.activo).length})</span>
              {retiro && <span className={`${CHIP} bg-purple-100 text-purple-800`}>Retiro de socios</span>}
              {!group.activo && <span className={`${CHIP} bg-gray-100 text-gray-700`}>Inactiva</span>}
            </button>
            <button aria-label={`Editar ${group.nombre}`} title="Editar categoría" className="text-[#A8552E] hover:text-[#8B4423]" onClick={() => setEditor({ tipo: 'categoria', grupo: group })}>
              <Pencil className="w-4 h-4" />
            </button>
          </div>
          {abiertaEsta && (
            <div className="border-t border-gray-100 px-3 pb-3">
              <ul className="divide-y divide-gray-100">
                {[...hijos].sort((a, b) => Number(b.activo) - Number(a.activo)).map((sub) => (
                  <li key={sub.id} className={`flex items-center gap-2 py-2 text-sm ${sub.activo ? '' : 'opacity-60'}`}>
                    <span className="flex-1 flex flex-wrap items-center gap-1.5">
                      <span>{sub.nombre}</span>
                      {!retiro && sub.default_nature && sub.default_nature !== 'OPERATING' && <span className={`${CHIP} bg-blue-100 text-blue-800`}>{NATURE_LABEL[sub.default_nature]}</span>}
                      {sub.feed_ingredient_id && <span className={`${CHIP} bg-amber-100 text-amber-900`}>Alimento: insumo{nombreIng(sub.feed_ingredient_id) && nombreIng(sub.feed_ingredient_id) !== sub.nombre ? ` (${nombreIng(sub.feed_ingredient_id)})` : ''}</span>}
                      {sub.is_feed_freight && <span className={`${CHIP} bg-amber-100 text-amber-900`}>Alimento: flete</span>}
                      {sub.fiscal_reserved && <span className={`${CHIP} bg-gray-100 text-gray-700`}>Fiscal</span>}
                      {!sub.activo && <span className={`${CHIP} bg-gray-100 text-gray-700`}>Inactiva</span>}
                    </span>
                    {!sub.fiscal_reserved && (
                      <button aria-label={`Editar ${sub.nombre}`} title="Editar subcategoría" className="text-[#A8552E] hover:text-[#8B4423]" onClick={() => setEditor({ tipo: 'sub', grupo: group, sub })}>
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                  </li>
                ))}
                {hijos.length === 0 && <li className="py-2 text-sm text-gray-400">Sin subcategorías.</li>}
              </ul>
              <button className="mt-1 text-sm text-[#A8552E] hover:underline" onClick={() => setEditor({ tipo: 'sub', grupo: group })}>+ Agregar subcategoría</button>
            </div>
          )}
        </section>
      );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-amber-900">Categorías de gasto</h2>
        <button className="text-sm px-3 py-1.5 rounded-lg font-medium bg-amber-600 text-white hover:bg-amber-700" onClick={() => setEditor({ tipo: 'categoria' })}>
          <Plus className="w-4 h-4 inline -mt-0.5" /> Nueva categoría
        </button>
      </div>
      <p className="text-xs text-gray-600">Tocá una categoría para ver sus subcategorías. Con el lápiz se edita. Nada se borra: se desactiva.</p>
      {error && <p className="text-sm text-red-700">{errorMessage(error)}</p>}

      {activas.map(fila)}
      {inactivas.length > 0 && (
        <>
          <h3 className="pt-4 text-sm font-semibold text-gray-500 uppercase tracking-wide">Categorías inactivas</h3>
          <p className="text-xs text-gray-500">No se ofrecen al cargar gastos. Para volver a usarlas, editalas y marcá «Activa».</p>
          {inactivas.map(fila)}
        </>
      )}

      {editor?.tipo === 'categoria' && <CategoriaModal grupo={editor.grupo} proximoOrden={Math.max(0, ...(grupos.data ?? []).map((x) => x.display_order)) + 1} onClose={() => setEditor(null)} />}
      {editor?.tipo === 'sub' && <SubcategoriaModal grupo={editor.grupo} sub={editor.sub} grupos={grupos.data ?? []} ingredientes={ingredientes.data ?? []} onClose={() => setEditor(null)} />}
    </div>
  );
}

/** Create or edit a CATEGORY: name, kind, order, active. */
function CategoriaModal({ grupo, proximoOrden, onClose }: { grupo?: ExpenseCategoryGroupRow; proximoOrden: number; onClose: () => void }) {
  const g = useMasterMutations('expense_category_group');
  const [nombre, setNombre] = useState(grupo?.nombre ?? '');
  const [kind, setKind] = useState<ExpenseCategoryGroupRow['kind']>(grupo?.kind ?? 'EXPENSE');
  const [orden, setOrden] = useState(String(grupo?.display_order ?? proximoOrden));
  const [activo, setActivo] = useState(grupo?.activo ?? true);
  const mut = grupo ? g.update : g.create;
  const cambiado = !grupo || nombre.trim() !== grupo.nombre || kind !== grupo.kind || Number(orden) !== grupo.display_order || activo !== grupo.activo;
  return (
    <Modal titulo={grupo ? `Editar categoría — ${grupo.nombre}` : 'Nueva categoría'} onClose={onClose} guardando={mut.isPending} error={mut.error}
      textoGuardar={grupo ? 'Guardar' : 'Crear categoría'} puedeGuardar={nombre.trim() !== '' && Number(orden) > 0 && cambiado}
      onSubmit={() => {
        const values = { nombre: nombre.trim(), kind, display_order: Number(orden), ...(grupo ? { activo } : {}) };
        if (grupo) g.update.mutate({ id: grupo.id, values }, { onSuccess: onClose });
        else g.create.mutate(values, { onSuccess: onClose });
      }}>
      <label className={etiqueta}>Nombre<input value={nombre} onChange={(e) => setNombre(e.target.value)} className={campo} placeholder="Ej: Combustible" /></label>
      <label className={etiqueta}>Tipo
        <select value={kind} onChange={(e) => setKind(e.target.value as ExpenseCategoryGroupRow['kind'])} className={campo}>
          {(['EXPENSE', 'OWNER_WITHDRAWAL'] as const).map((k) => <option key={k} value={k}>{GROUP_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      {kind === 'OWNER_WITHDRAWAL' && <p className="text-xs text-gray-500">Retiro de socios: sus subcategorías son los socios; no se ofrecen en compras ni gastos.</p>}
      <label className={etiqueta}>Orden en la lista<input type="number" min="1" value={orden} onChange={(e) => setOrden(e.target.value)} className={campo} /></label>
      {grupo && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} /> Activa</label>}
    </Modal>
  );
}

/** Create or edit a SUBCATEGORY: name, category (move), default nature, active and — 0126 — Alimento (no / insumo / flete). */
function SubcategoriaModal({ grupo, sub, grupos, ingredientes, onClose }: {
  grupo: ExpenseCategoryGroupRow; sub?: ExpenseCategoryRow; grupos: ExpenseCategoryGroupRow[]; ingredientes: Ingrediente[]; onClose: () => void;
}) {
  const s = useMasterMutations('expense_category');
  const crearIng = useMasterMutations('feed_ingredient').create;
  const alimento = useAlimentoMutations().categoryFeed;
  const retiro = grupo.kind === 'OWNER_WITHDRAWAL';
  const [nombre, setNombre] = useState(sub?.nombre ?? '');
  const [grupoId, setGrupoId] = useState(sub?.group_id ?? grupo.id);
  const [naturaleza, setNaturaleza] = useState<PurchaseNatureValue>(sub?.default_nature ?? 'OPERATING');
  const [activo, setActivo] = useState(sub?.activo ?? true);
  const rolInicial = sub?.is_feed_freight ? 'FLETE' : sub?.feed_ingredient_id ? 'INSUMO' : 'NO';
  const [rol, setRol] = useState<'NO' | 'INSUMO' | 'FLETE'>(rolInicial);
  // the ingredient: the one already linked, else one with the same name, else it is created with the subcategory name
  const mismoNombre = ingredientes.find((i) => i.nombre.trim().toLowerCase() === nombre.trim().toLowerCase());
  const [ingId, setIngId] = useState(sub?.feed_ingredient_id ?? '');
  const ingElegido = ingId || mismoNombre?.id || '';
  const guardando = s.create.isPending || s.update.isPending || crearIng.isPending || alimento.isPending;
  const error = s.create.error ?? s.update.error ?? crearIng.error ?? alimento.error;

  const guardar = async () => {
    let id = sub?.id;
    const values = { nombre: nombre.trim(), group_id: grupoId, default_nature: retiro ? null : naturaleza, ...(sub ? { activo } : {}) };
    if (sub) {
      const cambio = values.nombre !== sub.nombre || grupoId !== sub.group_id || (!retiro && naturaleza !== sub.default_nature) || activo !== sub.activo;
      if (cambio) await s.update.mutateAsync({ id: sub.id, values });
    } else {
      id = ((await s.create.mutateAsync(values)) as { id: string }).id;
    }
    if (retiro || !id) { onClose(); return; }
    let ingredientId: string | null = null;
    if (rol === 'INSUMO') ingredientId = ingElegido || ((await crearIng.mutateAsync({ nombre: nombre.trim() })) as { id: string }).id;
    const igual = rol === rolInicial && (rol !== 'INSUMO' || ingredientId === (sub?.feed_ingredient_id ?? null));
    if (!igual) await alimento.mutateAsync({ categoryId: id, ingredientId, isFreight: rol === 'FLETE' });
    onClose();
  };

  return (
    <Modal titulo={sub ? `Editar — ${sub.nombre}` : `Nueva subcategoría en ${grupo.nombre}`} onClose={onClose} guardando={guardando} error={error}
      puedeGuardar={nombre.trim() !== ''} onSubmit={() => { void guardar().catch(() => undefined); }}>
      <label className={etiqueta}>Nombre<input value={nombre} onChange={(e) => setNombre(e.target.value)} className={campo} placeholder={retiro ? 'Ej: Socio 1' : 'Ej: Expeller de soja'} /></label>
      {sub && (
        <label className={etiqueta}>Categoría
          <select value={grupoId} onChange={(e) => setGrupoId(e.target.value)} className={campo} aria-label="Mover a la categoría">
            {grupos.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
          </select>
        </label>
      )}
      {!retiro && (
        <label className={etiqueta}>Naturaleza por defecto
          <select value={naturaleza} onChange={(e) => setNaturaleza(e.target.value as PurchaseNatureValue)} className={campo} aria-label="Naturaleza por defecto">
            {NATURES.map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
          </select>
          <span className="block text-xs font-normal text-gray-500 mt-0.5">Se completa sola al cargar un gasto; se puede cambiar en cada operación.</span>
        </label>
      )}
      {!retiro && (
        <fieldset className="border border-[#E4DCC8] rounded-lg p-2 space-y-1">
          <legend className="px-1 text-sm font-medium text-gray-700">Alimento balanceado</legend>
          {(['NO', 'INSUMO', 'FLETE'] as const).map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <input type="radio" checked={rol === r} onChange={() => setRol(r)} />
              {r === 'NO' ? 'No es de alimento' : r === 'INSUMO' ? 'Es un insumo (se cargan los kilos de cada compra)' : 'Es flete de insumos'}
            </label>
          ))}
          {rol === 'INSUMO' && (
            <label className="block text-xs text-gray-700 pl-6">Ingrediente de las recetas
              <select value={ingElegido} onChange={(e) => setIngId(e.target.value)} className={campo}>
                <option value="">Crear «{nombre.trim() || '…'}»</option>
                {ingredientes.filter((i) => i.activo || i.id === ingElegido).map((i) => <option key={i.id} value={i.id}>{i.nombre}</option>)}
              </select>
            </label>
          )}
          {rol !== 'NO' && <p className="text-xs text-gray-500 pl-6">Desde noviembre 2026 estas compras no van al estado de resultados: va el alimento consumido. Los saldos de caja no cambian.</p>}
        </fieldset>
      )}
      {sub && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} /> Activa</label>}
    </Modal>
  );
}
