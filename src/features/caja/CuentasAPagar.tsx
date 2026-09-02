import { useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { formatoPesos } from '../pedidos/helpers';
import { calcularDíasDesdeBA, obtenerHoyBA } from '../../utils/dateUtils';

export function CuentasAPagar() {
  const movimientosQuery = useMovimientosCaja();
  const hoy = obtenerHoyBA();

  const { gastos, semanas, ganttData } = useMemo(() => {
    const gastosFiltered = (movimientosQuery.data || []).filter(
      (m) => m.tipo === 'egreso' && m.movimiento_estado === 'pendiente'
    );

    // Ordenar por fecha_pago_estimada
    const gastosSorted = gastosFiltered.sort((a, b) => {
      const fechaA = a.fecha_pago_estimada || '9999-12-31';
      const fechaB = b.fecha_pago_estimada || '9999-12-31';
      return fechaA.localeCompare(fechaB);
    });

    // Generar semanas (próximas 12 semanas desde hoy)
    const semanasArray: { lunes: string; label: string }[] = [];
    const hoyDate = new Date(hoy);
    const dayOfWeek = hoyDate.getDay();
    const diff = hoyDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const lunesHoy = new Date(hoyDate.setDate(diff));

    for (let i = 0; i < 12; i++) {
      const lunesSemana = new Date(lunesHoy);
      lunesSemana.setDate(lunesSemana.getDate() + i * 7);
      const lunesStr = lunesSemana.toISOString().split('T')[0];
      const label = lunesSemana.toLocaleDateString('es-AR', {
        day: '2-digit',
        month: '2-digit',
      });
      semanasArray.push({ lunes: lunesStr, label: `Lun ${label}` });
    }

    // Crear Gantt: mapear cada gasto a su semana
    const gantt: Record<number, Record<string, number>> = {};
    gastosSorted.forEach((gasto, idx) => {
      gantt[idx] = {};
      semanasArray.forEach((semana) => {
        gantt[idx][semana.lunes] = 0;
      });

      if (gasto.fecha_pago_estimada) {
        // Encontrar la semana de este pago
        const pagoDate = new Date(gasto.fecha_pago_estimada);
        const payDayOfWeek = pagoDate.getDay();
        const payDiff = pagoDate.getDate() - payDayOfWeek + (payDayOfWeek === 0 ? -6 : 1);
        const lunesPago = new Date(pagoDate);
        lunesPago.setDate(payDiff);
        const lunesPayoStr = lunesPago.toISOString().split('T')[0];

        // Asignar monto a esa semana
        if (gantt[idx][lunesPayoStr] !== undefined) {
          gantt[idx][lunesPayoStr] = gasto.monto;
        }
      }
    });

    return {
      gastos: gastosSorted,
      semanas: semanasArray,
      ganttData: gantt,
    };
  }, [movimientosQuery.data, hoy]);

  if (movimientosQuery.isLoading) {
    return null;
  }

  if (gastos.length === 0) {
    return (
      <div className="border border-dashed border-[#D8CDB0] rounded-lg p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">No hay gastos pendientes</p>
      </div>
    );
  }

  // Calcular totales por semana
  const totalesSemanas = semanas.reduce(
    (acc, semana) => {
      acc[semana.lunes] = gastos.reduce((sum, _, idx) => sum + (ganttData[idx][semana.lunes] || 0), 0);
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#F5EFE0] border-b border-[#D8CDB0]">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-[#6B5D45] text-xs uppercase min-w-48">
                Concepto
              </th>
              {semanas.map((semana) => (
                <th
                  key={semana.lunes}
                  className="text-right px-3 py-2 font-semibold text-[#6B5D45] text-xs uppercase min-w-32"
                >
                  {semana.label}
                </th>
              ))}
              <th className="text-right px-3 py-2 font-semibold text-[#6B5D45] text-xs uppercase min-w-28">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {gastos.map((gasto, idx) => (
              <tr
                key={gasto.id}
                className="border-b border-[#E4DCC8] hover:bg-[#FAF6EE] transition-colors"
              >
                <td className="px-3 py-2 text-[#2C2419] font-medium">
                  <div className="truncate">{gasto.concepto}</div>
                  <div className="text-xs text-[#8A7A5C]">{gasto.fecha_operacion}</div>
                </td>
                {semanas.map((semana) => (
                  <td key={semana.lunes} className="text-right px-3 py-2">
                    {ganttData[idx][semana.lunes] > 0 ? (
                      <div className="font-semibold text-[#2C2419]">
                        {formatoPesos(ganttData[idx][semana.lunes])}
                      </div>
                    ) : (
                      <div className="text-[#D8CDB0]">—</div>
                    )}
                  </td>
                ))}
                <td className="text-right px-3 py-2 font-bold text-[#2C2419]">
                  {formatoPesos(gasto.monto)}
                </td>
              </tr>
            ))}

            {/* Fila de totales */}
            <tr className="bg-[#F5EFE0] border-t-2 border-[#D8CDB0] font-bold text-[#6B5D45]">
              <td className="px-3 py-2 uppercase text-xs">Total Semana</td>
              {semanas.map((semana) => (
                <td key={semana.lunes} className="text-right px-3 py-2 text-[#2C2419]">
                  {totalesSemanas[semana.lunes] > 0
                    ? formatoPesos(totalesSemanas[semana.lunes])
                    : '—'}
                </td>
              ))}
              <td className="text-right px-3 py-2 text-[#2C2419]">
                {formatoPesos(gastos.reduce((sum, g) => sum + g.monto, 0))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
