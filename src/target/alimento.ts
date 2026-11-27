/**
 * Alimento Balanceado (0125 / 0126) over the target schema. Transport only: every amount, consumption and cost is
 * computed by the backend views (report_feed_*); writes are the audited RPCs. Monthly stock close, recipe comments /
 * standard batch / (de)activation, feed categories, purchase kg and freight split are ADMIN; the views are ADMIN-only
 * except feed_stock_period (both roles read which months are closed).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';
import { listDocumentLinks, type ViewableDocument } from './documents';

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const trimOrNull = (s?: string | null) => (s && s.trim() !== '' ? s.trim() : null);

// ── cierre mensual ──────────────────────────────────────────────────────────
export interface FeedStockPeriod {
  period: string; status: 'CLOSED' | 'REOPENED'; comment: string | null; closed_by: string | null; closed_at: string | null;
  reopened_by: string | null; reopened_at: string | null; reopen_reason: string | null;
}
export const listFeedStockPeriods = (c: SupabaseClient) =>
  readTable<FeedStockPeriod>(c, 'feed_stock_period', (q) => q.order('period'));

export interface FeedMonthRow {
  feed_type_id: string; feed_type_nombre: string; period: string; opening_kg: number | null; manufactured_kg: number;
  external_sale_kg: number; loss_kg: number; adjustment_negative_kg: number; adjustment_positive_kg: number; closing_kg: number;
  internal_consumption_kg: number | null;
}
export async function listFeedMonths(c: SupabaseClient): Promise<FeedMonthRow[]> {
  const rows = await readView<FeedMonthRow>(c, 'report_feed_month', (q) => q.order('period'));
  return rows.map((r) => ({
    ...r, opening_kg: n(r.opening_kg), manufactured_kg: Number(r.manufactured_kg), external_sale_kg: Number(r.external_sale_kg), loss_kg: Number(r.loss_kg),
    adjustment_negative_kg: Number(r.adjustment_negative_kg), adjustment_positive_kg: Number(r.adjustment_positive_kg), closing_kg: Number(r.closing_kg),
    internal_consumption_kg: n(r.internal_consumption_kg),
  }));
}
export const closeFeedMonth = (c: SupabaseClient, p: { period: string; counts: { feedTypeId: string; quantityKg: number }[]; comment?: string | null }) =>
  callRpc<{ period: string; status: string }>(c, 'close_feed_month', {
    p_period: p.period, p_counts: p.counts.map((x) => ({ feed_type_id: x.feedTypeId, quantity_kg: x.quantityKg })), p_comment: trimOrNull(p.comment),
  });
export const reopenFeedMonth = (c: SupabaseClient, p: { period: string; reason: string }) =>
  callRpc<{ period: string; status: string }>(c, 'reopen_feed_month', { p_period: p.period, p_reason: p.reason });

// ── recetas ─────────────────────────────────────────────────────────────────
export interface RecipeChange {
  id: number; performed_at: string; performed_by_name: string | null; feed_type_id: string | null; feed_type_nombre: string | null;
  entity_type: 'feed_formula_version' | 'feed_type'; action: 'PUBLISH' | 'COMMENT' | 'STANDARD_BATCH' | 'ACTIVATE' | 'DEACTIVATE';
  before_values: Record<string, unknown> | null; after_values: Record<string, unknown> | null; reason: string | null;
}
export const listRecipeChanges = (c: SupabaseClient) =>
  readView<RecipeChange>(c, 'report_feed_recipe_change', (q) => q.order('performed_at', { ascending: false }).limit(200));
export const setFormulaComment = (c: SupabaseClient, p: { formulaVersionId: string; comment: string }) =>
  callRpc(c, 'set_feed_formula_comment', { p_formula_version_id: p.formulaVersionId, p_comment: p.comment });
export const setStandardBatch = (c: SupabaseClient, p: { feedTypeId: string; kg: number }) =>
  callRpc(c, 'set_feed_type_standard_batch', { p_feed_type_id: p.feedTypeId, p_standard_batch_kg: p.kg });
export const setFeedTypeActive = (c: SupabaseClient, p: { feedTypeId: string; active: boolean }) =>
  callRpc(c, 'set_feed_type_active', { p_feed_type_id: p.feedTypeId, p_active: p.active });

// ── compras, flete, costos ──────────────────────────────────────────────────
export type FreightStatus = 'ASIGNADO' | 'SIN_FLETE' | 'PENDIENTE';
export interface FeedPurchase {
  purchase_root_id: string; purchase_id: string; economic_date: string; period: string; feed_ingredient_id: string; ingredient_nombre: string;
  supplier_name: string | null; amount_total: number; invoice_a: boolean; cost_amount: number; quantity_kg: number | null; no_freight: boolean;
  freight_amount: number; freight_cost: number; freight_status: FreightStatus; price_per_kg: number | null; cost_per_kg: number | null;
  /** 0138: an invoice with several ingredients is one row per ingredient (part_position 1…n; null = a purchase of one ingredient). */
  expense_category_id: string; part_position: number | null; purchase_quantity_kg: number | null;
}
export async function listFeedPurchases(c: SupabaseClient): Promise<FeedPurchase[]> {
  const rows = await readView<FeedPurchase>(c, 'report_feed_purchase', (q) => q.order('economic_date', { ascending: false }));
  return rows.map((r) => ({
    ...r, amount_total: Number(r.amount_total), cost_amount: Number(r.cost_amount), quantity_kg: n(r.quantity_kg), freight_amount: Number(r.freight_amount),
    freight_cost: Number(r.freight_cost), price_per_kg: n(r.price_per_kg), cost_per_kg: n(r.cost_per_kg),
    part_position: r.part_position == null ? null : Number(r.part_position), purchase_quantity_kg: n(r.purchase_quantity_kg),
  }));
}
/**
 * What the owner wrote and attached when the expense was registered in Caja: the «Concepto del gasto» (purchases.subcategory, or the
 * item descriptions of an itemized invoice — often the kg), the invoice number and the original invoice / receipt (ERP upload or
 * WhatsApp). Keyed by purchase_root_id; read in chunks.
 */
