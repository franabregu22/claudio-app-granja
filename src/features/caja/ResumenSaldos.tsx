import { useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { formatoPesos } from '../pedidos/helpers';
import { getTodayDate } from '../../utils/dateUtils';

export function ResumenSaldos() {
  const movimientosQuery = useMovimientosCaja();
  const hoy = getTodayDate();

  const resumen = useMemo(() => {
    const movimientos = (movimientosQuery.data || []).filter(
      (m) => m.movimiento_estado === 'confirmado'
    );

    const saldoCajaChica = movimientos
      .filter((m) => m.forma_pago === 'efectivo')
      .reduce((sum, m) => sum + (m.tipo === 'ingreso' ? m.monto : -m.monto), 0);

    const saldoMP = movimientos
      .filter((m) => m.forma_pago === 'mercadopago')
      .reduce((sum, m) => sum + (m.tipo === 'ingreso' ? m.monto : -m.monto), 0);

    const saldoBNA = movimientos
      .filter((m) => m.forma_pago === 'transferencia')
      .reduce((sum, m) => sum + (m.tipo === 'ingreso' ? m.monto : -m.monto), 0);

    const totalSaldos = saldoCajaChica + saldoMP + saldoBNA;

    const movimientosHoy = movimientos.filter((m) => m.fecha_operacion === hoy);
    const ingresosHoy = movimientosHoy
      .filter((m) => m.tipo === 'ingreso')
      .reduce((sum, m) => sum + m.monto, 0);
    const egresosHoy = movimientosHoy
      .filter((m) => m.tipo === 'egreso')
      .reduce((sum, m) => sum + m.monto, 0);

    return {
      saldoCajaChica,
      saldoMP,
      saldoBNA,
      totalSaldos,
      ingresosHoy,
      egresosHoy,
      pctCajaChica: totalSaldos > 0 ? (saldoCajaChica / totalSaldos) * 100 : 0,
      pctMP: totalSaldos > 0 ? (saldoMP / totalSaldos) * 100 : 0,
      pctBNA: totalSaldos > 0 ? (saldoBNA / totalSaldos) * 100 : 0,
    };
  }, [movimientosQuery.data]);

  if (movimientosQuery.isLoading) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] p-4">
      {/* Total */}
      <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#D8CDB0]">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase">Total en cajas</p>
        <p className="text-3xl font-bold text-[#2C2419]">{formatoPesos(resumen.totalSaldos)}</p>
      </div>

      {/* Líneas por cuenta */}
      <div className="space-y-2 mb-4">
        {/* Caja Chica */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#2C2419] font-medium">💵 Caja Chica</span>
          <div className="flex items-center gap-4">
            <span className="text-[#2C2419] font-bold">{formatoPesos(resumen.saldoCajaChica)}</span>
            <span className="text-[#8A7A5C] text-xs w-12 text-right">{resumen.pctCajaChica.toFixed(0)}%</span>
          </div>
        </div>

        {/* MercadoPago */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#2C2419] font-medium">💳 MercadoPago</span>
          <div className="flex items-center gap-4">
            <span className="text-[#2C2419] font-bold">{formatoPesos(resumen.saldoMP)}</span>
            <span className="text-[#8A7A5C] text-xs w-12 text-right">{resumen.pctMP.toFixed(0)}%</span>
          </div>
        </div>

        {/* BNA */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#2C2419] font-medium">🏦 BNA</span>
          <div className="flex items-center gap-4">
            <span className="text-[#2C2419] font-bold">{formatoPesos(resumen.saldoBNA)}</span>
            <span className="text-[#8A7A5C] text-xs w-12 text-right">{resumen.pctBNA.toFixed(0)}%</span>
          </div>
        </div>
      </div>

    </div>
  );
}
