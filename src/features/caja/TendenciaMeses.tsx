import { useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { formatoPesos } from '../pedidos/helpers';

interface MesResumen {
  mes: string;
  mesCorto: string;
  fecha: Date;
  ingresos: number;
  egresos: number;
  neto: number;
  margen: number;
  esActual: boolean;
}

export function TendenciaMeses() {
  const movimientosQuery = useMovimientosCaja();

  const meses = useMemo(() => {
    const movimientos = (movimientosQuery.data || []).filter(
      (m) => m.movimiento_estado === 'confirmado'
    );

    const hoy = new Date();
    const mesesData: MesResumen[] = [];

    // Últimos 6 meses
    for (let i = 5; i >= 0; i--) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const mesStr = fecha.toISOString().slice(0, 7);
      const mesProximo = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 1);
      const mesProxStr = mesProximo.toISOString().slice(0, 7);

      const movimientosMes = movimientos.filter(
        (m) => m.fecha_operacion >= mesStr && m.fecha_operacion < mesProxStr
      );

      const ingresos = movimientosMes
        .filter((m) => m.tipo === 'ingreso')
        .reduce((sum, m) => sum + m.monto, 0);

      const egresos = movimientosMes
        .filter((m) => m.tipo === 'egreso')
        .reduce((sum, m) => sum + m.monto, 0);

      const neto = ingresos - egresos;
      const margen = ingresos > 0 ? (neto / ingresos) * 100 : 0;
      const esActual = i === 0;

      const meses_sp = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
      const mesCorto = meses_sp[fecha.getMonth()];
      const año = fecha.getFullYear().toString().slice(-2);

      mesesData.push({
        mes: fecha.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }),
        mesCorto: `${mesCorto}-${año}`.toUpperCase(),
        fecha,
        ingresos,
        egresos,
        neto,
        margen,
        esActual,
      });
    }

    return mesesData;
  }, [movimientosQuery.data]);

  if (movimientosQuery.isLoading) {
    return <div className="text-center text-[#8A7A5C]">Cargando...</div>;
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-3 pb-4 min-w-max">
        {meses.map((mes) => (
          <div
            key={mes.mes}
            className={`flex-shrink-0 w-40 rounded-lg border p-4 ${
              mes.esActual
                ? 'bg-amber-100 border-amber-300'
                : 'bg-white border-[#E4DCC8] hover:bg-amber-50'
            } transition-colors`}
          >
            <p className={`text-xs font-semibold uppercase mb-3 ${
              mes.esActual ? 'text-amber-900' : 'text-[#8A6A2E]'
            }`}>
              {mes.mesCorto}
            </p>

            {/* Ingresos */}
            <div className="mb-3 pb-3 border-b border-[#D8CDB0]">
              <p className="text-xs text-[#8A7A5C] mb-1">Ingresos</p>
              <p className="text-lg font-bold text-green-700">
                {formatoPesos(mes.ingresos)}
              </p>
            </div>

            {/* Egresos */}
            <div className="mb-3 pb-3 border-b border-[#D8CDB0]">
              <p className="text-xs text-[#8A7A5C] mb-1">Egresos</p>
              <p className="text-lg font-bold text-red-700">
                {formatoPesos(mes.egresos)}
              </p>
            </div>

            {/* Neto */}
            <div className="mb-3 pb-3 border-b border-[#D8CDB0]">
              <p className="text-xs text-[#8A7A5C] mb-1">Neto</p>
              <p className={`text-lg font-bold ${
                mes.neto >= 0 ? 'text-green-700' : 'text-red-700'
              }`}>
                {mes.neto >= 0 ? '+' : ''}{formatoPesos(mes.neto)}
              </p>
            </div>

            {/* Margen */}
            <div>
              <p className="text-xs text-[#8A7A5C] mb-1">Margen</p>
              <p className={`text-lg font-bold ${
                mes.margen >= 0 ? 'text-green-700' : 'text-red-700'
              }`}>
                {mes.margen.toFixed(1)}%
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