export interface FeedPurchaseExtra { concepto: string | null; numero: string | null; docs: ViewableDocument[] }
export async function listFeedPurchaseExtras(c: SupabaseClient, compras: Pick<FeedPurchase, 'purchase_root_id' | 'purchase_id'>[]): Promise<Map<string, FeedPurchaseExtra>> {
  const out = new Map<string, FeedPurchaseExtra>();
  const raizDe = new Map<string, string>();
  for (const x of compras) { raizDe.set(x.purchase_root_id, x.purchase_root_id); raizDe.set(x.purchase_id, x.purchase_root_id); }
  const vigente = new Set(compras.map((x) => x.purchase_id));
  const ids = [...raizDe.keys()];
  const add = (id: string, f: (e: FeedPurchaseExtra) => void) => {
    const r = raizDe.get(id); if (!r) return;
    const e = out.get(r) ?? { concepto: null, numero: null, docs: [] }; f(e); out.set(r, e);
  };
  for (let i = 0; i < ids.length; i += 80) {
    const parte = ids.slice(i, i + 80);
    const [cabeceras, lineas, adjuntos, links] = await Promise.all([
      readTable<{ id: string; subcategory: string | null; supplier_invoice_number: string | null }>(c, 'purchases', (q) => q.in('id', parte), 'id, subcategory, supplier_invoice_number'),
      readTable<{ purchase_id: string; descripcion: string | null }>(c, 'purchase_line', (q) => q.in('purchase_id', parte), 'purchase_id, descripcion'),
      readTable<ViewableDocument & { purchase_id: string }>(c, 'purchase_attachment', (q) => q.in('purchase_id', parte), 'purchase_id, storage_path, file_name, content_type'),
      listDocumentLinks(c, 'PURCHASE', parte),
    ]);
    // the version in force (purchase_id) wins over the root's
    const items = new Map<string, string[]>();
    for (const l of lineas) if (l.descripcion?.trim()) items.set(l.purchase_id, [...(items.get(l.purchase_id) ?? []), l.descripcion.trim()]);
    for (const p of cabeceras) {
      const concepto = p.subcategory?.trim() || items.get(p.id)?.join(' · ') || null;
      add(p.id, (e) => {
        if (concepto && (!e.concepto || vigente.has(p.id))) e.concepto = concepto;
        if (p.supplier_invoice_number && (!e.numero || vigente.has(p.id))) e.numero = p.supplier_invoice_number;
      });
    }
    for (const a of adjuntos) add(a.purchase_id, (e) => e.docs.push(a));
    for (const [id, ds] of links) add(id, (e) => e.docs.push(...ds));
  }
  return out;
}

