import { useState } from 'react';
import { codigoLote, horaActual, type FlockOption } from '../../target/production';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { useProductionMutations } from './useProduction';
import { NumeroInput } from '../../components/NumeroInput';

interface Props {
  flocks: FlockOption[];
  onDone: () => void;
}

const numero = 'w-full border border-gray-300 rounded px-3 py-2 text-lg';
const entero = (v: string) => (v === '' ? 0 : Math.trunc(Number(v)));

/**
 * Daily entry: register_production_day (0131) records the production, the mortality (when > 0) and the note in ONE transaction —
 * nothing is left half-saved. Date and time come filled in (today, now) and both can be changed. The backend checks the flock state, the period, the exit date and duplicates; this form only collects
 * the values. Dirty eggs are no longer counted (owner 2026-11-17).
 */
export function FormProduccion({ flocks, onDone }: Props) {
  const { registerDay } = useProductionMutations();
  const activos = flocks.filter((f) => f.estado === 'ACTIVE');
  const [flockId, setFlockId] = useState(activos.length === 1 ? activos[0].id : '');
  const [fecha, setFecha] = useState(getTodayDate());
  const [hora, setHora] = useState(horaActual());   // proposed, editable (0131)
  const [total, setTotal] = useState('');
  const [rotos, setRotos] = useState('');
  const [muertes, setMuertes] = useState('');
  const [notas, setNotas] = useState('');
  const rotosDeMas = total !== '' && entero(rotos) > entero(total);
  const puede = flockId !== '' && fecha !== '' && hora !== '' && total !== '' && !rotosDeMas && !registerDay.isPending;

  const guardar = () => registerDay.mutate(
    { flockId, date: fecha, eggsTotal: entero(total), eggsBroken: entero(rotos), deaths: entero(muertes), notes: notas, recordedTime: hora },
    { onSuccess: onDone },
  );

  const campo = (label: string, value: string, set: (v: string) => void) => (
    <label className="block text-sm font-medium text-gray-700">{label}
      <NumeroInput inputMode="numeric" min="0" value={value} onChange={(e) => set(e.target.value)}
        onFocus={(e) => e.target.select()} className={`${numero} mt-1`} />
    </label>
  );

  return (
    <div className="bg-white p-6 rounded-lg border border-amber-200 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block text-sm font-medium text-gray-700">Lote / galpón
          <select value={flockId} onChange={(e) => setFlockId(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1">
            <option value="">Elegir…</option>
            {activos.map((f) => <option key={f.id} value={f.id}>{codigoLote(f)} · {f.shed_nombre}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm font-medium text-gray-700">Fecha
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
          </label>
          <label className="block text-sm font-medium text-gray-700">Hora
            <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
          </label>
        </div>
      </div>
      {activos.length === 0 && <p className="text-sm text-amber-800">No hay lotes activos.</p>}

      <div className="p-4 bg-amber-50 rounded-lg border border-amber-100 grid grid-cols-2 gap-3">
        {campo('Huevos totales', total, setTotal)}
        {campo('Rotos / cachados', rotos, setRotos)}
      </div>
      <p className={`text-xs ${rotosDeMas ? 'text-red-700' : 'text-gray-500'}`}>
        {rotosDeMas ? 'Los rotos no pueden superar a los huevos totales.' : 'Los rotos forman parte de los huevos totales.'}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {campo('Mortandad del día (opcional)', muertes, setMuertes)}
        <label className="block text-sm font-medium text-gray-700">Notas (opcional)
          <input type="text" value={notas} maxLength={500} onChange={(e) => setNotas(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
        </label>
      </div>

      {registerDay.error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(registerDay.error)}</div> : null}

      <div className="flex gap-2">
        <button onClick={guardar} disabled={!puede}
          className="flex-1 bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium disabled:opacity-50">
          {registerDay.isPending ? 'Guardando...' : 'Guardar'}
        </button>
        <button onClick={onDone} disabled={registerDay.isPending} className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded font-medium hover:bg-gray-50">
          Cancelar
        </button>
      </div>
    </div>
  );
}
