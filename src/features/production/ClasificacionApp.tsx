import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { shiftDate } from '../../target/production';
import { getTodayDate } from '../../utils/dateUtils';
import { useClassificationDays, useGrades, useRegisterClassification } from './useProduction';

const DIAS = 14;

/**
 * Clasificación (F27-E; ADMIN and OPERATOR). One session = one register_classification call, with an idempotency key
 * per opened form. The grades are the target's reference data; the daily summary is report_classification_day as
 * reported (quantities, share %). The backend validates grades, quantities, duplicates and the period.
 */
export function ClasificacionApp() {
  const hoy = getTodayDate();
  const grados = useGrades();
  const resumen = useClassificationDays(shiftDate(hoy, -DIAS), hoy);
  const registrar = useRegisterClassification();
  const [fecha, setFecha] = useState(hoy);
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [lugar, setLugar] = useState('');
  const [notas, setNotas] = useState('');
  const [clave, setClave] = useState(() => crypto.randomUUID());   // idempotency: one per session form
  const [ok, setOk] = useState(false);

  const lineas = Object.entries(cantidades).filter(([, v]) => v !== '').map(([id, v]) => ({ classification_grade_id: id, quantity: Math.trunc(Number(v)) }));
  const puede = fecha !== '' && lineas.length > 0 && !registrar.isPending;

  function guardar() {
    registrar.mutate({ idempotencyKey: clave, date: fecha, lines: lineas, location: lugar, reason: notas }, {
      onSuccess: () => { setCantidades({}); setNotas(''); setClave(crypto.randomUUID()); setOk(true); },
    });
  }

  const porDia = new Map<string, NonNullable<typeof resumen.data>>();
  for (const r of resumen.data ?? []) porDia.set(r.business_date, [...(porDia.get(r.business_date) ?? []), r]);

  return (
    <div className="min-h-screen bg-[#FAF6EE] px-4 md:px-6 pt-6 pb-20 space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
        <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Clasificación</h1>
      </div>

      <div className="bg-white p-5 rounded-lg border border-amber-200 space-y-4 max-w-2xl">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-gray-700">Fecha
            <input type="date" value={fecha} onChange={(e) => { setFecha(e.target.value); setOk(false); }} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
          </label>
          <label className="block text-sm font-medium text-gray-700">Lugar (opcional)
            <input type="text" value={lugar} onChange={(e) => setLugar(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
          </label>
        </div>
        {grados.isLoading ? <p className="text-sm text-gray-500">Cargando clasificaciones…</p> : (grados.data ?? []).length === 0 ? (
          <p className="text-sm text-amber-800">No hay clasificaciones activas. Un administrador debe cargarlas.</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(grados.data ?? []).map((g) => (
              <label key={g.id} className="block text-sm font-medium text-gray-700">{g.nombre}
                <input type="number" inputMode="numeric" min="0" value={cantidades[g.id] ?? ''} onFocus={(e) => e.target.select()}
                  onChange={(e) => { setCantidades((c) => ({ ...c, [g.id]: e.target.value })); setOk(false); }}
                  className="w-full border border-gray-300 rounded px-3 py-2 mt-1 text-lg" />
              </label>
            ))}
          </div>
        )}
        <label className="block text-sm font-medium text-gray-700">Notas (opcional)
          <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
        </label>
        {(registrar.error || grados.error) ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(registrar.error ?? grados.error)}</div> : null}
        {ok && <p className="text-sm text-green-700">Clasificación registrada.</p>}
        <button onClick={guardar} disabled={!puede} className="w-full bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium disabled:opacity-50">
          {registrar.isPending ? 'Guardando...' : 'Registrar clasificación'}
        </button>
      </div>

      <div>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Últimos {DIAS} días</p>
        {resumen.error ? <p className="text-sm text-red-700">{errorMessage(resumen.error)}</p> : porDia.size === 0 ? (
          <p className="text-sm text-[#8A7A5C]">Sin clasificaciones en el período.</p>
        ) : (
          <div className="space-y-2">
            {[...porDia.entries()].map(([d, rows]) => (
              <div key={d} className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
                <p className="font-semibold text-amber-900">{d} · total {rows[0].day_total} · {rows[0].day_sessions} sesión(es)</p>
                <p className="text-gray-700">{rows.map((r) => `${r.grade_nombre}: ${r.quantity} (${r.share_pct.toFixed(1)}%)`).join(' · ')}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
