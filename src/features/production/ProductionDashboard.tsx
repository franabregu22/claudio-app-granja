import { useProducciones } from '../../hooks/useProducciones';
import { useLotes } from '../../hooks/useLotes';
import { useRecuentos } from '../../hooks/useRecuentos';
import { DashboardProduccion } from './DashboardProduccion';

export function ProductionDashboard() {
  const { data: producciones = [], isLoading: loadingProd } = useProducciones();
  const { data: lotes = [], isLoading: loadingLotes } = useLotes();
  const { data: recuentos = [], isLoading: loadingRecuentos } = useRecuentos();

  if (loadingProd || loadingLotes || loadingRecuentos) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando dashboard de producción...</p>
      </div>
    );
  }

  return (
    <div className="px-4 md:px-6 pt-6">
      <DashboardProduccion
        producciones={producciones}
        lotes={lotes}
        recuentos={recuentos}
        onEditar={() => {
          // No hacer nada al editar desde el dashboard
        }}
      />
    </div>
  );
}
