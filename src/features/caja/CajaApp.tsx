import { useState, useMemo } from 'react';
import { Plus, AlertTriangle, RefreshCw, Database } from 'lucide-react';
import { useMovimientosCaja, useCheques, useAnularMovimiento, useSincronizarPagos } from '../../hooks/useCaja';
import { useCuentas } from '../../hooks/useArqueos';
import { useAuth } from '../../auth/useAuth';
import { ListaMovimientos } from './ListaMovimientos';
import { FormMovimiento } from './FormMovimiento';
import { ResumenSaldos } from './ResumenSaldos';
import { ResumenFlujoCaja } from './ResumenFlujoCaja';
import { CuentasAPagar } from './CuentasAPagar';
import { ArqueoCard } from './ArqueoCard';
import { FormArqueo } from './FormArqueo';
import { HistorialArqueos } from './HistorialArqueos';
import { MercadoPagoDebug } from '../mercadopago/MercadoPagoDebug';
import { formatoPesos } from '../pedidos/helpers';
import { getTodayDate } from '../../utils/dateUtils';
import type { CuentaCaja } from '../../types/domain';

type Vista = 'lista' | 'nuevo' | 'mercadopago';

export function CajaApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('lista');
  const [mostrarImportarSheets, setMostrarImportarSheets] = useState(false);
  const [cuentaArqueando, setCuentaArqueando] = useState<CuentaCaja | null>(null);
  const [mostrarHistorial, setMostrarHistorial] = useState<string | null>(null);
  const [mensajeSincro, setMensajeSincro] = useState<{ tipo: 'exito' | 'error'; texto: string } | null>(null);

  const movimientosQuery = useMovimientosCaja();
  const chequesQuery = useCheques();
  const anularMutation = useAnularMovimiento();
  const sincronizarMutation = useSincronizarPagos();
  const cuentasQuery = useCuentas();

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

  // Todos los movimientos (sin filtro de período)
  const movimientos = movimientosQuery.data || [];

  const handleSincronizar = async () => {
    try {
      const resultado = await sincronizarMutation.mutateAsync();
      if (resultado.sincronizados > 0) {
        setMensajeSincro({
          tipo: 'exito',
          texto: `✓ Sincronizados ${resultado.sincronizados} pago${resultado.sincronizados > 1 ? 's' : ''}`,
        });
      } else {
        setMensajeSincro({
          tipo: 'exito',
          texto: 'No hay pagos para sincronizar',
        });
      }
      if (resultado.errores.length > 0) {
        console.error('Errores en sincronización:', resultado.errores);
      }
    } catch (err) {
      setMensajeSincro({
        tipo: 'error',
        texto: `Error: ${err instanceof Error ? err.message : 'Error desconocido'}`,
      });
    }
    setTimeout(() => setMensajeSincro(null), 5000);
  };

  if (vista === 'nuevo') {
    return (
      <FormMovimiento
        onGuardar={() => {
          setVista('lista');
          movimientosQuery.refetch();
        }}
        onCancelar={() => setVista('lista')}
      />
    );
  }

  if (vista === 'mercadopago') {
    return (
      <div className="min-h-screen bg-stone-100 flex justify-center">
        <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
          <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8]">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold text-[#2C2419]">Debug MercadoPago</h1>
              <button
                onClick={() => setVista('lista')}
                className="px-4 py-2 bg-[#A8552E] text-white rounded-lg hover:bg-[#8B4423]"
              >
                Volver
              </button>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-6">
            <MercadoPagoDebug />
          </div>
        </div>
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
          <div className="flex items-center justify-between mt-1">
            <h1 className="text-2xl font-bold text-[#2C2419]">Caja & Finanzas</h1>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setVista('mercadopago')}
                className="flex items-center gap-2 text-xs px-3 py-1.5 bg-purple-100 text-purple-700 rounded hover:bg-purple-200 transition"
                title="Ver datos raw de MercadoPago"
              >
                <Database className="w-4 h-4" />
                MP Debug
              </button>
              <button
                onClick={handleSincronizar}
                disabled={sincronizarMutation.isPending}
                className="flex items-center gap-2 text-xs px-3 py-1.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:opacity-50 transition"
                title="Sincronizar pagos sin movimiento a la tabla de caja"
              >
                <RefreshCw className={`w-4 h-4 ${sincronizarMutation.isPending ? 'animate-spin' : ''}`} />
                Sincronizar Pagos
              </button>
            </div>
          </div>
          {mensajeSincro && (
            <div className={`mt-2 text-xs p-2 rounded ${
              mensajeSincro.tipo === 'exito'
                ? 'bg-green-100 text-green-700'
                : 'bg-red-100 text-red-700'
            }`}>
              {mensajeSincro.texto}
            </div>
          )}
        </header>


        {/* Contenido Principal */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {/* Resumen de Saldos */}
          <div className="mb-8">
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
              Resumen de Saldos
            </p>
            <ResumenSaldos />
          </div>

          {/* Resumen Flujo de Caja */}
          <div className="mb-8">
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
              Flujo de Caja por Medio de Pago
            </p>
            <ResumenFlujoCaja />
          </div>

          {/* Cuentas a Pagar */}
          <div className="mb-8">
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
              Cronograma de Pagos (Gastos Pendientes)
            </p>
            <CuentasAPagar />
          </div>

          {/* Listado de Movimientos */}
          {movimientos.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                Movimientos Detallados
              </p>
              <ListaMovimientos
                movimientos={movimientos}
                onAnular={(id, motivo) => anularMutation.mutateAsync({ id, motivo })}
              />
            </div>
          )}

          {movimientos.length === 0 && (
            <div className="border border-dashed border-[#D8CDB0] rounded-lg p-6 text-center">
              <p className="text-sm text-[#8A7A5C]">No hay movimientos en este período</p>
            </div>
          )}

          {/* Sección de Arqueo de Caja Chica */}
          {cuentasQuery.data && cuentasQuery.data.length > 0 && (() => {
            const cajachica = cuentasQuery.data.find(c => c.nombre === 'Caja Chica');
            return cajachica ? (
              <div className="mt-8">
                <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
                  Arqueo de Caja Chica
                </p>
                <div className="max-w-sm">
                  <ArqueoCard
                    cuenta={cajachica}
                    onArquear={() => setCuentaArqueando(cajachica)}
                  />
                  {mostrarHistorial === cajachica.id && (
                    <div className="mt-3">
                      <div className="flex justify-between items-center mb-2">
                        <p className="text-xs font-semibold text-[#8A6A2E] uppercase">
                          Historial
                        </p>
                        <button
                          onClick={() => setMostrarHistorial(null)}
                          className="text-xs text-[#A8552E] hover:underline"
                        >
                          Ocultar
                        </button>
                      </div>
                      <HistorialArqueos cuenta={cajachica} />
                    </div>
                  )}
                  {mostrarHistorial !== cajachica.id && (
                    <button
                      onClick={() => setMostrarHistorial(cajachica.id)}
                      className="mt-2 w-full text-xs text-[#A8552E] hover:bg-amber-50 px-2 py-1 rounded transition-colors"
                    >
                      Ver historial
                    </button>
                  )}
                </div>
              </div>
            ) : null;
          })()}
        </div>

        {/* Botón flotante desktop */}
        <div className="fixed bottom-6 right-6 hidden md:flex z-40">
          <button
            onClick={() => setVista('nuevo')}
            className="flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-3 rounded-lg hover:bg-[#8B4423] transition-colors shadow-lg"
          >
            <Plus className="w-5 h-5" /> Nuevo
          </button>
        </div>

        {/* Botón flotante mobile */}
        <div className="md:hidden fixed bottom-6 right-4 z-40">
          <button
            onClick={() => setVista('nuevo')}
            className="flex items-center justify-center bg-[#A8552E] text-white font-semibold p-3 rounded-full hover:bg-[#8B4423] transition-colors shadow-lg"
            title="Nuevo movimiento"
          >
            <Plus className="w-6 h-6" />
          </button>
        </div>

        {/* Modal de Arqueo */}
        {cuentaArqueando && (
          <FormArqueo
            cuenta={cuentaArqueando}
            onClose={() => setCuentaArqueando(null)}
            onGuardar={() => {
              setCuentaArqueando(null);
              movimientosQuery.refetch();
            }}
          />
        )}

      </div>
    </div>
  );
}
