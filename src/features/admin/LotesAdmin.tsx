import type { FlockRow, ShedRow } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { MasterEditor } from './MasterEditor';
import { useFlocks, useMasterList } from './useMasters';

const ESTADO_LABEL: Record<FlockRow['estado'], string> = { ACTIVE: 'Activo', RETIRED: 'Retirado', ARCHIVED: 'Archivado' };

/**
 * Target `sheds` (ADMIN master, editable) and `flocks` (read-only). The frozen contract gives the frontend no
 * write path for flocks (no INSERT / UPDATE grant and no flock RPC), so flocks are listed, not created,
 * retired or deleted here.
 */
export function LotesAdmin() {
  const galpones = useMasterList<ShedRow>('sheds');
  const flocks = useFlocks();
  const nombreGalpon = (id: string) => galpones.data?.find((s) => s.id === id)?.nombre ?? '—';
  const activos = (flocks.data ?? []).filter((f) => f.estado === 'ACTIVE');
  const otros = (flocks.data ?? []).filter((f) => f.estado !== 'ACTIVE');

  const Lote = ({ f }: { f: FlockRow }) => (
    <div className={`border rounded-lg p-4 ${f.estado === 'ACTIVE' ? 'bg-white border-amber-200' : 'bg-gray-50 border-gray-200 opacity-75'}`}>
      <div className="flex items-center gap-2 mb-1">
        <h4 className="font-bold text-amber-900">{nombreGalpon(f.shed_id)}</h4>
        <span className={`text-xs px-2 py-1 rounded ${f.estado === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
          {ESTADO_LABEL[f.estado]}
        </span>
      </div>
      <p className="text-sm text-gray-600">
        Entrada: {formatearFechaLocal(f.entry_date)} • {Number(f.initial_population).toLocaleString('es-AR')} aves iniciales
        {f.exit_date ? ` • Salida: ${formatearFechaLocal(f.exit_date)}` : ''}
      </p>
      {f.genetics_line && <p className="text-sm text-gray-600">Línea: {f.genetics_line}</p>}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <MasterEditor
        table="sheds"
        title="Galpones"
        fields={[
          { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Ej: Galpón 1' },
          { key: 'capacidad', label: 'Capacidad (aves)', type: 'number', placeholder: 'Capacidad (opcional)' },
        ]}
      />

      <div className="px-6 pb-6 space-y-6">
        <div>
          <h3 className="text-lg font-bold text-amber-900">Lotes</h3>
          <p className="text-sm text-gray-600">Solo lectura: el alta y la salida de lotes no se registran desde esta pantalla.</p>
        </div>
        {flocks.isLoading ? (
          <p className="text-gray-500 text-sm">Cargando lotes...</p>
        ) : flocks.error ? (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(flocks.error)}</div>
        ) : (
          <>
            <div>
              <h4 className="font-semibold text-amber-900 mb-2">Activos ({activos.length})</h4>
              {activos.length === 0 ? <p className="text-gray-500 text-sm">No hay lotes activos</p>
                : <div className="space-y-3">{activos.map((f) => <Lote key={f.id} f={f} />)}</div>}
            </div>
            {otros.length > 0 && (
              <div>
                <h4 className="font-semibold text-gray-700 mb-2">Retirados / archivados ({otros.length})</h4>
                <div className="space-y-2">{otros.map((f) => <Lote key={f.id} f={f} />)}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
