/**
 * ADR-024 (0096) — expense CATEGORY → SUBCATEGORY. The parent is `expense_category_group`; every `expense_category` row is a
 * subcategory (ids kept) with its group and its default purchase nature. Pure helpers: what a form may offer, the tree of the
 * administration screen, the socios of a withdrawal. The database is the authority (a reserved subcategory is refused there
 * too: CATEGORY_NOT_SELECTABLE). DIRECT / INDIRECT is in standby and never shown.
 */
import type { ExpenseCategoryGroupRow, ExpenseCategoryRow, PurchaseNatureValue } from './masters';

export const NATURE_LABEL: Record<PurchaseNatureValue, string> = { OPERATING: 'Operativa', REINVESTMENT: 'Reinversión', INVESTMENT: 'Inversión' };
export const GROUP_KIND_LABEL: Record<ExpenseCategoryGroupRow['kind'], string> = { EXPENSE: 'Gasto', OWNER_WITHDRAWAL: 'Retiro de socios' };

const byOrder = (a: ExpenseCategoryGroupRow, b: ExpenseCategoryGroupRow) => a.display_order - b.display_order || a.nombre.localeCompare(b.nombre, 'es');
const byName = (a: { nombre: string }, b: { nombre: string }) => a.nombre.localeCompare(b.nombre, 'es');

/** A subcategory a purchase / gasto may use: active, not fiscal-reserved, in an active EXPENSE category. */
export function isSelectable(sub: ExpenseCategoryRow, groups: readonly ExpenseCategoryGroupRow[]): boolean {
  const g = groups.find((x) => x.id === sub.group_id);
  return sub.activo && !sub.fiscal_reserved && !!g && g.activo && g.kind === 'EXPENSE';
}

/** Categories offered in a purchase / gasto form (in display order), each with at least one selectable subcategory. */
export function selectableGroups(groups: readonly ExpenseCategoryGroupRow[], subs: readonly ExpenseCategoryRow[]): ExpenseCategoryGroupRow[] {
  return groups.filter((g) => subs.some((s) => s.group_id === g.id && isSelectable(s, groups))).sort(byOrder);
}

/** The selectable subcategories of one category, by name. */
export function selectableSubcategories(groups: readonly ExpenseCategoryGroupRow[], subs: readonly ExpenseCategoryRow[], groupId: string): ExpenseCategoryRow[] {
  return subs.filter((s) => s.group_id === groupId && isSelectable(s, groups)).sort(byName);
}

/** The nature a form pre-fills for a subcategory (the operation may override it). */
export function defaultNatureOf(subs: readonly ExpenseCategoryRow[], subId: string): PurchaseNatureValue {
  return subs.find((s) => s.id === subId)?.default_nature ?? 'OPERATING';
}

/** The socios of a Retiro de socios: the active subcategories of the OWNER_WITHDRAWAL categories. */
export function socios(groups: readonly ExpenseCategoryGroupRow[], subs: readonly ExpenseCategoryRow[]): ExpenseCategoryRow[] {
  const ids = new Set(groups.filter((g) => g.kind === 'OWNER_WITHDRAWAL' && g.activo).map((g) => g.id));
  return subs.filter((s) => ids.has(s.group_id) && s.activo).sort(byName);
}

/** "Categoría › Subcategoría" for a subcategory id (history keeps pointing to the same subcategory). */
export function categoryPath(groups: readonly ExpenseCategoryGroupRow[], subs: readonly ExpenseCategoryRow[], subId: string | null): string | null {
  if (!subId) return null;
  const s = subs.find((x) => x.id === subId);
  if (!s) return null;
  const g = groups.find((x) => x.id === s.group_id);
  return g ? `${g.nombre} › ${s.nombre}` : s.nombre;
}

/** The administration tree: every category (display order) with every subcategory (active first, then by name). */
export function categoryTree(groups: readonly ExpenseCategoryGroupRow[], subs: readonly ExpenseCategoryRow[]) {
  return [...groups].sort(byOrder).map((g) => ({
    group: g,
    subs: subs.filter((s) => s.group_id === g.id).sort((a, b) => Number(b.activo) - Number(a.activo) || byName(a, b)),
  }));
}
