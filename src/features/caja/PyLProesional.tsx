import { useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { formatoPesos } from '../pedidos/helpers';

interface MesData {
  mes: string;
  ventasTotales: number;
  ventasFacturadas: number;
  ventasNoFacturadas: number;
  costosAlimento: number;
  costosCartones: number;
  costosSueldos: number;
  costosElectricidad: number;
  costosAgua: number;
  costosTelefo: number;
  costosVeterinario: number;
  costosOtros: number;
}

const CATEGORIAS_ALIMENTO = ['Insumos alimento balanceado'];
const CATEGORIAS_CARTONES = ['Cartones / envases'];
const CATEGORIAS_SUELDOS = ['Mano de obra'];
const CATEGORIAS_ELECTRICIDAD = ['Servicios']; // filtrar por subcategoría

export function PyLProfesional() {
  const movimientosQuery = useMovimientosCaja();

  const mesesData = useMemo(() => {
    const movimientos = (movimientosQuery.data || []).filter(
      (m) => m.movimiento_estado === 'confirmado'
    );

    const hoy = new Date();
    const datos: MesData[] = [];

    // Últimos 8 meses
    for (let i = 7; i >= 0; i--) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const mesStr = fecha.toISOString().slice(0, 7);
      const mesProximo = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 1);
      const mesProxStr = mesProximo.toISOString().slice(0, 7);

      const movimientosMes = movimientos.filter(
        (m) => m.fecha_operacion >= mesStr && m.fecha_operacion < mesProxStr
      );

      const ventasTotales = movimientosMes
        .filter((m) => m.tipo === 'ingreso')
        .reduce((sum, m) => sum + m.monto, 0);

      const ventasFacturadas = movimientosMes
        .filter((m) => m.tipo === 'ingreso' && m.es_facturada)
        .reduce((sum, m) => sum + m.monto, 0);

      const ventasNoFacturadas = ventasTotales - ventasFacturadas;

      // Costos por categoría
      const costosAlimento = movimientosMes
        .filter((m) => m.tipo === 'egreso' && CATEGORIAS_ALIMENTO.includes(m.categoria_tecnica || ''))
        .reduce((sum, m) => sum + m.monto, 0);

      const costosCartones = movimientosMes
        .filter((m) => m.tipo === 'egreso' && CATEGORIAS_CARTONES.includes(m.categoria_tecnica || ''))
        .reduce((sum, m) => sum + m.monto, 0);

      const costosSueldos = movimientosMes
        .filter((m) => m.tipo === 'egreso' && CATEGORIAS_SUELDOS.includes(m.categoria_tecnica || ''))
        .reduce((sum, m) => sum + m.monto, 0);

      const costosElectricidad = movimientosMes
        .filter((m) => m.tipo === 'egreso' && m.categoria_tecnica === 'Electricidad')
        .reduce((sum, m) => sum + m.monto, 0);

      const costosAgua = movimientosMes
        .filter((m) => m.tipo === 'egreso' && m.categoria_tecnica === 'Agua potable')
        .reduce((sum, m) => sum + m.monto, 0);

      const costosTelefo = movimientosMes
        .filter((m) => m.tipo === 'egreso' && m.categoria_tecnica === 'Telefonía / Internet')
        .reduce((sum, m) => sum + m.monto, 0);

      const costosVeterinario = movimientosMes
        .filter((m) => m.tipo === 'egreso' && m.categoria_tecnica === 'Veterinario')
        .reduce((sum, m) => sum + m.monto, 0);

      const costosOtros = movimientosMes
        .filter(
          (m) =>
            m.tipo === 'egreso' &&
            ![
              ...CATEGORIAS_ALIMENTO,
              ...CATEGORIAS_CARTONES,
              ...CATEGORIAS_SUELDOS,
              'Electricidad',
              'Agua potable',
              'Telefonía / Internet',
              'Veterinario',
            ].includes(m.categoria_tecnica || '')
        )
        .reduce((sum, m) => sum + m.monto, 0);

      datos.push({
        mes: fecha.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }),
        ventasTotales,
        ventasFacturadas,
        ventasNoFacturadas,
        costosAlimento,
        costosCartones,
        costosSueldos,
        costosElectricidad,
        costosAgua,
        costosTelefo,
        costosVeterinario,
        costosOtros,
      });
    }

    return datos;
  }, [movimientosQuery.data]);

  if (movimientosQuery.isLoading) {
    return <div className="text-center text-[#8A7A5C]">Cargando...</div>;
  }

  if (mesesData.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">Sin datos</p>
      </div>
    );
  }

  // Calcular totales
  const ventasTotalAll = mesesData.reduce((sum, m) => sum + m.ventasTotales, 0);

  return (
    <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-[#FAF6EE]">
            <th className="border border-[#D8CDB0] px-3 py-2 text-left font-bold text-[#2C2419] w-48">
              Concepto
            </th>
            {mesesData.map((mes) => (
              <th key={mes.mes} className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419] whitespace-nowrap">
                {mes.mes}
              </th>
            ))}
            <th className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419] w-24">
              % sobre total
            </th>
          </tr>
        </thead>
        <tbody>
          {/* VENTAS */}
          <tr className="bg-gray-50">
            <td className="border border-[#D8CDB0] px-3 py-2 font-bold text-[#2C2419]">
              Ventas totales devengadas
            </td>
            {mesesData.map((mes) => (
              <td key={`vt-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419]">
                {formatoPesos(mes.ventasTotales)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419] bg-amber-50">
              100%
            </td>
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Ventas Facturadas</td>
            {mesesData.map((mes) => (
              <td key={`vf-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.ventasFacturadas)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50">
              {ventasTotalAll > 0
                ? ((mesesData.reduce((sum, m) => sum + m.ventasFacturadas, 0) / ventasTotalAll) * 100).toFixed(0)
                : '0'}
              %
            </td>
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Ventas No Facturadas</td>
            {mesesData.map((mes) => (
              <td key={`vnf-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.ventasNoFacturadas)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50">
              {ventasTotalAll > 0
                ? ((mesesData.reduce((sum, m) => sum + m.ventasNoFacturadas, 0) / ventasTotalAll) * 100).toFixed(0)
                : '0'}
              %
            </td>
          </tr>

          {/* COSTOS OPERATIVOS DIRECTOS */}
          <tr className="bg-gray-50">
            <td className="border border-[#D8CDB0] px-3 py-2 font-bold text-[#2C2419]">
              Costos operativos directos
            </td>
            {mesesData.map((mes) => (
              <td key={`cod-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419]">
                {formatoPesos(mes.costosAlimento + mes.costosCartones)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419] bg-amber-50">
              {ventasTotalAll > 0
                ? (
                    ((mesesData.reduce((sum, m) => sum + m.costosAlimento + m.costosCartones, 0) /
                      ventasTotalAll) *
                      100).toFixed(0)
                  )
                : '0'}
              %
            </td>
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Costo alimento balanceado</td>
            {mesesData.map((mes) => (
              <td key={`cal-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.costosAlimento)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50" />
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Costo cartones</td>
            {mesesData.map((mes) => (
              <td key={`cart-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.costosCartones)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50" />
          </tr>

          {/* COSTOS OPERATIVOS INDIRECTOS */}
          <tr className="bg-gray-50">
            <td className="border border-[#D8CDB0] px-3 py-2 font-bold text-[#2C2419]">
              Costos operativos indirectos
            </td>
            {mesesData.map((mes) => {
              const total =
                mes.costosSueldos +
                mes.costosElectricidad +
                mes.costosAgua +
                mes.costosTelefo +
                mes.costosVeterinario +
                mes.costosOtros;
              return (
                <td key={`coi-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419]">
                  {formatoPesos(total)}
                </td>
              );
            })}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-[#2C2419] bg-amber-50">
              {ventasTotalAll > 0
                ? (
                    ((mesesData.reduce(
                      (sum, m) =>
                        sum +
                        m.costosSueldos +
                        m.costosElectricidad +
                        m.costosAgua +
                        m.costosTelefo +
                        m.costosVeterinario +
                        m.costosOtros,
                      0
                    ) /
                      ventasTotalAll) *
                      100).toFixed(0)
                  )
                : '0'}
              %
            </td>
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Sueldos empleados</td>
            {mesesData.map((mes) => (
              <td key={`sued-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.costosSueldos)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50" />
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Electricidad</td>
            {mesesData.map((mes) => (
              <td key={`elec-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.costosElectricidad)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50" />
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Agua potable</td>
            {mesesData.map((mes) => (
              <td key={`agua-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.costosAgua)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50" />
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Telefonía / Internet</td>
            {mesesData.map((mes) => (
              <td key={`tele-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.costosTelefo)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50" />
          </tr>

          <tr>
            <td className="border border-[#D8CDB0] px-3 py-2 text-[#8A7A5C]">Veterinario</td>
            {mesesData.map((mes) => (
              <td key={`vet-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419]">
                {formatoPesos(mes.costosVeterinario)}
              </td>
            ))}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right text-[#2C2419] bg-amber-50" />
          </tr>

          {/* RESULTADO OPERATIVO */}
          <tr className="bg-green-50">
            <td className="border border-[#D8CDB0] px-3 py-2 font-bold text-green-700">
              RESULTADO OPERATIVO
            </td>
            {mesesData.map((mes) => {
              const costos = mes.costosAlimento + mes.costosCartones +
                mes.costosSueldos + mes.costosElectricidad + mes.costosAgua +
                mes.costosTelefo + mes.costosVeterinario + mes.costosOtros;
              const resultado = mes.ventasTotales - costos;
              return (
                <td key={`ro-${mes.mes}`} className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-green-700">
                  {formatoPesos(resultado)}
                </td>
              );
            })}
            <td className="border border-[#D8CDB0] px-2 py-2 text-right font-bold text-green-700 bg-amber-50">
              {ventasTotalAll > 0
                ? (
                    ((mesesData.reduce((sum, m) => {
                      const costos = m.costosAlimento + m.costosCartones +
                        m.costosSueldos + m.costosElectricidad + m.costosAgua +
                        m.costosTelefo + m.costosVeterinario + m.costosOtros;
                      return sum + (m.ventasTotales - costos);
                    }, 0) / ventasTotalAll) * 100).toFixed(0)
                  )
                : '0'}
              %
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
