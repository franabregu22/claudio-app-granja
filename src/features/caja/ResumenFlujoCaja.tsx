import { useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { useArqueos } from '../../hooks/useArqueos';
import { formatoPesos } from '../pedidos/helpers';

const CAJA_CHICA_ID = 'f64e4f2c-20be-408a-9800-aa539da09e5d';

interface FormaData {
  label: string;
  key: 'efectivo' | 'mercadopago' | 'cheque' | 'echeq' | 'otros';
}

interface MesDatos {
  mes: string;
  mesNumerico: string;
  [key: string]: any;
}

const FORMAS_PAGO: FormaData[] = [
  { label: 'Efectivo', key: 'efectivo' },
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

      // Buscar el último arqueo anterior a este mes
      const arqueosAnteriores = arqueos.filter(
        (a) => a.fecha_arqueo < mesStr
      );
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
            .filter((m) => m.tipo === 'ingreso' && !['efectivo', 'mercadopago', 'cheque', 'echeq'].includes(m.forma_pago))
            .reduce((sum, m) => sum + m.monto, 0);
          egresos = movimientosMes
            .filter((m) => m.tipo === 'egreso' && !['efectivo', 'mercadopago', 'cheque', 'echeq'].includes(m.forma_pago))
            .reduce((sum, m) => sum + m.monto, 0);
        } else {
          ingresos = movimientosMes
            .filter((m) => m.tipo === 'ingreso' && m.forma_pago === formaKey)
            .reduce((sum, m) => sum + m.monto, 0);
          egresos = movimientosMes
            .filter((m) => m.tipo === 'egreso' && m.forma_pago === formaKey)
            .reduce((sum, m) => sum + m.monto, 0);
        }

        // Apertura solo para efectivo (viene del arqueo)
        let apertura: number | null = null;
        if (formaKey === 'efectivo' && ultimoArqueoDeMesAnterior) {
          apertura = ultimoArqueoDeMesAnterior.monto_fisico;
        }

        mesData[`${formaKey}_apertura`] = apertura;
        mesData[`${formaKey}_ingresos`] = ingresos;
        mesData[`${formaKey}_egresos`] = egresos;
        mesData[`${formaKey}_saldo_final`] = (apertura || 0) + ingresos - egresos;
      });

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

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-amber-50 border-b border-[#D8CDB0]">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Concepto</th>
            {mesesData.map((mes) => (
              <th
                key={mes.mesNumerico}
                className="px-2 py-2 text-center font-semibold text-[#2C2419] border-l border-[#D8CDB0] min-w-[130px]"
              >
                {mes.mes}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FORMAS_PAGO.map((forma) => (
            <tbody key={forma.key}>
              {/* Encabezado del medio de pago */}
              <tr className="bg-stone-100 border-b border-[#D8CDB0]">
                <td colSpan={mesesData.length + 1} className="px-3 py-2 font-bold text-[#2C2419]">
                  {forma.label}
                </td>
              </tr>

              {/* Saldo Inicial */}
              <tr className="border-b border-[#E4DCC8] bg-blue-50 hover:bg-blue-100">
                <td className="px-3 py-2 pl-6 text-[#2C2419]">Saldo Inicial</td>
                {mesesData.map((mes) => (
                  <td
                    key={`${forma.key}-apertura-${mes.mesNumerico}`}
                    className="px-2 py-2 text-right font-semibold text-blue-700 border-l border-[#E4DCC8]"
                  >
                    {mes[`${forma.key}_apertura`] !== null ? formatoPesos(mes[`${forma.key}_apertura`]) : '—'}
                  </td>
                ))}
              </tr>

              {/* Ingresos */}
              <tr className="border-b border-[#E4DCC8] hover:bg-green-50">
                <td className="px-3 py-2 pl-6 text-[#2C2419]">+ Ingresos</td>
                {mesesData.map((mes) => (
                  <td
                    key={`${forma.key}-ingresos-${mes.mesNumerico}`}
                    className="px-2 py-2 text-right text-green-700 font-medium border-l border-[#E4DCC8]"
                  >
                    {mes[`${forma.key}_ingresos`] > 0 ? formatoPesos(mes[`${forma.key}_ingresos`]) : '—'}
                  </td>
                ))}
              </tr>

              {/* Egresos */}
              <tr className="border-b border-[#E4DCC8] hover:bg-red-50">
                <td className="px-3 py-2 pl-6 text-[#2C2419]">- Egresos</td>
                {mesesData.map((mes) => (
                  <td
                    key={`${forma.key}-egresos-${mes.mesNumerico}`}
                    className="px-2 py-2 text-right text-red-700 font-medium border-l border-[#E4DCC8]"
                  >
                    {mes[`${forma.key}_egresos`] > 0 ? formatoPesos(mes[`${forma.key}_egresos`]) : '—'}
                  </td>
                ))}
              </tr>

              {/* Saldo Final */}
              <tr className="border-b-2 border-[#D8CDB0] bg-amber-50">
                <td className="px-3 py-2 pl-6 font-bold text-[#2C2419]">= Saldo Final</td>
                {mesesData.map((mes) => (
                  <td
                    key={`${forma.key}-saldo-final-${mes.mesNumerico}`}
                    className="px-2 py-2 text-right font-bold text-[#2C2419] border-l border-[#E4DCC8]"
                  >
                    {formatoPesos(mes[`${forma.key}_saldo_final`])}
                  </td>
                ))}
              </tr>
            </tbody>
          ))}
        </tbody>
      </table>
    </div>
  );
}
