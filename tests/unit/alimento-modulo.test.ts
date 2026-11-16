/** Alimento Balanceado (0125 / 0126): presentation helpers, freight split, RPC payloads, allowlists and wiring. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocateFeedFreight, closeFeedMonth, setFeedPurchaseQuantity, splitByKg } from '../../src/target/alimento';
import { TARGET_READ_TABLES, TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';
import { escalar, finDeMes, kgLinea, meses, periodoComparable } from '../../src/features/production/alimento/format';

const DIR = resolve(__dirname, '../../src/features/production/alimento');
function rpcStub() {
  const calls: { fn: string; args: unknown }[] = [];
  const client = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: {}, error: null }; } };
  return { client: client as never, calls };
}

describe('Alimento Balanceado — módulo real', () => {
  it('same days of the previous month, month lists and month end', () => {
    expect(periodoComparable('2026-11-14')).toMatchObject({ desde: '2026-11-01', hasta: '2026-11-14', desdeAnt: '2026-10-01', hastaAnt: '2026-10-14', mesAnt: '2026-10-01' });
    expect(periodoComparable('2026-03-31')).toMatchObject({ hastaAnt: '2026-02-28' });
    expect(periodoComparable('2027-01-10').mesAnt).toBe('2026-12-01');
    expect(meses('2026-11-01', '2027-02-10')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
    expect(finDeMes('2026-02-01')).toBe('2026-02-28');
  });
  it('premix with 3 decimals; batch scaling keeps proportions', () => {
    expect(kgLinea(0.29, 'PREMIX')).toBe('0,290 kg');
    expect(kgLinea(119.21, 'MACRO')).toBe('119,21 kg');
    // the owner's Recría for a 150 kg batch (2026-11-16): rounded UP — premix to 10 g, macro to 100 g
    const rec = [['bio', 0.486, 'PREMIX'], ['carb', 1.495, 'PREMIX'], ['nqn', 3.738, 'PREMIX'], ['afre', 27.66, 'MACRO'], ['soja', 37.38, 'MACRO'], ['maiz', 79.24, 'MACRO']]
      .map(([ingredient_id, kg, section]) => ({ ingredient_id: ingredient_id as string, quantity_kg: ((kg as number) * 100) / 150, section: section as 'PREMIX' | 'MACRO' }));
    expect(escalar(rec, 100, 150).map((l) => l.quantity_kg)).toEqual([0.49, 1.5, 3.74, 27.7, 37.4, 79.3]);
    expect(escalar([{ ingredient_id: 'x', quantity_kg: 0.745, section: 'PREMIX' as const }], 3, 6)[0].quantity_kg).toBe(1.49);   // a binary-float residue (1,4900000000000002) does not round up
    expect(escalar(rec, 100, 100)).toBe(rec);   // the recipe's own batch: shown as stored
  });
  it('freight split by kg adds up exactly (rounding on the last row)', () => {
    expect(splitByKg(1000, [{ id: 'a', kg: 1 }, { id: 'b', kg: 1 }, { id: 'c', kg: 1 }])).toEqual({ a: 333.33, b: 333.33, c: 333.34 });
  });
  it('writes are the 0125 / 0126 RPCs with their payloads', async () => {
    const { client, calls } = rpcStub();
    await closeFeedMonth(client, { period: '2026-11-01', counts: [{ feedTypeId: 't', quantityKg: 120 }], comment: ' ' });
    await setFeedPurchaseQuantity(client, { purchaseId: 'p', kg: 1000 });
    await allocateFeedFreight(client, { freightPurchaseId: 'f', allocations: [{ purchaseId: 'p', amount: 20000 }] });
    expect(calls).toEqual([
      { fn: 'close_feed_month', args: { p_period: '2026-11-01', p_counts: [{ feed_type_id: 't', quantity_kg: 120 }], p_comment: null } },
      { fn: 'set_feed_purchase_quantity', args: { p_purchase_id: 'p', p_quantity_kg: 1000, p_no_freight: null } },
      { fn: 'allocate_feed_freight', args: { p_freight_purchase_id: 'f', p_allocations: [{ purchase_id: 'p', amount: 20000 }] } },
    ]);
  });
  it('allowlists carry the new views, table and RPCs', () => {
    for (const v of ['report_feed_month', 'report_feed_recipe_change', 'report_feed_purchase', 'report_feed_freight', 'report_feed_recipe_cost_month', 'report_feed_consumption_cost'])
      expect(TARGET_VIEWS as readonly string[]).toContain(v);
    expect(TARGET_READ_TABLES as readonly string[]).toContain('feed_stock_period');
    for (const r of ['close_feed_month', 'reopen_feed_month', 'set_feed_formula_comment', 'set_feed_type_standard_batch', 'set_feed_type_active',
      'set_expense_category_feed', 'set_feed_purchase_quantity', 'allocate_feed_freight']) expect(TARGET_RPCS as readonly string[]).toContain(r);
  });
  it('wiring: the module talks to the backend only through its hooks (no direct client calls); OPERATOR sees Fabricaciones and Ver recetas', () => {
    for (const f of readdirSync(DIR)) {
      const src = readFileSync(resolve(DIR, f), 'utf8');
      expect(src, f).not.toMatch(/\.rpc\(|\.from\(['"]|\.insert\(|\.update\(/);
    }
    const mod = readFileSync(resolve(DIR, 'AlimentoModulo.tsx'), 'utf8');
    expect(mod).toContain("const OPERATIVAS: Vista[] = ['fabricaciones', 'ver'];");
    expect(readFileSync(resolve(DIR, '../AlimentoApp.tsx'), 'utf8')).toContain('<AlimentoModulo />');
    // the recipe ingredients are the expense subcategories marked «insumo»: no ingredient is created from Recetas
    const recetas = readFileSync(resolve(DIR, 'Recetas.tsx'), 'utf8');
    expect(recetas).not.toMatch(/Nuevo ingrediente|useMasterMutations\('feed_ingredient'\)/);
    expect(recetas).toContain("useMasterList<ExpenseCategoryRow>('expense_category')");
    const cats = readFileSync(resolve(DIR, '../../admin/CategoriasAdmin.tsx'), 'utf8');
    expect(cats).toContain('Marcar insumos de alimento');
    expect(cats).toContain("renombrarIng.mutateAsync({ id: ing.id, values: { nombre: nombre.trim() } })");
  });
});
