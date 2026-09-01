import { useState, useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { formatoPesos } from '../pedidos/helpers';

type Periodo = 'mes-actual' | 'mes-anterior' | 'ultimos-6';

export function PyL() {
  const [periodo, setPeriodo] = useState<Periodo>('mes-actual');
  const movimientosQuery = useMovimientosCaja();

  const resumen = useMemo(() => {
    const movimientos = (movimientosQuery.data || []).filter(
      (m) => m.movimiento_estado === 'confirmado'
    );

    // Obtener rango de fechas según período
    const hoy = new Date();
    let fechaInicio: Date;
    let fechaFin = new Date(hoy);

    if (periodo === 'mes-actual') {
      fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    } else if (periodo === 'mes-anterior') {
      fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
      fechaFin = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
    } else {
      // Últimos 6 meses
      fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth() - 5, 1);
    }

    const inicio = fechaInicio.toISOString().split('T')[0];
    const fin = fechaFin.toISOString().split('T')[0];

    const movimientosFiltrados = movimientos.filter(
      (m) => m.fecha_operacion >= inicio && m.fecha_operacion <= fin
    );

    // Calcular ingresos y egresos
    const ingresos = movimientosFiltrados
      .filter((m) => m.tipo === 'ingreso')
      .reduce((sum, m) => sum + m.monto, 0);

    const egresos = movimientosFiltrados
      .filter((m) => m.tipo === 'egreso')
      .reduce((sum, m) => sum + m.monto, 0);

    // Desglose de egresos por categoría analítica
    const egresosDesglose = {
      operativos: movimientosFiltrados
        .filter((m) => m.tipo === 'egreso' && m.categoria_analisis === 'GASTOS_OPERATIVOS')
        .reduce((sum, m) => sum + m.monto, 0),
      reinversion: movimientosFiltrados
        .filter((m) => m.tipo === 'egreso' && m.categoria_analisis === 'REINVERSION_OPERATIVA')
        .reduce((sum, m) => sum + m.monto, 0),
      inversion: movimientosFiltrados
        .filter((m) => m.tipo === 'egreso' && m.categoria_analisis === 'INVERSION')
        .reduce((sum, m) => sum + m.monto, 0),
    };

    const neto = ingresos - egresos;

    return {
      ingresos,
      egresos,
      neto,
      egresosDesglose,
      periodo: `${fechaInicio.toLocaleDateString('es-AR')} → ${fechaFin.toLocaleDateString('es-AR')}`,
    };
  }, [movimientosQuery.data, periodo]);

  if (movimientosQuery.isLoading) {
    return <div className="text-center text-[#8A7A5C]">Cargando...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Selector de período */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setPeriodo('mes-actual')}
          className={`px-3 py-1.5 text-sm font-medium rounded ${
            periodo === 'mes-actual'
              ? 'bg-[#A8552E] text-white'
              : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
          }`}
        >
          Este mes
        </button>
        <button
          onClick={() => setPeriodo('mes-anterior')}
          className={`px-3 py-1.5 text-sm font-medium rounded ${
            periodo === 'mes-anterior'
              ? 'bg-[#A8552E] text-white'
              : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
          }`}
        >
          Mes anterior
        </button>
        <button
          onClick={() => setPeriodo('ultimos-6')}
          className={`px-3 py-1.5 text-sm font-medium rounded ${
            periodo === 'ultimos-6'
              ? 'bg-[#A8552E] text-white'
              : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
          }`}
        >
          Últimos 6 meses
        </button>
      </div>

      {/* Resumen P&L */}
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-4">
        <p className="text-xs text-[#8A7A5C] mb-3">{resumen.periodo}</p>

        {/* Ingresos */}
        <div className="flex justify-between items-center mb-3 pb-3 border-b border-[#D8CDB0]">
          <span className="text-sm font-semibold text-[#2C2419]">Ingresos totales</span>
          <span className="text-xl font-bold text-green-700">{formatoPesos(resumen.ingresos)}</span>
        </div>

        {/* Egresos */}
        <div className="mb-3">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-semibold text-[#2C2419]">Egresos totales</span>
            <span className="text-xl font-bold text-red-700">{formatoPesos(resumen.egresos)}</span>
          </div>

          {/* Desglose de egresos */}
          <div className="ml-4 space-y-1 text-xs">
            {resumen.egresosDesglose.operativos > 0 && (
              <div className="flex justify-between text-[#8A7A5C]">
                <span>• Gastos operativos</span>
                <span>{formatoPesos(resumen.egresosDesglose.operativos)}</span>
              </div>
            )}
            {resumen.egresosDesglose.reinversion > 0 && (
              <div className="flex justify-between text-[#8A7A5C]">
                <span>• Reinversión operativa</span>
                <span>{formatoPesos(resumen.egresosDesglose.reinversion)}</span>
              </div>
            )}
            {resumen.egresosDesglose.inversion > 0 && (
              <div className="flex justify-between text-[#8A7A5C]">
                <span>• Inversión</span>
                <span>{formatoPesos(resumen.egresosDesglose.inversion)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Resultado neto */}
        <div
          className={`flex justify-between items-center pt-3 border-t border-[#D8CDB0] ${
            resumen.neto >= 0
              ? 'bg-green-50 -mx-4 -mb-4 px-4 py-3 rounded-b-lg'
              : 'bg-red-50 -mx-4 -mb-4 px-4 py-3 rounded-b-lg'
          }`}
        >
          <span className={`font-bold ${resumen.neto >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            Resultado neto
          </span>
          <span className={`text-2xl font-bold ${resumen.neto >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            {resumen.neto >= 0 ? '+' : ''}{formatoPesos(resumen.neto)}
          </span>
        </div>
      </div>

      {/* Margen */}
      {resumen.ingresos > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-xs text-amber-700 mb-1">Margen de ganancia</p>
          <p className="text-lg font-bold text-amber-800">
            {((resumen.neto / resumen.ingresos) * 100).toFixed(1)}%
          </p>
        </div>
      )}
    </div>
  );
}
