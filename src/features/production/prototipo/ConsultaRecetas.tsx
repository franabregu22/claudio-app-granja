import { useState } from 'react';
import { escalarTanda, fechaDMA, HOY, kgLinea, kgTxt, lineasDe, SECCIONES, versionVigente, type Estado } from './datos';

/** Consulta rápida de recetas (ADMIN y EMPLEADO, solo lectura): recetas activas, versión vigente, kg por tanda. */
export function ConsultaRecetas({ e }: { e: Estado }) {
  const [kg, setKg] = useState<Record<string, string>>({});
  const nombre = (id: string) => e.ingredientes.find((i) => i.id === id)?.nombre ?? id;
  const activas = e.recetas.filter((r) => r.activa).flatMap((r) => { const v = versionVigente(r, HOY); return v ? [{ r, v }] : []; });
  if (activas.length === 0) return <p className="text-sm text-[#8A7A5C]">No hay recetas activas.</p>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {activas.map(({ r, v }) => {
        const tanda = Number(kg[r.id]) > 0 ? Number(kg[r.id]) : v.tandaKg;
        return (
          <div key={r.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-bold text-[#2C2419] text-base">{r.nombre}</p>
                <p className="text-xs text-gray-600">Versión {v.version} · desde {fechaDMA(v.desde)}</p>
                {v.comentario && <p className="text-xs italic text-gray-600">«{v.comentario}»</p>}
              </div>
              <label className="text-xs text-gray-700 text-right">Batch (kg)
                <input type="number" min="1" step="1" inputMode="numeric" placeholder={String(v.tandaKg)} value={kg[r.id] ?? ''}
                  onChange={(ev) => setKg((k) => ({ ...k, [r.id]: ev.target.value }))} className="block border border-gray-300 rounded px-2 py-1 w-24 mt-0.5 text-right" />
              </label>
            </div>
            {SECCIONES.map((s) => {
              const ls = lineasDe(escalarTanda(v, tanda), s.id);
              if (ls.length === 0) return null;
              return (
                <div key={s.id} className="mt-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">{s.label}</p>
                  <ul className="divide-y divide-amber-100">
                    {ls.map((l) => (
                      <li key={l.ingredienteId} className="flex justify-between py-1.5"><span>{nombre(l.ingredienteId)}</span><span className="font-semibold tabular-nums">{kgLinea(l.kg, s.id)}</span></li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <p className="text-xs text-gray-500 mt-1">Kg para batch de {kgTxt(tanda)}{tanda !== v.tandaKg ? ` (estándar ${kgTxt(v.tandaKg)})` : ''}.</p>
          </div>
        );
      })}
    </div>
  );
}
