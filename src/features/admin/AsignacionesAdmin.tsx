import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import type { ShedRow } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { useAssignmentMutations, useFlocks, useMasterList, useOperatorAssignments, useProfiles } from './useMasters';

/**
 * Target `operator_assignments` (ADMIN master): which OPERATOR works which flock. RLS limits every OPERATOR
 * read and production RPC to the assigned, active flocks; this screen only maintains the assignments.
 */
export function AsignacionesAdmin() {
  const { user } = useAuth();
  const perfiles = useProfiles();
  const flocks = useFlocks();
  const galpones = useMasterList<ShedRow>('sheds');
  const asignaciones = useOperatorAssignments();
  const { assign, setActive } = useAssignmentMutations();
  const [operatorId, setOperatorId] = useState('');
  const [flockId, setFlockId] = useState('');

  const operadores = (perfiles.data ?? []).filter((p) => p.rol_type === 'OPERATOR' && p.activo);
  const lotesActivos = (flocks.data ?? []).filter((f) => f.estado === 'ACTIVE');
  const email = (id: string) => perfiles.data?.find((p) => p.id === id)?.email ?? id.slice(0, 8);
  const lote = (id: string) => {
    const f = flocks.data?.find((x) => x.id === id);
    if (!f) return '—';
    return `${galpones.data?.find((s) => s.id === f.shed_id)?.nombre ?? '—'} (entrada ${formatearFechaLocal(f.entry_date)})`;
  };
  const asignar = () => {
    if (!operatorId || !flockId) return;
    assign.mutate({ operatorId, flockId, userId: user?.id ?? null }, { onSuccess: () => setFlockId('') });
  };

  const loading = perfiles.isLoading || flocks.isLoading || asignaciones.isLoading;
  const loadError = perfiles.error ?? flocks.error ?? asignaciones.error;
  const mutationError = assign.error ?? setActive.error;
  if (loading) return <div className="flex items-center justify-center py-12"><p className="text-gray-500">Cargando asignaciones...</p></div>;
  if (loadError) return <div className="m-6 p-4 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(loadError)}</div>;

  const cls = 'border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600 w-full';
  return (
    <div className="p-6">
      <div className="mb-8 bg-white p-4 rounded-lg border border-amber-200">
        <h2 className="font-semibold text-amber-900 mb-3">Asignar operador a un lote</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
          <select value={operatorId} onChange={(e) => setOperatorId(e.target.value)} className={cls} aria-label="Operador">
            <option value="">Operador…</option>
            {operadores.map((p) => <option key={p.id} value={p.id}>{p.email}</option>)}
          </select>
          <select value={flockId} onChange={(e) => setFlockId(e.target.value)} className={cls} aria-label="Lote">
            <option value="">Lote activo…</option>
            {lotesActivos.map((f) => <option key={f.id} value={f.id}>{lote(f.id)}</option>)}
          </select>
          <button onClick={asignar} disabled={assign.isPending || !operatorId || !flockId}
            className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-1 w-full">
            <Plus size={16} />
            Asignar
          </button>
        </div>
        {operadores.length === 0 && <p className="text-xs text-gray-500 mt-2">No hay perfiles OPERATOR activos.</p>}
      </div>

      {mutationError && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(mutationError)}</div>}

      <div className="space-y-2">
        {(asignaciones.data ?? []).length === 0 ? (
          <p className="text-gray-500 text-sm p-4">No hay asignaciones</p>
        ) : (asignaciones.data ?? []).map((a) => (
          <div key={a.id} className={`bg-white rounded border border-gray-200 p-4 flex items-center justify-between gap-2 ${a.activo ? '' : 'opacity-75'}`}>
            <div className="min-w-0">
              <p className="font-medium text-gray-800 truncate">{email(a.operator_id)}</p>
              <p className="text-xs text-gray-500">{lote(a.flock_id)} · {a.activo ? 'Activa' : 'Inactiva'}</p>
            </div>
            <button onClick={() => setActive.mutate({ id: a.id, activo: !a.activo })} disabled={setActive.isPending}
              className={`font-medium text-sm px-2 py-1 ${a.activo ? 'text-red-500 hover:text-red-700' : 'text-green-600 hover:text-green-700'}`}>
              {a.activo ? 'Desactivar' : 'Activar'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
