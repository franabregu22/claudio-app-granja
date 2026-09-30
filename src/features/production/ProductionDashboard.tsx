import { AlertTriangle } from 'lucide-react';
import { latestPerFlock, shiftDate } from '../../target/production';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { useFlockDays } from './useProduction';

const DIAS = 14;
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

/**
 * Dashboard de producción (F27-E): report_flock_day only (ADR-005 D1/D2). Per flock: the latest reported day
 * (population, age, laying % against the genetics curve, quality warning) and the last 14 days of laying %.
 * ADMIN sees every flock, OPERATOR its assigned ones (RLS); no monetary field is read.
 */
export function ProductionDashboard() {
  const hoy = getTodayDate();
  const dias = useFlockDays(shiftDate(hoy, -DIAS), hoy);
  if (dias.isLoading) return <div className="flex items-center justify-center py-12"><p className="text-gray-500">Cargando dashboard de producción...</p></div>;
  if (dias.error) return <p className="m-6 text-sm text-red-700">{errorMessage(dias.error)}</p>;
  const filas = dias.data ?? [];
  const lotes = latestPerFlock(filas);

  return (
    <div className="px-4 md:px-6 pt-6 pb-10 space-y-6">
      <h1 className="text-2xl font-bold text-[#2C2419]">Dashboard de producción</h1>
      {lotes.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay lotes con actividad en los últimos {DIAS} días.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {lotes.map((l) => {
          const serie = filas.filter((d) => d.flock_id === l.flock_id).slice().reverse();
          return (
            <div key={l.flock_id} className="bg-white rounded-lg border border-[#E4DCC8] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-bold text-amber-900">{l.shed_nombre}</p>
                {l.quality_data_warning && <span className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Datos incompletos</span>}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div><p className="text-xs text-gray-500">Aves</p><p className="text-lg font-bold">{l.population}</p></div>
                <div><p className="text-xs text-gray-500">Edad (sem.)</p><p className="text-lg font-bold">{l.age_weeks === null ? '—' : l.age_weeks.toFixed(0)}</p></div>
                <div><p className="text-xs text-gray-500">% Postura</p><p className="text-lg font-bold text-amber-800">{pct(l.laying_pct)}</p></div>
              </div>
              <p className="text-xs text-gray-500">Último día {l.business_date} · esperado {pct(l.expected_laying_pct)}{l.genetics_line ? ` · ${l.genetics_line}` : ''}</p>
              <div className="flex items-end gap-1 h-16" title="% de postura, últimos días">
                {serie.map((d) => (
                  <div key={d.business_date} className="flex-1 bg-amber-100 rounded-t relative" style={{ height: '100%' }} title={`${d.business_date}: ${pct(d.laying_pct)}`}>
                    <div className="absolute bottom-0 left-0 right-0 bg-amber-500 rounded-t" style={{ height: `${Math.min(100, Math.max(0, d.laying_pct ?? 0))}%` }} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
