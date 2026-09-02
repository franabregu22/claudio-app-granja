import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useProducciones, useCrearProduccion, useActualizarProduccion } from '../../hooks/useProducciones';
import { useLotes } from '../../hooks/useLotes';
import { useRecuentos } from '../../hooks/useRecuentos';
import { FormProduccion } from './FormProduccion';
import { DashboardProduccion } from './DashboardProduccion';
import { ListaProducciones } from './ListaProducciones';

const GALPONES = ['Galpón 1', 'Galpón 2', 'Galpón 3', 'Galpón 4'];
type Tab = 'dashboard' | 'produccion';

export function ProductionApp() {
  const { data: producciones = [], isLoading: loadingProd } = useProducciones();
  const { data: lotes = [], isLoading: loadingLotes } = useLotes();
  const { data: recuentos = [], isLoading: loadingRecuentos } = useRecuentos();
  const crearMutation = useCrearProduccion();
  const actualizarMutation = useActualizarProduccion();

  const [tab, setTab] = useState<Tab>('dashboard');
  const [produccionEnEdicion, setProduccionEnEdicion] = useState<string | null>(null);
  const [mostrarFormulario, setMostrarFormulario] = useState(false);

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

  if (loadingProd || loadingLotes || loadingRecuentos) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando datos de producción...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
            Granja Santo Tomás
          </p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Producción</h1>
        </header>

        {/* Tabs */}
        <div className="px-4 md:px-6 pt-4 pb-2 border-b border-[#E4DCC8] flex gap-2 flex-wrap">
          <button
            onClick={() => setTab('dashboard')}
            className={`px-4 py-2 text-sm font-medium rounded transition ${
              tab === 'dashboard'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setTab('produccion')}
            className={`px-4 py-2 text-sm font-medium rounded transition ${
              tab === 'produccion'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Producción
          </button>
        </div>

        {/* Contenido */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {tab === 'dashboard' && (
            <DashboardProduccion
              producciones={producciones}
              lotes={lotes}
              recuentos={recuentos}
              onEditar={(id) => {
                setProduccionEnEdicion(id);
                setTab('produccion');
                setMostrarFormulario(true);
              }}
            />
          )}

          {tab === 'produccion' && (
            <div>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                Historial de Registros
              </p>
              <ListaProducciones
                producciones={producciones}
                onEditar={(id) => {
                  setProduccionEnEdicion(id);
                  setMostrarFormulario(true);
                }}
              />
            </div>
          )}
        </div>

        {/* Botón flotante */}
        {tab === 'produccion' && (
          <div className="fixed bottom-6 right-4 md:right-6 z-40">
            <button
              onClick={handleNuevo}
              className="flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-3 rounded-lg hover:bg-[#8B4423] transition-colors shadow-lg"
              title="Nuevo registro"
            >
              <Plus className="w-5 h-5" /> Nuevo
            </button>
          </div>
        )}
      </div>

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
