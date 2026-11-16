import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { versionsEffectiveOn } from '../../../target/feed';
import { getTodayDate } from '../../../utils/dateUtils';
import { NumeroInput } from '../../../components/NumeroInput';
import { escalar, fechaDMA, kgLinea, kgTxt, SECCIONES } from './format';
import { useAllFeedTypes, useComposition, useVersions } from './useAlimento';

/**
 * «Ver recetas» (ADMIN and OPERATOR, read-only): the active recipes, all FOLDED; the operator opens the one to weigh (owner 2026-11-16).
 * Inside: the version in force today and the kg of each ingredient for a batch — the standard one by default.
 */
export function VerRecetas() {
  const tipos = useAllFeedTypes();
  const versiones = useVersions();
  const hoy = getTodayDate();
  const [batch, setBatch] = useState<Record<string, string>>({});
  const [abiertas, setAbiertas] = useState<string[]>([]);
  const vigentes = versionsEffectiveOn(versiones.data ?? [], hoy);
  const activas = (tipos.data ?? []).filter((t) => t.activo).flatMap((t) => { const v = vigentes.find((x) => x.feed_type_id === t.id); return v ? [{ t, v }] : []; });
  const comp = useComposition(activas.map((a) => a.v.id));
  if (tipos.isLoading || versiones.isLoading) return <p className="text-sm text-gray-500">Cargando recetas…</p>;
  if (activas.length === 0) return <p className="text-sm text-[#8A7A5C]">No hay recetas activas con una versión vigente.</p>;
  const alternar = (id: string) => setAbiertas((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-600">Tocá una receta para ver sus cantidades.</p>
      {activas.map(({ t, v }) => {
        const abierta = abiertas.includes(t.id);
        const lineas = (comp.data ?? []).filter((l) => l.formula_version_id === v.id);
        const base = lineas.reduce((s, l) => s + l.quantity_kg, 0) || t.standard_batch_kg;
        const kg = Number(batch[t.id]) > 0 ? Number(batch[t.id]) : t.standard_batch_kg;
        const escaladas = escalar(lineas, base, kg);
        return (
          <div key={t.id} className="bg-white rounded-lg border border-[#E4DCC8] text-sm">
            <button type="button" onClick={() => alternar(t.id)} aria-expanded={abierta} className="w-full flex items-center gap-2 p-3 text-left">
              <ChevronDown className={`w-4 h-4 shrink-0 transition ${abierta ? 'rotate-180' : ''}`} />
              <span className="flex-1">
                <span className="block font-bold text-[#2C2419] text-base">{t.nombre}</span>
                <span className="block text-xs text-gray-600">Versión {v.version} · desde {fechaDMA(v.effective_from)} · batch {kgTxt(t.standard_batch_kg)}</span>
              </span>
            </button>
            {abierta && (
              <div className="px-3 pb-3 border-t border-[#E4DCC8] pt-2">
                <div className="flex items-start justify-between gap-2">
                  {v.comment ? <p className="text-xs italic text-gray-600">«{v.comment}»</p> : <span />}
                  <label className="text-xs text-gray-700 text-right">Batch (kg)
                    <NumeroInput min="1" placeholder={String(t.standard_batch_kg).replace('.', ',')} value={batch[t.id] ?? ''}
                      onChange={(e) => setBatch((b) => ({ ...b, [t.id]: e.target.value }))} className="block border border-gray-300 rounded px-2 py-1 w-24 mt-0.5 text-right" />
                  </label>
                </div>
                {SECCIONES.map((s) => {
                  const ls = escaladas.filter((l) => l.section === s.id);
                  return ls.length === 0 ? null : (
                    <div key={s.id} className="mt-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">{s.label}</p>
                      <ul className="divide-y divide-amber-100">
                        {ls.map((l) => <li key={`${s.id}-${l.ingredient_id}`} className="flex justify-between py-1.5"><span>{l.ingredient_name}</span><span className="font-semibold tabular-nums">{kgLinea(l.quantity_kg, s.id)}</span></li>)}
                      </ul>
                    </div>
                  );
                })}
                <p className="text-xs text-gray-500 mt-1">Kg para batch de {kgTxt(kg)}{kg !== t.standard_batch_kg ? ` (estándar ${kgTxt(t.standard_batch_kg)})` : ''}.</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
