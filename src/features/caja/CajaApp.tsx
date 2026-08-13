import { useState } from 'react';
import { ChevronLeft, Plus } from 'lucide-react';
import { useMovimientosCaja, useResumenCaja } from '../../hooks/useCaja';
import { useAuth } from '../../auth/useAuth';
import { ListaMovimientos } from './ListaMovimientos';
import { FormMovimiento } from './FormMovimiento';
import { formatoPesos } from '../pedidos/helpers';

type Vista = 'lista' | 'nuevo';

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

export function CajaApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('lista');
  const [fechaSeleccionada, setFechaSeleccionada] = useState(getTodayDate());

  const movimientosQuery = useMovimientosCaja();
  const resumenQuery = useResumenCaja(fechaSeleccionada);

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede acceder a Caja.</p>
        </div>
      </div>
    );
  }

  const movimientos = movimientosQuery.data || [];
  const hoy = getTodayDate();
  const movimientosHoy = movimientos.filter((m) => m.fecha_operacion === hoy);

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center">
      <div className="w-full max-w-4xl bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <header className="px-5 pt-6 pb-4 border-b border-[#E4DCC8] flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
              Granja Santo Tomás
            </p>
            <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Caja & Finanzas</h1>
          </div>
          {vista === 'nuevo' && (
            <button
              onClick={() => setVista('lista')}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-[#A8552E] text-white active:scale-95 transition-transform"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
        </header>

        {vista === 'lista' ? (
          <div className="flex-1 overflow-y-auto px-5 pt-6 pb-20">
            {/* Resumen del día */}
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="date"
                  value={fechaSeleccionada}
                  onChange={(e) => setFechaSeleccionada(e.target.value)}
                  className="border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm"
                />
              </div>

              {resumenQuery.isLoading ? (
                <div className="text-sm text-[#8A7A5C]">Cargando...</div>
              ) : (
                <div className="grid grid-cols-3 gap-3 mb-6">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <p className="text-xs text-green-700 font-semibold uppercase mb-1">Ingresos</p>
                    <p className="text-2xl font-bold text-green-700">
                      {formatoPesos(resumenQuery.data?.ingresos || 0)}
                    </p>
                  </div>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-xs text-red-700 font-semibold uppercase mb-1">Egresos</p>
                    <p className="text-2xl font-bold text-red-700">
                      {formatoPesos(resumenQuery.data?.egresos || 0)}
                    </p>
                  </div>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-xs text-blue-700 font-semibold uppercase mb-1">Balance</p>
                    <p className="text-2xl font-bold text-blue-700">
                      {formatoPesos(resumenQuery.data?.balance || 0)}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Movimientos del día */}
            {movimientosHoy.length > 0 && (
              <div className="mb-6">
                <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                  Movimientos de hoy — {movimientosHoy.length}
                </p>
                <ListaMovimientos movimientos={movimientosHoy} />
              </div>
            )}

            {/* Botón agregar */}
            <button
              onClick={() => setVista('nuevo')}
              className="fixed bottom-6 right-6 flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-3 rounded-lg hover:bg-[#8B4423] transition-colors shadow-lg"
            >
              <Plus className="w-5 h-5" /> Nuevo movimiento
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 pt-6 pb-20">
            <FormMovimiento
              onGuardar={() => {
                setVista('lista');
                movimientosQuery.refetch();
              }}
              onCancelar={() => setVista('lista')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
