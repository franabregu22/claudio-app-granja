import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useProducciones, useCrearProduccion, useActualizarProduccion } from '../../hooks/useProducciones';
import { useLotes } from '../../hooks/useLotes';
import { FormProduccion } from './FormProduccion';
import { ListaProducciones } from './ListaProducciones';
import { DashboardProduccion } from './DashboardProduccion';

const GALPONES = ['Galpón 1', 'Galpón 2', 'Galpón 3', 'Galpón 4'];
type Periodo = 'hoy' | 'semana' | 'mes' | 'ultimas4';

export function ProductionApp() {
  const { data: producciones = [], isLoading: loadingProd } = useProducciones();
  const { data: lotes = [], isLoading: loadingLotes } = useLotes();
  const crearMutation = useCrearProduccion();
  const actualizarMutation = useActualizarProduccion();

  const [produccionEnEdicion, setProduccionEnEdicion] = useState<string | null>(null);
  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [periodo, setPeriodo] = useState<Periodo>('hoy');

  const handleGuardar = (data: any) => {
    if (produccionEnEdicion) {
      actualizarMutation.mutate(
        { id: produccionEnEdicion, ...data },
        {
          onSuccess: () => {
            setProduccionEnEdicion(null);
            setMostrarFormulario(false);
          },
        }
      );
    } else {
      crearMutation.mutate(data, {
        onSuccess: () => {
          setMostrarFormulario(false);
        },
      });
    }
  };

  const handleNuevo = () => {
    setProduccionEnEdicion(null);
    setMostrarFormulario(true);
  };

  const handleCerrarFormulario = () => {
    setMostrarFormulario(false);
    setProduccionEnEdicion(null);
  };

  if (loadingProd || loadingLotes) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando datos de producción...</p>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col min-h-screen gap-6 pb-20 px-4 md:px-6">
      {/* Selector de período */}
      <div className="pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setPeriodo('hoy')}
            className={`px-3 py-1.5 text-sm font-medium rounded transition ${
              periodo === 'hoy'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Hoy
          </button>
          <button
            onClick={() => setPeriodo('semana')}
            className={`px-3 py-1.5 text-sm font-medium rounded transition ${
              periodo === 'semana'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Semana
          </button>
          <button
            onClick={() => setPeriodo('mes')}
            className={`px-3 py-1.5 text-sm font-medium rounded transition ${
              periodo === 'mes'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Mes
          </button>
          <button
            onClick={() => setPeriodo('ultimas4')}
            className={`px-3 py-1.5 text-sm font-medium rounded transition ${
              periodo === 'ultimas4'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Últimas 4 semanas
          </button>
        </div>
      </div>

      {/* Dashboard */}
      <div>
        <DashboardProduccion producciones={producciones} lotes={lotes} periodo={periodo} />
      </div>

      {/* Lista de producciones */}
      <div>
        <h2 className="text-xl font-bold text-amber-900 mb-3">Registros</h2>
        <ListaProducciones
          producciones={producciones}
          onEditar={(id) => {
            setProduccionEnEdicion(id);
            setMostrarFormulario(true);
          }}
          produccionEnEdicion={produccionEnEdicion}
        />
      </div>

      {/* Botón flotante */}
      <button
        onClick={handleNuevo}
        className="fixed bottom-6 right-6 bg-[#A8552E] text-white rounded-full p-4 shadow-lg hover:bg-[#8B4423] transition flex items-center justify-center z-40"
        title="Agregar producción"
      >
        <Plus className="w-6 h-6" />
      </button>

      {/* Modal con formulario - centrado arriba */}
      {mostrarFormulario && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-4 z-50 overflow-y-auto p-4">
          <div className="bg-[#FAF6EE] rounded-lg max-w-2xl w-full">
            {/* Header del modal */}
            <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-[#E4DCC8]">
              <h2 className="text-lg font-bold text-[#2C2419]">
                {produccionEnEdicion ? 'Editar producción' : 'Nueva producción'}
              </h2>
              <button
                onClick={handleCerrarFormulario}
                className="text-[#8A7A5C] hover:text-[#2C2419]"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Contenido del modal */}
            <div className="px-4 md:px-6 py-6 overflow-y-auto max-h-[calc(100vh-200px)]">
              <FormProduccion
                galpones={GALPONES}
                onGuardar={handleGuardar}
                isLoading={crearMutation.isPending || actualizarMutation.isPending}
                produccionEnEdicion={
                  produccionEnEdicion
                    ? producciones.find((p) => p.id === produccionEnEdicion) || null
                    : null
                }
                onCancelar={handleCerrarFormulario}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
