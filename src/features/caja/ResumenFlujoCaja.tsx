import { useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { useArqueos } from '../../hooks/useArqueos';
import { formatoPesos } from '../pedidos/helpers';

const CAJA_CHICA_ID = 'f64e4f2c-20be-408a-9800-aa539da09e5d';

interface FormaData {
  label: string;
  key: 'efectivo' | 'mercadopago' | 'cheque' | 'echeq' | 'otros' | 'transferencia';
}

interface MesDatos {
  mes: string;
  mesNumerico: string;
  [key: string]: any;
}

const FORMAS_PAGO: FormaData[] = [
  { label: 'Efectivo', key: 'efectivo' },
  { label: 'BNA', key: 'transferencia' },
  { label: 'MercadoPago', key: 'mercadopago' },
  { label: 'Cheque', key: 'cheque' },
  { label: 'E-Cheq', key: 'echeq' },
  { label: 'Otros', key: 'otros' },
];

export function ResumenFlujoCaja() {
  const movimientosQuery = useMovimientosCaja();
  const arqueosQuery = useArqueos(CAJA_CHICA_ID);

  const mesesData = useMemo(() => {
    const movimientos = (movimientosQuery.data || []).filter(
      (m) => m.movimiento_estado === 'confirmado'
    );

    const arqueos = arqueosQuery.data || [];

    const hoy = new Date();
    const datos: MesDatos[] = [];

    for (let i = 7; i >= 0; i--) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const mesStr = fecha.toISOString().slice(0, 7);
      const mesProximo = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 1);
      const mesProxStr = mesProximo.toISOString().slice(0, 7);

      const movimientosMes = movimientos.filter(
        (m) => m.fecha_operacion >= mesStr && m.fecha_operacion < mesProxStr
      );

      const arqueosAnteriores = arqueos.filter((a) => a.fecha_arqueo < mesStr);
      const ultimoArqueoDeMesAnterior = arqueosAnteriores.length > 0
        ? arqueosAnteriores.reduce((max, a) =>
            new Date(a.fecha_arqueo) > new Date(max.fecha_arqueo) ? a : max
          )
        : null;

      const mesData: MesDatos = {
        mes: fecha.toLocaleDateString('es-AR', { month: 'long', year: '2-digit' }).replace(/\./g, ''),
        mesNumerico: mesStr,
      };

      FORMAS_PAGO.forEach((forma) => {
        const formaKey = forma.key;
        let ingresos = 0;
        let egresos = 0;

        if (forma.key === 'otros') {
          ingresos = movimientosMes
            .filter((m) => m.tipo === 'ingreso' && !['efectivo', 'mercadopago', 'cheque', 'echeq', 'transferencia'].includes(m.forma_pago))
            .reduce((sum, m) => sum + m.monto, 0);
          egresos = movimientosMes
            .filter((m) => m.tipo === 'egreso' && !['efectivo', 'mercadopago', 'cheque', 'echeq', 'transferencia'].includes(m.forma_pago))
            .reduce((sum, m) => sum + m.monto, 0);
        } else {
          ingresos = movimientosMes
            .filter((m) => m.tipo === 'ingreso' && m.forma_pago === formaKey)
            .reduce((sum, m) => sum + m.monto, 0);
          egresos = movimientosMes
            .filter((m) => m.tipo === 'egreso' && m.forma_pago === formaKey)
            .reduce((sum, m) => sum + m.monto, 0);
        }

        let apertura: number | null = null;
        if (formaKey === 'efectivo' && ultimoArqueoDeMesAnterior) {
          apertura = ultimoArqueoDeMesAnterior.monto_fisico;
        }

        const subtotal = (apertura || 0) + ingresos - egresos;

        mesData[`${formaKey}_apertura`] = apertura;
        mesData[`${formaKey}_ingresos`] = ingresos;
        mesData[`${formaKey}_egresos`] = egresos;
        mesData[`${formaKey}_subtotal`] = subtotal;
      });

      // Neto mensual (suma de todos los subtotales)
      const netoMensual = FORMAS_PAGO.reduce(
        (sum, forma) => sum + (mesData[`${forma.key}_subtotal`] || 0),
        0
      );
      mesData.netoMensual = netoMensual;

      datos.push(mesData);
    }

    return datos;
  }, [movimientosQuery.data, arqueosQuery.data]);

  if (movimientosQuery.isLoading || arqueosQuery.isLoading) {
    return <div className="text-center text-[#8A7A5C]">Cargando...</div>;
  }

  if (mesesData.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">Sin datos</p>
      </div>
    );
  }

  const ultimoMes = mesesData[mesesData.length - 1];
  const mesesParaMostrar = {
    mobile: [ultimoMes],
    desktop: mesesData,
  };

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
      {/* Mobile: solo último mes */}
      <div className="md:hidden">
        <table className="w-full text-xs">
          <thead className="bg-amber-50 border-b border-[#D8CDB0]">
            <tr>
              <th className="px-2 py-2 text-left font-semibold text-[#2C2419]">Concepto</th>
              <th className="px-1 py-2 text-center font-semibold text-[#2C2419] border-l border-[#D8CDB0]">
                {ultimoMes.mes}
              </th>
            </tr>
          </thead>
          <tbody>
            {FORMAS_PAGO.flatMap((forma) => [
              <tr key={`m-header-${forma.key}`} className="bg-stone-100 border-b border-[#D8CDB0]">
                <td className="px-2 py-2 font-bold text-[#2C2419]">{forma.label}</td>
                <td className="border-l border-[#D8CDB0]"></td>
              </tr>,
              <tr key={`m-apertura-${forma.key}`} className="border-b border-[#E4DCC8]">
                <td className="px-2 py-2 pl-4 text-[#2C2419] text-xs">Saldo Inicial</td>
                <td className="px-1 py-2 text-right text-blue-700 font-medium border-l border-[#E4DCC8]">
                  {ultimoMes[`${forma.key}_apertura`] !== null ? formatoPesos(ultimoMes[`${forma.key}_apertura`]) : '—'}
                </td>
              </tr>,
              <tr key={`m-ingresos-${forma.key}`} className="border-b border-[#E4DCC8]">
                <td className="px-2 py-2 pl-4 text-[#2C2419] text-xs">Ingresos</td>
                <td className="px-1 py-2 text-right text-green-700 font-medium border-l border-[#E4DCC8]">
                  {ultimoMes[`${forma.key}_ingresos`] > 0 ? formatoPesos(ultimoMes[`${forma.key}_ingresos`]) : '—'}
                </td>
              </tr>,
              <tr key={`m-egresos-${forma.key}`} className="border-b border-[#E4DCC8]">
                <td className="px-2 py-2 pl-4 text-[#2C2419] text-xs">Egresos</td>
                <td className="px-1 py-2 text-right text-red-700 font-medium border-l border-[#E4DCC8]">
                  {ultimoMes[`${forma.key}_egresos`] > 0 ? formatoPesos(ultimoMes[`${forma.key}_egresos`]) : '—'}
                </td>
              </tr>,
              <tr key={`m-subtotal-${forma.key}`} className="border-b-2 border-[#D8CDB0] bg-amber-50">
                <td className="px-2 py-2 pl-4 font-semibold text-[#2C2419] text-xs">Subtotal</td>
                <td className="px-1 py-2 text-right font-semibold text-[#2C2419] border-l border-[#D8CDB0]">
                  {formatoPesos(ultimoMes[`${forma.key}_subtotal`])}
                </td>
              </tr>,
            ])}
            <tr className="bg-[#A8552E] text-white border-b border-[#8B4423]">
              <td className="px-2 py-2 font-bold text-sm">Neto Mensual</td>
              <td className="px-1 py-2 text-right font-bold border-l border-[#8B4423]">
                {formatoPesos(ultimoMes.netoMensual)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Desktop: todos los meses */}
      <div className="hidden md:block">
        <table className="w-full text-xs">
        <thead className="bg-amber-50 border-b border-[#D8CDB0]">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Concepto</th>
            {mesesData.map((mes) => (
              <th
                key={mes.mesNumerico}
                className="px-1 py-2 text-center font-semibold text-[#2C2419] border-l border-[#D8CDB0] min-w-[100px]"
              >
                {mes.mes}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FORMAS_PAGO.flatMap((forma) => [
            // Encabezado del medio de pago
            <tr key={`header-${forma.key}`} className="bg-stone-100 border-b border-[#D8CDB0]">
              <td className="px-3 py-2 font-bold text-[#2C2419]">{forma.label}</td>
              {mesesData.map((mes) => (
                <td key={`header-${forma.key}-${mes.mesNumerico}`} className="border-l border-[#D8CDB0]"></td>
              ))}
            </tr>,

            // Saldo Inicial
            <tr key={`apertura-${forma.key}`} className="border-b border-[#E4DCC8]">
              <td className="px-3 py-2 pl-6 text-[#2C2419]">Saldo Inicial</td>
              {mesesData.map((mes) => (
                <td
                  key={`apertura-${forma.key}-${mes.mesNumerico}`}
                  className="px-1 py-2 text-right text-blue-700 font-medium border-l border-[#E4DCC8]"
                >
                  {mes[`${forma.key}_apertura`] !== null ? formatoPesos(mes[`${forma.key}_apertura`]) : '—'}
                </td>
              ))}
            </tr>,

            // Ingresos
            <tr key={`ingresos-${forma.key}`} className="border-b border-[#E4DCC8]">
              <td className="px-3 py-2 pl-6 text-[#2C2419]">Ingresos</td>
              {mesesData.map((mes) => (
                <td
                  key={`ingresos-${forma.key}-${mes.mesNumerico}`}
                  className="px-1 py-2 text-right text-green-700 font-medium border-l border-[#E4DCC8]"
                >
                  {mes[`${forma.key}_ingresos`] > 0 ? formatoPesos(mes[`${forma.key}_ingresos`]) : '—'}
                </td>
              ))}
            </tr>,

            // Egresos
            <tr key={`egresos-${forma.key}`} className="border-b border-[#E4DCC8]">
              <td className="px-3 py-2 pl-6 text-[#2C2419]">Egresos</td>
              {mesesData.map((mes) => (
                <td
                  key={`egresos-${forma.key}-${mes.mesNumerico}`}
                  className="px-1 py-2 text-right text-red-700 font-medium border-l border-[#E4DCC8]"
                >
                  {mes[`${forma.key}_egresos`] > 0 ? formatoPesos(mes[`${forma.key}_egresos`]) : '—'}
                </td>
              ))}
            </tr>,

            // Subtotal
            <tr key={`subtotal-${forma.key}`} className="border-b-2 border-[#D8CDB0] bg-amber-50">
              <td className="px-3 py-2 pl-6 font-semibold text-[#2C2419]">Subtotal</td>
              {mesesData.map((mes) => (
                <td
                  key={`subtotal-${forma.key}-${mes.mesNumerico}`}
                  className="px-1 py-2 text-right font-semibold text-[#2C2419] border-l border-[#D8CDB0]"
                >
                  {formatoPesos(mes[`${forma.key}_subtotal`])}
                </td>
              ))}
            </tr>,
          ])}

          {/* NETO MENSUAL */}
          <tr className="bg-[#A8552E] text-white border-b border-[#8B4423]">
            <td className="px-3 py-2 font-bold">Neto Mensual</td>
            {mesesData.map((mes) => (
              <td
                key={`neto-${mes.mesNumerico}`}
                className="px-1 py-2 text-right font-bold border-l border-[#8B4423]"
              >
                {formatoPesos(mes.netoMensual)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}
