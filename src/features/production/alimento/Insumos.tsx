import { useState } from 'react';
import { useAuth } from '../../../auth/useAuth';
import { estadoPartes, partesInput, PARTE_VACIA, TOLERANCIA_PARTES, type FeedPurchase, type FeedPurchaseExtra, type ParteInsumoForm } from '../../../target/alimento';
import type { ExpenseCategoryRow } from '../../../target/masters';
import { useMasterList } from '../../admin/useMasters';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { Comprobantes } from '../../caja/Comprobantes';
import { NumeroInput } from '../../../components/NumeroInput';
import { fechaDMA, pesos } from './format';
import { useAlimentoMutations, useFeedPurchases } from './useAlimento';

/**
 * 0138 + owner 2026-11-26: the ingredients of a feed purchase (Alimento balanceado only — the expense categories marked as an
 * ingredient). One invoice with several ingredients stays ONE expense (one payment, one IVA); its split is a costing detail, loaded
 * here from Alimento → Compras e insumos and from Caja (Nuevo gasto, and «⋯» of the expense in Todas las operaciones).
 */

/** The ingredient categories offered (active ones, plus any already used). */
export const insumosDe = (categorias: ExpenseCategoryRow[], usadas: string[] = []) =>
  categorias.filter((c) => c.feed_ingredient_id && (c.activo || usadas.includes(c.id)));

