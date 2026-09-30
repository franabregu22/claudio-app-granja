import { useState } from 'react';
import type { FlockOption } from '../../target/production';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { useProductionMutations } from './useProduction';

interface Props {
  flocks: FlockOption[];
  onDone: () => void;
}

const numero = 'w-full border border-gray-300 rounded px-3 py-2 text-lg';
const entero = (v: string) => (v === '' ? 0 : Math.trunc(Number(v)));

/**
 * Daily entry (F27-E): register_daily_production and, when deaths are entered, register_mortality — two contract
 * facts, recorded in that order. The backend checks the assignment, the flock state, the period, the ADR-007 exit
 * date and duplicates; this form only collects the values. Mid-day / afternoon loads are not target fields: the
 * worker enters the day's totals.
 */
export function FormProduccion({ flocks, onDone }: Props) {
  const m = useProductionMutations();
  const activos = flocks.filter((f) => f.estado === 'ACTIVE');
  const [flockId, setFlockId] = useState(activos.length === 1 ? activos[0].id : '');
  const [fecha, setFecha] = useState(getTodayDate());
  const [total, setTotal] = useState('');
  const [rotos, setRotos] = useState('');
  const [sucios, setSucios] = useState('');
  const [muertes, setMuertes] = useState('');
  const [notas, setNotas] = useState('');
  const [produccionGuardada, setProduccionGuardada] = useState(false);
  const error = m.register.error ?? m.mortality.error;
  const guardando = m.register.isPending || m.mortality.isPending;
  const puede = flockId !== '' && fecha !== '' && total !== '' && !guardando;

  async function guardar() {
    try {
      if (!produccionGuardada) {
        await m.register.mutateAsync({ flockId, date: fecha, eggsTotal: entero(total), eggsBroken: entero(rotos), eggsDirty: entero(sucios), reason: notas });
        setProduccionGuardada(true);
      }
      if (entero(muertes) > 0) await m.mortality.mutateAsync({ flockId, date: fecha, deaths: entero(muertes), reason: notas });
      onDone();
    } catch {
      /* the normalized error is shown below; a saved production is not sent twice on retry */
    }
  }

  const campo = (label: string, value: string, set: (v: string) => void, disabled = false) => (
    <label className="block text-sm font-medium text-gray-700">{label}
      <input type="number" inputMode="numeric" min="0" value={value} disabled={disabled} onChange={(e) => set(e.target.value)}
        onFocus={(e) => e.target.select()} className={`${numero} mt-1 disabled:bg-gray-100`} />
    </label>
  );

  return (
    <div className="bg-white p-6 rounded-lg border border-amber-200 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block text-sm font-medium text-gray-700">Lote / galpón
          <select value={flockId} onChange={(e) => setFlockId(e.target.value)} disabled={produccionGuardada}
            className="w-full border border-gray-300 rounded px-3 py-2 mt-1 disabled:bg-gray-100">
            <option value="">Elegir…</option>
            {activos.map((f) => <option key={f.id} value={f.id}>{f.shed_nombre} · ingreso {f.entry_date}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium text-gray-700">Fecha
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} disabled={produccionGuardada}
            className="w-full border border-gray-300 rounded px-3 py-2 mt-1 disabled:bg-gray-100" />
        </label>
      </div>
      {activos.length === 0 && <p className="text-sm text-amber-800">No tenés lotes activos asignados.</p>}

      <div className="p-4 bg-amber-50 rounded-lg border border-amber-100 grid grid-cols-3 gap-3">
        {campo('Huevos totales', total, setTotal, produccionGuardada)}
        {campo('Rotos / cachados', rotos, setRotos, produccionGuardada)}
        {campo('Sucios', sucios, setSucios, produccionGuardada)}
      </div>
      <p className="text-xs text-gray-500">Rotos y sucios forman parte de los huevos totales.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {campo('Mortandad del día (opcional)', muertes, setMuertes)}
        <label className="block text-sm font-medium text-gray-700">Notas (opcional)
          <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
        </label>
      </div>

      {produccionGuardada && <p className="text-sm text-green-700">Producción registrada. Falta registrar la mortandad.</p>}
      {error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}

      <div className="flex gap-2">
        <button onClick={guardar} disabled={!puede}
          className="flex-1 bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium disabled:opacity-50">
          {guardando ? 'Guardando...' : 'Guardar'}
        </button>
        <button onClick={onDone} disabled={guardando} className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded font-medium hover:bg-gray-50">
          Cancelar
        </button>
      </div>
    </div>
  );
}
