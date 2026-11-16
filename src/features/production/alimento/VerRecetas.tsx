import { useState } from 'react';
import { versionsEffectiveOn } from '../../../target/feed';
import { getTodayDate } from '../../../utils/dateUtils';
import { escalar, fechaDMA, kgLinea, kgTxt, SECCIONES } from './format';
import { useAllFeedTypes, useComposition, useVersions } from './useAlimento';

/** «Ver recetas» (ADMIN and OPERATOR, read-only): active recipes, the version in force today, kg for a batch — the standard one by default. */
export function VerRecetas() {
  const tipos = useAllFeedTypes();
  const versiones = useVersions();
  const hoy = getTodayDate();
  const [batch, setBatch] = useState<Record<string, string>>({});
  const vigentes = versionsEffectiveOn(versiones.data ?? [], hoy);
  const activas = (tipos.data ?? []).filter((t) => t.activo).flatMap((t) => { const v = vigentes.find((x) => x.feed_type_id === t.id); return v ? [{ t, v }] : []; });
  const comp = useComposition(activas.map((a) => a.v.id));
  if (tipos.isLoading || versiones.isLoading) return <p className="text-sm text-gray-500">Cargando recetas…</p>;
  if (activas.length === 0) return <p className="text-sm text-[#8A7A5C]">No hay recetas activas con una versión vigente.</p>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {activas.map(({ t, v }) => {
        const lineas = (comp.data ?? []).filter((l) => l.formula_version_id === v.id);
        const base = lineas.reduce((s, l) => s + l.quantity_kg, 0) || t.standard_batch_kg;
        const kg = Number(batch[t.id]) > 0 ? Number(batch[t.id]) : t.standard_batch_kg;
        const escaladas = escalar(lineas, base, kg);
        return (
          <div key={t.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-bold text-[#2C2419] text-base">{t.nombre}</p>
                <p className="text-xs text-gray-600">Versión {v.version} · desde {fechaDMA(v.effective_from)}</p>
                {v.comment && <p className="text-xs italic text-gray-600">«{v.comment}»</p>}
              </div>
              <label className="text-xs text-gray-700 text-right">Batch (kg)
                <input type="number" min="1" step="1" inputMode="numeric" placeholder={String(t.standard_batch_kg)} value={batch[t.id] ?? ''}
                  onChange={(e) => setBatch((b) => ({ ...b, [t.id]: e.target.value }))} className="block border border-gray-300 rounded px-2 py-1 w-24 mt-0.5 text-right" />
              </label>
            </div>
            {SECCIONES.map((s) => {
              const ls = escaladas.filter((l) => l.section === s.id);
              return ls.length === 0 ? null : (
                <div key={s.id} className="mt-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">{s.label}</p>
                  <ul className="divide-y divide-amber-100">
                    {ls.map((l) => <li key={l.ingredient_id} className="flex justify-between py-1.5"><span>{l.ingredient_name}</span><span className="font-semibold tabular-nums">{kgLinea(l.quantity_kg, s.id)}</span></li>)}
                  </ul>
                </div>
              );
            })}
            <p className="text-xs text-gray-500 mt-1">Kg para batch de {kgTxt(kg)}{kg !== t.standard_batch_kg ? ` (estándar ${kgTxt(t.standard_batch_kg)})` : ''}.</p>
          </div>
        );
      })}
    </div>
  );
}