/** One row per ingredient: category, kg and amount on the invoice; the sum must reach the cost basis to the cent. */
export function GrillaInsumos({ partes, onChange, insumos, base, facturaA }: {
  partes: ParteInsumoForm[]; onChange: (p: ParteInsumoForm[]) => void; insumos: ExpenseCategoryRow[]; base: number; facturaA: boolean;
}) {
  const { resta, repetida } = estadoPartes(partes, base);
  const cats = partes.map((p) => p.cat);
  const setParte = (i: number, p: Partial<ParteInsumoForm>) => onChange(partes.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-600">Cargá cada insumo con sus kilos y su importe en la factura{facturaA ? ': el neto, sin IVA, como figura en cada renglón (si un artículo aparece en dos renglones, sumalos)' : ''}. Los importes tienen que sumar {pesos(base)}{facturaA ? ' (el neto gravado)' : ''}: el gasto, el pago y el IVA siguen siendo uno solo.</p>
      {partes.map((p, i) => (
        <div key={i} className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2 items-end">
          <label className="text-xs text-gray-600">Insumo
            <select value={p.cat} onChange={(e) => setParte(i, { cat: e.target.value })} className={campo}>
              <option value="">Elegir…</option>
              {insumos.map((c) => <option key={c.id} value={c.id} disabled={c.id !== p.cat && cats.includes(c.id)}>{c.nombre}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600">Kilos<NumeroInput min="0" step="0.001" value={p.kg} onChange={(e) => setParte(i, { kg: e.target.value })} className={campo} /></label>
          <label className="text-xs text-gray-600">{facturaA ? 'Importe neto (sin IVA)' : 'Importe total'}<NumeroInput min="0" step="0.01" value={p.monto} onChange={(e) => setParte(i, { monto: e.target.value })} className={campo} /></label>
          <button type="button" aria-label="Quitar insumo" disabled={partes.length <= 2} onClick={() => onChange(partes.filter((_, j) => j !== i))}
            className="mb-1 text-xs text-[#A8552E] hover:underline disabled:invisible">Quitar</button>
          {Number(p.kg) > 0 && p.monto !== '' && <p className="col-span-4 -mt-1 text-[11px] text-gray-500">Precio/kg: {pesos(Number(p.monto) / Number(p.kg))}</p>}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...partes, { ...PARTE_VACIA }])} className="text-xs text-[#A8552E] hover:underline">+ Otro insumo</button>
      <p className={`text-xs ${Math.abs(resta) <= TOLERANCIA_PARTES ? 'text-green-700' : 'text-red-700'}`}>
        {resta === 0 ? `Los importes suman ${pesos(base)}.`
          : Math.abs(resta) <= TOLERANCIA_PARTES ? `${resta > 0 ? 'Faltan' : 'Sobran'} ${pesos(Math.abs(resta) / 100)} para llegar a ${pesos(base)}: es redondeo, se ajusta en el último insumo.`
            : `${resta > 0 ? 'Faltan' : 'Sobran'} ${pesos(Math.abs(resta) / 100)} para llegar a ${pesos(base)} (se acepta hasta $1 de diferencia).`}
      </p>
      {repetida && <p className="text-xs text-red-700">Cada insumo va una sola vez.</p>}
    </div>
  );
}

// ── Caja → Nuevo gasto ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface InsumosGastoForm { varios: boolean; kg: string; partes: ParteInsumoForm[]; sinFlete: boolean }
export const INSUMOS_GASTO_VACIO: InsumosGastoForm = { varios: false, kg: '', partes: [{ ...PARTE_VACIA }, { ...PARTE_VACIA }], sinFlete: false };

/** Whether the ingredient block lets the expense be saved: the split complete, or (one ingredient) the kg empty or > 0. */
export function insumosGastoValido(f: InsumosGastoForm, base: number | null): boolean {
  if (f.varios) return base !== null && estadoPartes(f.partes, base).ok;
  return f.kg === '' || Number(f.kg) > 0;
}

/**
 * ADMIN and the CATEGORY of the feed ingredients (owner 2026-11-26: the block shows as soon as the category is chosen, before any
 * subcategory) — or, once a subcategory is chosen, that subcategory being an ingredient. Otherwise Nuevo gasto is exactly as before.
 */
export function useInsumosDelGasto(categoriaId: string, grupoId: string) {
  const { rol } = useAuth();
  const categorias = useMasterList<ExpenseCategoryRow>('expense_category');
  const m = useAlimentoMutations();
  const lista = categorias.data ?? [];
  const activo = rol === 'ADMIN' && (categoriaId !== ''
    ? lista.some((c) => c.id === categoriaId && !!c.feed_ingredient_id)
    : grupoId !== '' && lista.some((c) => c.group_id === grupoId && !!c.feed_ingredient_id));
  /** After the expense is registered: the split, or the kg of its one ingredient (nothing typed → as before, kg later in Alimento). */
  const guardar = async (purchaseId: string, f: InsumosGastoForm, base: number | null) => {
    if (!activo) return;
    if (f.varios && base !== null) await m.parts.mutateAsync({ purchaseId, parts: partesInput(f.partes, base), noFreight: f.sinFlete });
    else if (Number(f.kg) > 0) await m.kg.mutateAsync({ purchaseId, kg: Number(f.kg), noFreight: f.sinFlete });
  };
  return { activo, insumos: insumosDe(lista), guardar, guardando: m.parts.isPending || m.kg.isPending, error: m.parts.error ?? m.kg.error ?? null };
}

/** The block of Nuevo gasto for a feed ingredient: its kg, or «Esta factura trae varios insumos», and «Confirmar flete $0». */
export function BloqueInsumosGasto({ value, onChange, categoriaId, insumos, base, facturaA }: {
  value: InsumosGastoForm; onChange: (v: InsumosGastoForm) => void; categoriaId: string; insumos: ExpenseCategoryRow[]; base: number | null; facturaA: boolean;
}) {
  const set = (p: Partial<InsumosGastoForm>) => onChange({ ...value, ...p });
  const kg = Number(value.kg);
  const alternarVarios = (varios: boolean) => {
    const vacias = value.partes.every((p) => p.cat === '' && p.kg === '' && p.monto === '');
    set({ varios, ...(varios && vacias ? { partes: [{ cat: categoriaId, kg: value.kg, monto: '' }, { ...PARTE_VACIA }] } : {}) });
  };
  return (
    <fieldset className="space-y-2 border border-[#E4DCC8] rounded-lg p-2">
      <legend className={etiqueta}>Insumo de alimento balanceado</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.varios} onChange={(e) => alternarVarios(e.target.checked)} />
        Esta factura trae varios insumos</label>
      {!value.varios ? (
        <>
          <label className={etiqueta}>Kilos comprados (opcional)
            <NumeroInput min="0" step="0.001" value={value.kg} onChange={(e) => set({ kg: e.target.value })} className={campo} />
          </label>
          {kg > 0 && base !== null && base > 0 && <p className="text-xs text-gray-600">Precio/kg: {pesos(base / kg)}{facturaA ? ' (sin IVA)' : ''}</p>}
          {value.kg === '' && <p className="text-xs text-[#8A7A5C]">Si no los sabés ahora, quedan para cargar en Alimento → Compras e insumos.</p>}
        </>
      ) : base === null ? (
        <p className="text-xs text-amber-800">Completá la Factura A: los importes de cada insumo se reparten sobre el neto.</p>
      ) : (
        <GrillaInsumos partes={value.partes} onChange={(partes) => set({ partes })} insumos={insumos} base={base} facturaA={facturaA} />
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.sinFlete} disabled={!value.varios && !(kg > 0)} onChange={(e) => set({ sinFlete: e.target.checked })} />
        Confirmar flete $0 (vino sin flete o el flete está incluido en el precio)</label>
    </fieldset>
  );
}

// ── Kilos de una compra (Alimento → Compras e insumos, Caja → «⋯» del gasto) ──────────────────────────────────────────────────
/**
 * The kg of a purchase and, when its invoice brings several ingredients (0138), each one: its ingredient category, kg and amount
 * on the invoice (the neto with Factura A, otherwise the total). The amounts must add up exactly to the purchase amount — the
 * expense, its payment and its IVA stay one; the backend refuses anything else.
 */
export function KgModal({ filas, extra, onClose }: { filas: FeedPurchase[]; extra?: FeedPurchaseExtra; onClose: () => void }) {
  const m = useAlimentoMutations();
  const categorias = useMasterList<ExpenseCategoryRow>('expense_category');
  const insumos = insumosDe(categorias.data ?? [], filas.map((f) => f.expense_category_id));
  const compra = filas[0];
  const teniaPartes = compra.part_position !== null;
  const base = filas.reduce((t, f) => t + Math.round(f.cost_amount * 100), 0) / 100;   // the purchase amount the costing uses (neto with Factura A)
  const kgCompra = compra.purchase_quantity_kg ?? compra.quantity_kg;
  const [varios, setVarios] = useState(teniaPartes);
  const [kg, setKg] = useState(kgCompra === null ? '' : String(kgCompra));
  const [sinFlete, setSinFlete] = useState(compra.no_freight);
  const [partes, setPartes] = useState<ParteInsumoForm[]>(teniaPartes
    ? filas.map((f) => ({ cat: f.expense_category_id, kg: String(f.quantity_kg ?? ''), monto: String(f.cost_amount) }))
    : [{ cat: compra.expense_category_id, kg: kgCompra === null ? '' : String(kgCompra), monto: '' }, { ...PARTE_VACIA }]);
  const n = Number(kg);
  const flete = compra.freight_amount > 0 || filas.some((f) => f.freight_amount > 0);
  const guardando = m.kg.isPending || m.parts.isPending;
  const puede = varios ? estadoPartes(partes, base).ok : n > 0 && (teniaPartes || n !== kgCompra || sinFlete !== compra.no_freight);
  async function guardar() {
    if (varios) {
      await m.parts.mutateAsync({ purchaseId: compra.purchase_id, parts: partesInput(partes, base), noFreight: sinFlete });
    } else {
      if (teniaPartes) await m.parts.mutateAsync({ purchaseId: compra.purchase_id, parts: [] });
      await m.kg.mutateAsync({ purchaseId: compra.purchase_id, kg: n, noFreight: sinFlete });
    }
    onClose();
  }
  return (
    <Modal titulo={`Kilos — ${filas.map((f) => f.ingredient_nombre).join(' + ')} ${fechaDMA(compra.economic_date)}`} onClose={onClose} guardando={guardando}
      error={m.parts.error ?? m.kg.error ?? categorias.error} puedeGuardar={puede} onSubmit={() => { guardar().catch(() => {}); }}>
      <p className="text-sm text-gray-700">{compra.supplier_name ?? '—'} · {pesos(base)}{compra.invoice_a ? ' sin IVA (Factura A)' : ''}</p>
      {extra?.concepto && <p className="text-sm text-gray-700">Concepto del gasto: <i>«{extra.concepto}»</i></p>}
      {extra && (extra.numero || extra.docs.length > 0) && <p className="flex items-center gap-2 text-sm text-gray-700">Factura{extra.numero ? ` ${extra.numero}` : ''}{extra.docs.length > 0 && <>: <Comprobantes docs={extra.docs} /></>}</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={varios} onChange={(e) => setVarios(e.target.checked)} />
        Esta factura trae varios insumos</label>
      {!varios ? (
        <>
          <label className={etiqueta}>Kilos comprados<NumeroInput min="0" step="0.001" value={kg} onChange={(e) => setKg(e.target.value)} className={campo} /></label>
          {n > 0 && <p className="text-xs text-gray-600">Precio/kg: {pesos(base / n)}</p>}
          {teniaPartes && <p className="text-xs text-amber-800">Al guardar se quita el detalle por insumo: la compra vuelve a ser de un solo insumo.</p>}
        </>
      ) : (
        <GrillaInsumos partes={partes} onChange={setPartes} insumos={insumos} base={base} facturaA={compra.invoice_a} />
      )}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sinFlete} disabled={flete} onChange={(e) => setSinFlete(e.target.checked)} />
        Confirmar flete $0 (vino sin flete o el flete está incluido en el precio)</label>
    </Modal>
  );
}

/**
 * Caja (ADMIN): the feed purchases by purchase root — the ingredient subcategories of each one in invoice order (to show «Maíz + Soja»
 * on its row) and its rows for the Kilos window. Purchases of other categories are simply absent.
 */
export function useComprasDeInsumos() {
  const { rol } = useAuth();
  const q = useFeedPurchases(rol === 'ADMIN');
  const porRaiz = new Map<string, FeedPurchase[]>();
  for (const c of q.data ?? []) porRaiz.set(c.purchase_root_id, [...(porRaiz.get(c.purchase_root_id) ?? []), c]);
  for (const filas of porRaiz.values()) filas.sort((a, b) => (a.part_position ?? 0) - (b.part_position ?? 0));
  return porRaiz;
}
