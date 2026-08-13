import { useState, useMemo } from 'react';
import { Plus, AlertTriangle } from 'lucide-react';
import { useMovimientosCaja, useCheques, useAnularMovimiento } from '../../hooks/useCaja';
import { useAuth } from '../../auth/useAuth';
import { ListaMovimientos } from './ListaMovimientos';
import { FormMovimiento } from './FormMovimiento';
import { formatoPesos } from '../pedidos/helpers';

type Vista = 'lista' | 'nuevo';
type Periodo = 'hoy' | 'semana' | 'mes' | 'custom';

function getTodayDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getStartOfWeek(): string {
  const today = new Date();
  const day = today.getDay();
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today.getFullYear(), today.getMonth(), diff);
  const year = monday.getFullYear();
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const dateStr = String(monday.getDate()).padStart(2, '0');
  return `${year}-${month}-${dateStr}`;
}

function getStartOfMonth(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

export function CajaApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('lista');
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [fechaDesde, setFechaDesde] = useState(getStartOfMonth());
  const [fechaHasta, setFechaHasta] = useState(getTodayDate());

  const movimientosQuery = useMovimientosCaja();
  const chequesQuery = useCheques();
  const anularMutation = useAnularMovimiento();

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

  // Calcular fechas según período
  const getDateRange = () => {
    const hoy = getTodayDate();
    switch (periodo) {
      case 'hoy':
        return { desde: hoy, hasta: hoy };
      case 'semana':
        return { desde: getStartOfWeek(), hasta: hoy };
      case 'mes':
        return { desde: getStartOfMonth(), hasta: hoy };
      case 'custom':
        return { desde: fechaDesde, hasta: fechaHasta };
    }
  };

  const { desde, hasta } = getDateRange();

  // Filtrar movimientos
  const movimientos = movimientosQuery.data || [];
  const movimientosFiltrados = useMemo(() => {
    return movimientos.filter(
      (m) => m.fecha_operacion >= desde && m.fecha_operacion <= hasta
    );
  }, [movimientos, desde, hasta]);

  // Calcular resumen
  const resumen = useMemo(() => {
    let ingresos = 0;
    let egresos = 0;

    movimientosFiltrados.forEach((m) => {
      if (m.estado === 'confirmado') {
        if (m.tipo === 'ingreso') {
          ingresos += m.monto;
        } else {
          egresos += m.monto;
        }
      }
    });

    return {
      ingresos,
      egresos,
      balance: ingresos - egresos,
    };
  }, [movimientosFiltrados]);

  // Cheques próximos a vencer (30 días)
  const chequesPorVencer = useMemo(() => {
    const hoy = new Date();
    const en30Dias = new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000);
    const chequesData = chequesQuery.data || [];

    return chequesData.filter((c) => {
      if (c.estado !== 'emitido') return false;
      const fecha = new Date(c.fecha_vencimiento);
      return fecha <= en30Dias && fecha >= hoy;
    });
  }, [chequesQuery.data]);

  // Agrupación de movimientos por concepto
  const movimientosPorConcepto = useMemo(() => {
    const grupos: Record<string, { ingresos: number; egresos: number; count: number }> = {};

    movimientosFiltrados.forEach((m) => {
      if (m.estado !== 'confirmado') return;
      if (!grupos[m.concepto]) {
        grupos[m.concepto] = { ingresos: 0, egresos: 0, count: 0 };
      }
      if (m.tipo === 'ingreso') {
        grupos[m.concepto].ingresos += m.monto;
      } else {
        grupos[m.concepto].egresos += m.monto;
      }
      grupos[m.concepto].count += 1;
    });

    return Object.entries(grupos).map(([concepto, data]) => ({
      concepto,
      ...data,
    }));
  }, [movimientosFiltrados]);

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

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <header className="px-6 pt-6 pb-4 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
            Granja Santo Tomás
          </p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Caja & Finanzas</h1>
        </header>

        {/* Selector de Período */}
        <div className="px-6 pt-4 pb-2 border-b border-[#E4DCC8]">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <button
              onClick={() => setPeriodo('hoy')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'hoy'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Hoy
            </button>
            <button
              onClick={() => setPeriodo('semana')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'semana'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Semana
            </button>
            <button
              onClick={() => setPeriodo('mes')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'mes'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Mes
            </button>
            <button
              onClick={() => setPeriodo('custom')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'custom'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Personalizado
            </button>

            {periodo === 'custom' && (
              <div className="flex gap-2">
                <input
                  type="date"
                  value={fechaDesde}
                  onChange={(e) => setFechaDesde(e.target.value)}
                  className="px-2 py-1 text-sm border border-[#D8CDB0] rounded"
                />
                <input
                  type="date"
                  value={fechaHasta}
                  onChange={(e) => setFechaHasta(e.target.value)}
                  className="px-2 py-1 text-sm border border-[#D8CDB0] rounded"
                />
              </div>
            )}
          </div>
          <p className="text-xs text-[#8A7A5C]">
            {desde} → {hasta} ({movimientosFiltrados.length} movimientos)
          </p>
        </div>

        {/* Contenido Principal */}
        <div className="flex-1 overflow-y-auto px-6 pt-6 pb-20">
          {/* Tarjetas de Resumen */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-xs text-green-700 font-semibold uppercase mb-1">Ingresos</p>
              <p className="text-2xl font-bold text-green-700">{formatoPesos(resumen.ingresos)}</p>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-xs text-red-700 font-semibold uppercase mb-1">Egresos</p>
              <p className="text-2xl font-bold text-red-700">{formatoPesos(resumen.egresos)}</p>
            </div>
            <div className={`${
              resumen.balance >= 0
                ? 'bg-blue-50 border border-blue-200'
                : 'bg-orange-50 border border-orange-200'
            } rounded-lg p-4`}>
              <p className={`text-xs font-semibold uppercase mb-1 ${
                resumen.balance >= 0 ? 'text-blue-700' : 'text-orange-700'
              }`}>
                Balance
              </p>
              <p className={`text-2xl font-bold ${
                resumen.balance >= 0 ? 'text-blue-700' : 'text-orange-700'
              }`}>
                {formatoPesos(resumen.balance)}
              </p>
            </div>
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
              <p className="text-xs text-purple-700 font-semibold uppercase mb-1">Cheques</p>
              <p className="text-2xl font-bold text-purple-700">{chequesPorVencer.length}</p>
            </div>
          </div>

          {/* Alertas de Cheques */}
          {chequesPorVencer.length > 0 && (
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6 rounded">
              <div className="flex gap-3">
                <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold text-yellow-800 mb-2">
                    {chequesPorVencer.length} cheque(s) próximo(s) a vencer
                  </p>
                  <div className="space-y-1 text-sm text-yellow-700">
                    {chequesPorVencer.slice(0, 5).map((c) => (
                      <p key={c.id}>
                        • Cheque #{c.numero} ({c.banco}) - {formatoPesos(c.monto)} - Vence: {c.fecha_vencimiento}
                      </p>
                    ))}
                    {chequesPorVencer.length > 5 && (
                      <p>• +{chequesPorVencer.length - 5} más...</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Análisis por Concepto */}
          {movimientosPorConcepto.length > 0 && (
            <div className="mb-6">
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                Análisis por Concepto
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#D8CDB0]">
                      <th className="text-left px-3 py-2 text-[#6B5D45] font-semibold">Concepto</th>
                      <th className="text-right px-3 py-2 text-[#6B5D45] font-semibold">Ingresos</th>
                      <th className="text-right px-3 py-2 text-[#6B5D45] font-semibold">Egresos</th>
                      <th className="text-right px-3 py-2 text-[#6B5D45] font-semibold">Movs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimientosPorConcepto.map((item) => (
                      <tr key={item.concepto} className="border-b border-[#E4DCC8] hover:bg-white/50">
                        <td className="px-3 py-2 text-[#2C2419]">{item.concepto}</td>
                        <td className="text-right px-3 py-2 text-green-700 font-medium">
                          {item.ingresos > 0 ? formatoPesos(item.ingresos) : '—'}
                        </td>
                        <td className="text-right px-3 py-2 text-red-700 font-medium">
                          {item.egresos > 0 ? formatoPesos(item.egresos) : '—'}
                        </td>
                        <td className="text-right px-3 py-2 text-[#8A7A5C]">{item.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Listado de Movimientos */}
          {movimientosFiltrados.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                Movimientos Detallados
              </p>
              <ListaMovimientos
                movimientos={movimientosFiltrados}
                onAnular={(id, motivo) => anularMutation.mutateAsync({ id, motivo })}
              />
            </div>
          )}

          {movimientosFiltrados.length === 0 && (
            <div className="border border-dashed border-[#D8CDB0] rounded-lg p-6 text-center">
              <p className="text-sm text-[#8A7A5C]">No hay movimientos en este período</p>
            </div>
          )}
        </div>

        {/* Botón flotante */}
        <button
          onClick={() => setVista('nuevo')}
          className="fixed bottom-6 right-6 flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-3 rounded-lg hover:bg-[#8B4423] transition-colors shadow-lg"
        >
          <Plus className="w-5 h-5" /> Nuevo movimiento
        </button>
      </div>
    </div>
  );
}
