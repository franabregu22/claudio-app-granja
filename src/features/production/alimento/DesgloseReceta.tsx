import { type IngredientCostMonth, type RecipeCostMonth, ultimoCostoConocido } from '../../../target/alimento';
import type { FormulaLineRow } from '../../../target/feed';
import { etiquetaMes, kgTxt, pesos } from './format';
import { td, tdR } from './ui';

/**
 * Owner 2026-11-27: the opening of a recipe in «Costo estimado por kg de cada receta» — one row per ingredient with its cost per kg in
 * each month (the same rule as the view: that month's purchases or, without purchases, the last known cost) and its kg in the batch of
 * the version effective at month end, then the cost of the whole batch. «Sin precio» = never bought with kg: the recipe has no cost.
 */
export function DesgloseReceta({ meses, costosMes, lineas, costosInsumo }: {
  meses: string[];
  costosMes: (m: string) => RecipeCostMonth | undefined;
  lineas: readonly FormulaLineRow[];
  costosInsumo: readonly IngredientCostMonth[];
}) {
  const deMes = (m: string) => { const v = costosMes(m)?.formula_version_id; return v ? lineas.filter((l) => l.formula_version_id === v) : []; };
  const insumos = new Map<string, { nombre: string; premezcla: boolean }>();
  for (const m of meses) for (const l of deMes(m)) if (!insumos.has(l.ingredient_id)) insumos.set(l.ingredient_id, { nombre: l.ingredient_name, premezcla: l.section === 'PREMIX' });
  const orden = [...insumos.entries()].sort(([, a], [, b]) => Number(b.premezcla) - Number(a.premezcla) || a.nombre.localeCompare(b.nombre));
  const batch = (m: string) => {
    const ls = deMes(m);
    if (ls.length === 0) return null;
    const kg = ls.reduce((s, l) => s + l.quantity_kg, 0);
    const precios = ls.map((l) => ultimoCostoConocido(costosInsumo, l.ingredient_id, m));
    return { kg, costo: precios.every((p) => p !== null) ? ls.reduce((s, l, i) => s + l.quantity_kg * (precios[i]?.cost_per_kg ?? 0), 0) : null, faltan: precios.filter((p) => p === null).length };
  };
  const sub = 'block text-[11px] font-normal text-gray-500';

  if (orden.length === 0) return <tr className="bg-stone-50"><td className={`${td} pl-8 text-gray-500`} colSpan={meses.length + 1}>Sin receta cargada en estos meses.</td></tr>;
  return (
    <>
      {orden.map(([id, ins]) => (
        <tr key={id} className="bg-stone-50 text-[#5C4A2E]">
          <td className={`${td} pl-8`}>{ins.nombre}{ins.premezcla && <span className="ml-1 text-[11px] text-gray-500">(premezcla)</span>}</td>
          {meses.map((m) => {
            const l = deMes(m).find((x) => x.ingredient_id === id);
            if (!l) return <td key={m} className={`${tdR} text-gray-400`}>no lleva</td>;
            const c = ultimoCostoConocido(costosInsumo, id, m);
            return (
              <td key={m} className={tdR}>
                {c ? <>{pesos(c.cost_per_kg)}/kg{c.freight_pending ? '*' : ''}</> : <span className="font-semibold text-red-700">Sin precio</span>}
                <span className={sub}>{kgTxt(l.quantity_kg)} en el batch{c && c.period !== m ? ` · precio de ${etiquetaMes(c.period)}` : ''}</span>
              </td>
            );
          })}
        </tr>
      ))}
      <tr className="bg-stone-100 font-semibold text-[#2C2419]">
        <td className={`${td} pl-8`}>Total del batch</td>
        {meses.map((m) => {
          const b = batch(m);
          return (
            <td key={m} className={tdR}>
              {b === null ? '—' : b.costo === null ? <span className="text-red-700">Falta{b.faltan === 1 ? '' : 'n'} {b.faltan} precio{b.faltan === 1 ? '' : 's'}</span> : pesos(b.costo)}
              {b && <span className={sub}>{kgTxt(b.kg)}</span>}
            </td>
          );
        })}
      </tr>
    </>
  );
}