export interface FeedFreight {
  freight_purchase_root_id: string; purchase_id: string; economic_date: string; supplier_name: string | null; supplier_invoice_number: string | null;
  amount_total: number; allocated: number; remaining: number;
}
export async function listFeedFreights(c: SupabaseClient): Promise<FeedFreight[]> {
  const rows = await readView<FeedFreight>(c, 'report_feed_freight', (q) => q.order('economic_date', { ascending: false }));
  return rows.map((r) => ({ ...r, amount_total: Number(r.amount_total), allocated: Number(r.allocated), remaining: Number(r.remaining) }));
}
export interface RecipeCostMonth {
  feed_type_id: string; feed_type_nombre: string; period: string; formula_version_id: string; version: number; cost_per_kg: number | null; estimated: boolean;
  missing_ingredients: string[];
}
/** 0126: an ingredient's cost per kg in a month with purchases (weighted by kg, freight included; Factura A without IVA). */
export interface IngredientCostMonth { feed_ingredient_id: string; ingredient_nombre: string; period: string; cost_per_kg: number; freight_pending: boolean }
export async function listIngredientCosts(c: SupabaseClient): Promise<IngredientCostMonth[]> {
  const rows = await readView<IngredientCostMonth>(c, 'report_feed_ingredient_cost_month', (q) => q.order('period'),
    'feed_ingredient_id, ingredient_nombre, period, cost_per_kg, freight_pending');
  return rows.map((r) => ({ ...r, cost_per_kg: Number(r.cost_per_kg) }));
}
/** The view's rule (0126): an ingredient's cost in a month = that month's or, without purchases that month, the latest earlier one. */
export function ultimoCostoConocido(costos: readonly IngredientCostMonth[], ingredientId: string, period: string): IngredientCostMonth | null {
  let r: IngredientCostMonth | null = null;
  for (const c of costos) if (c.feed_ingredient_id === ingredientId && c.period <= period && (!r || c.period > r.period)) r = c;
  return r;
}
export async function listRecipeCosts(c: SupabaseClient): Promise<RecipeCostMonth[]> {
  const rows = await readView<RecipeCostMonth>(c, 'report_feed_recipe_cost_month', (q) => q.order('period'));
  return rows.map((r) => ({ ...r, cost_per_kg: n(r.cost_per_kg), missing_ingredients: r.missing_ingredients ?? [] }));
}
export interface ConsumptionCost {
  feed_type_id: string; feed_type_nombre: string; period: string; internal_consumption_kg: number | null; cost_per_kg: number | null;
  estimated: boolean | null; consumption_cost: number | null;
}
export async function listConsumptionCosts(c: SupabaseClient): Promise<ConsumptionCost[]> {
  const rows = await readView<ConsumptionCost>(c, 'report_feed_consumption_cost', (q) => q.order('period'));
  return rows.map((r) => ({ ...r, internal_consumption_kg: n(r.internal_consumption_kg), cost_per_kg: n(r.cost_per_kg), consumption_cost: n(r.consumption_cost) }));
}

export const setExpenseCategoryFeed = (c: SupabaseClient, p: { categoryId: string; ingredientId: string | null; isFreight: boolean }) =>
  callRpc(c, 'set_expense_category_feed', { p_category_id: p.categoryId, p_feed_ingredient_id: p.ingredientId, p_is_feed_freight: p.isFreight });
export const setFeedPurchaseQuantity = (c: SupabaseClient, p: { purchaseId: string; kg: number; noFreight?: boolean | null }) =>
  callRpc(c, 'set_feed_purchase_quantity', { p_purchase_id: p.purchaseId, p_quantity_kg: p.kg, p_no_freight: p.noFreight ?? null });
/** 0138: the ingredients of one invoice (two or more; [] removes the split). Amounts add up to the neto (Factura A) or the total. */
export interface FeedPurchasePartInput { categoryId: string; kg: number; amount: number }
export const setFeedPurchaseParts = (c: SupabaseClient, p: { purchaseId: string; parts: FeedPurchasePartInput[]; noFreight?: boolean | null }) =>
  callRpc<{ parts: number; quantity_kg: number }>(c, 'set_feed_purchase_parts', {
    p_purchase_id: p.purchaseId, p_parts: p.parts.map((x) => ({ expense_category_id: x.categoryId, quantity_kg: x.kg, amount: x.amount })), p_no_freight: p.noFreight ?? null,
  });
/**
 * The rows of «Esta factura trae varios insumos» as typed (Alimento → Kilos and Caja → Nuevo gasto). Valid when there are two or more,
 * each with its ingredient category (once), kg > 0 and an amount, and the amounts add up to the cost basis to the cent (the neto with
 * Factura A, otherwise the total) — what set_feed_purchase_parts accepts. `resta` is in cents (positive: still missing; negative: over).
 */
