import { useState } from 'react';
import { defaultNatureOf, NATURE_LABEL, selectableGroups, selectableSubcategories, socios } from '../../target/expenseCategories';
import type { PurchaseNatureValue } from '../../target/masters';
import { useExpenseCategories, useExpenseGroups } from './useTreasury';

const NATURES: PurchaseNatureValue[] = ['OPERATING', 'REINVESTMENT', 'INVESTMENT'];

/**
 * ADR-024 — Categoría → Subcategoría (→ Naturaleza). Choosing a category filters its subcategories; choosing a subcategory
 * pre-fills its default nature, which the owner may still change for this operation only (the master default never changes).
 * Reserved subcategories (Retiros de socios, IVA / Ganancias) are never offered. DIRECT / INDIRECT is not shown.
 */
export function SelectorCategoria({ subcategoriaId, onSubcategoria, naturaleza, onNaturaleza, campo, etiqueta = '', compacto = false, conRetiros = false, subcategoriaFija, onGrupo }: {
  subcategoriaId: string; onSubcategoria: (id: string) => void;
  naturaleza?: PurchaseNatureValue; onNaturaleza?: (n: PurchaseNatureValue) => void;
  campo: string; etiqueta?: string; compacto?: boolean;
  /** Nuevo gasto (owner 2026-11-18): «Retiros de socios» is offered too — a socio as subcategory; the form records a withdrawal. */
  conRetiros?: boolean;
  /** Nuevo gasto (owner 2026-11-26): an invoice with several feed ingredients — the subcategory is the first ingredient below; this note replaces its select. */
  subcategoriaFija?: string;
  /** The category chosen (before any subcategory). */
  onGrupo?: (id: string) => void;
}) {
  const grupos = useExpenseGroups();
  const subs = useExpenseCategories();
  const g = grupos.data ?? [];
  const s = subs.data ?? [];
  const listaSocios = conRetiros ? socios(g, s) : [];
  const gruposRetiro = g.filter((x) => listaSocios.some((y) => y.group_id === x.id));
  const subsDe = (grupo: string) => (gruposRetiro.some((x) => x.id === grupo) ? listaSocios.filter((y) => y.group_id === grupo) : selectableSubcategories(g, s, grupo));
  const [grupoElegido, setGrupoElegido] = useState('');
  const grupoId = s.find((x) => x.id === subcategoriaId)?.group_id ?? grupoElegido;
  const conNaturaleza = naturaleza !== undefined && onNaturaleza !== undefined;
  const elegirSub = (id: string) => {
    onSubcategoria(id);
    if (id && onNaturaleza) onNaturaleza(defaultNatureOf(s, id));
  };

  const categoria = (
    <select aria-label="Categoría" value={grupoId} onChange={(e) => { setGrupoElegido(e.target.value); onGrupo?.(e.target.value); onSubcategoria(''); }} className={campo}>
      <option value="">{compacto ? 'Categoría…' : 'Elegir categoría…'}</option>
      {selectableGroups(g, s).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
      {gruposRetiro.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
    </select>
  );
  const subcategoria = (
    <select aria-label="Subcategoría" value={subcategoriaId} onChange={(e) => elegirSub(e.target.value)} className={campo} disabled={grupoId === ''}>
      <option value="">{compacto ? 'Subcategoría…' : 'Elegir subcategoría…'}</option>
      {grupoId !== '' && subsDe(grupoId).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
    </select>
  );
  const nat = conNaturaleza && (
    <select aria-label="Naturaleza" value={naturaleza} onChange={(e) => onNaturaleza(e.target.value as PurchaseNatureValue)} className={campo}
      title="Se completa con la naturaleza de la subcategoría; podés cambiarla para esta operación">
      {NATURES.map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
    </select>
  );

  if (compacto) return <>{categoria}{subcategoria}{nat}</>;
  return (
    <div className={`grid grid-cols-1 gap-2 ${conNaturaleza ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      <label className={etiqueta}>Categoría{categoria}</label>
      {subcategoriaFija !== undefined
        ? <div className={etiqueta}>Subcategoría<p className="mt-1 text-xs text-[#6B5D45]">{subcategoriaFija}</p></div>
        : <label className={etiqueta}>Subcategoría{subcategoria}</label>}
      {conNaturaleza && <label className={etiqueta}>Naturaleza (automática, editable){nat}</label>}
    </div>
  );
}