export interface ParteInsumoForm { cat: string; kg: string; monto: string; /** Nuevo gasto with Factura A: the IVA rate of the row */ iva?: string }
export const PARTE_VACIA: ParteInsumoForm = { cat: '', kg: '', monto: '' };
export const centavos = (v: number | string) => Math.round(Number(v) * 100);
/** The sum of the amounts typed in the rows (Nuevo gasto with Factura A: it IS the neto gravado of the invoice). */
export const sumaPartes = (partes: ParteInsumoForm[]) => partes.reduce((t, p) => t + (p.monto === '' ? 0 : centavos(p.monto)), 0) / 100;
/** owner 2026-11-26: up to $1 of difference (rounding of the invoice) is accepted and adjusted in the last ingredient. */
export const TOLERANCIA_PARTES = 100;   // cents
export function estadoPartes(partes: ParteInsumoForm[], base: number): { resta: number; repetida: boolean; ok: boolean } {
  const resta = centavos(base) - partes.reduce((t, p) => t + (p.monto === '' ? 0 : centavos(p.monto)), 0);
  const cats = partes.map((p) => p.cat).filter(Boolean);
  const repetida = new Set(cats).size !== cats.length;
  const ultimo = partes.length > 0 && partes[partes.length - 1].monto !== '' ? centavos(partes[partes.length - 1].monto) : 0;
  const ok = partes.length >= 2 && partes.every((p) => p.cat !== '' && Number(p.kg) > 0 && p.monto !== '' && Number(p.monto) >= 0) && !repetida
    && Math.abs(resta) <= TOLERANCIA_PARTES && ultimo + resta >= 0;
  return { resta, repetida, ok };
}
/** What set_feed_purchase_parts receives: the amounts add up exactly to the base (the difference within $1 goes to the last ingredient). */
export function partesInput(partes: ParteInsumoForm[], base: number): FeedPurchasePartInput[] {
  const { resta } = estadoPartes(partes, base);
  return partes.map((p, i) => ({
    categoryId: p.cat, kg: Number(p.kg),
    amount: i === partes.length - 1 && Math.abs(resta) <= TOLERANCIA_PARTES ? (centavos(p.monto) + resta) / 100 : Number(p.monto),
  }));
}

/** 0141: the freight allocations (ADMIN) — which freight expense was allocated to which purchase, and how much. */
export interface FeedFreightAllocation { freight_purchase_root_id: string; purchase_root_id: string; amount: number; allocated_at: string }
export async function listFeedFreightAllocations(c: SupabaseClient): Promise<FeedFreightAllocation[]> {
  const rows = await readTable<FeedFreightAllocation>(c, 'feed_freight_allocation', (q) => q.order('allocated_at'), 'freight_purchase_root_id, purchase_root_id, amount, allocated_at');
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}
/** 0141: remove one allocation (audited, with its reason): its amount is free again on the freight. */
export const unallocateFeedFreight = (c: SupabaseClient, p: { freightPurchaseId: string; purchaseId: string; reason: string }) =>
  callRpc<{ released: number; remaining: number }>(c, 'unallocate_feed_freight', { p_freight_purchase_id: p.freightPurchaseId, p_purchase_id: p.purchaseId, p_reason: p.reason.trim() });
export const allocateFeedFreight = (c: SupabaseClient, p: { freightPurchaseId: string; allocations: { purchaseId: string; amount: number }[] }) =>
  callRpc<{ allocated: number; remaining: number }>(c, 'allocate_feed_freight', {
    p_freight_purchase_id: p.freightPurchaseId, p_allocations: p.allocations.map((a) => ({ purchase_id: a.purchaseId, amount: a.amount })),
  });

/** Split an amount by kg; rounding goes to the last row so the parts add up exactly (the backend refuses more than what is left). */
export function splitByKg(total: number, rows: { id: string; kg: number }[]): Record<string, number> {
  const kg = rows.reduce((t, r) => t + r.kg, 0);
  const out: Record<string, number> = {};
  let used = 0;
  rows.forEach((r, i) => {
    const part = i === rows.length - 1 ? Math.round((total - used) * 100) / 100 : Math.round(((total * r.kg) / kg) * 100) / 100;
    out[r.id] = part; used = Math.round((used + part) * 100) / 100;
  });
  return out;
}
