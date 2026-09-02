import { useMemo } from 'react';
import { useMovimientosCaja } from '../../hooks/useCaja';
import { useCuentas, useUltimoArqueo } from '../../hooks/useArqueos';
import { formatoPesos } from '../pedidos/helpers';

interface MesDatos {
  mes: string;
  mesNumerico: string;
  apertura: number | null;
  efectivoIngresos: number;
  efectivoEgresos: number;
  mercadopagoIngresos: number;
  mercadopagoEgresos: number;
  chequeIngresos: number;
  chequeEgresos: number;
  echeqIngresos: number;
  echeqEgresos: number;
  otrosIngresos: number;
  otrosEgresos: number;
}

export function ResumenFlujoCaja() {
  const movimientosQuery = useMovimientosCaja();
  const cuentasQuery = useCuentas();

  const mesesData = useMemo(() => {
    const movimientos = (movimientosQuery.data || []).filter(
      (m) => m.movimiento_estado === 'confirmado'
    );

    const hoy = new Date();
    const datos: MesDatos[] = [];

    // Últimos 8 meses
    for (let i = 7; i >= 0; i--) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const mesStr = fecha.toISOString().slice(0, 7);
      const mesProximo = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 1);
      const mesProxStr = mesProximo.toISOString().slice(0, 7);

      const movimientosMes = movimientos.filter(
        (m) => m.fecha_operacion >= mesStr && m.fecha_operacion < mesProxStr
      );

      const formas = ['efectivo', 'mercadopago', 'cheque', 'echeq'] as const;
      const mesData: MesDatos = {
        mes: fecha.toLocaleDateString('es-AR', { month: 'long', year: '2-digit' }).replace(/\./g, ''),
        mesNumerico: mesStr,
        apertura: null,
        efectivoIngresos: 0,
        efectivoEgresos: 0,
        mercadopagoIngresos: 0,
        mercadopagoEgresos: 0,
        chequeIngresos: 0,
        chequeEgresos: 0,
        echeqIngresos: 0,
        echeqEgresos: 0,
        otrosIngresos: 0,
        otrosEgresos: 0,
      };

      formas.forEach((forma) => {
        const ingresos = movimientosMes
          .filter((m) => m.tipo === 'ingreso' && m.forma_pago === forma)
          .reduce((sum, m) => sum + m.monto, 0);

        const egresos = movimientosMes
          .filter((m) => m.tipo === 'egreso' && m.forma_pago === forma)
          .reduce((sum, m) => sum + m.monto, 0);

        if (forma === 'efectivo') {
          mesData.efectivoIngresos = ingresos;
          mesData.efectivoEgresos = egresos;
        } else if (forma === 'mercadopago') {
          mesData.mercadopagoIngresos = ingresos;
          mesData.mercadopagoEgresos = egresos;
        } else if (forma === 'cheque') {
          mesData.chequeIngresos = ingresos;
          mesData.chequeEgresos = egresos;
        } else if (forma === 'echeq') {
          mesData.echeqIngresos = ingresos;
          mesData.echeqEgresos = egresos;
        }
      });

      // Otros
      const otrosIngresos = movimientosMes
        .filter((m) => m.tipo === 'ingreso' && !formas.includes(m.forma_pago as any))
        .reduce((sum, m) => sum + m.monto, 0);
      const otrosEgresos = movimientosMes
        .filter((m) => m.tipo === 'egreso' && !formas.includes(m.forma_pago as any))
        .reduce((sum, m) => sum + m.monto, 0);

      mesData.otrosIngresos = otrosIngresos;
      mesData.otrosEgresos = otrosEgresos;

      datos.push(mesData);
    }

    return datos;
  }, [movimientosQuery.data]);

  if (movimientosQuery.isLoading || cuentasQuery.isLoading) {
    return <div className="text-center text-[#8A7A5C]">Cargando...</div>;
  }

  if (mesesData.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">Sin datos</p>
      </div>
    );
  }

  const totalIngresos = (mes: MesDatos) =>
    mes.efectivoIngresos +
    mes.mercadopagoIngresos +
    mes.chequeIngresos +
    mes.echeqIngresos +
    mes.otrosIngresos;

  const totalEgresos = (mes: MesDatos) =>
    mes.efectivoEgresos +
    mes.mercadopagoEgresos +
    mes.chequeEgresos +
    mes.echeqEgresos +
    mes.otrosEgresos;

  const neto = (mes: MesDatos) => {
    const apertura = mes.apertura || 0;
    return apertura + totalIngresos(mes) - totalEgresos(mes);
  };

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-amber-50 border-b border-[#D8CDB0]">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Concepto</th>
            {mesesData.map((mes) => (
              <th
                key={mes.mesNumerico}
                className="px-2 py-2 text-center font-semibold text-[#2C2419] border-l border-[#D8CDB0] min-w-[120px]"
              >
                {mes.mes}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* APERTURA */}
          <tr className="border-b border-[#E4DCC8] bg-blue-50 hover:bg-blue-100">
            <td className="px-3 py-2 font-bold text-[#2C2419]">Apertura</td>
            {mesesData.map((mes) => (
              <td
                key={`apertura-${mes.mesNumerico}`}
                className="px-2 py-2 text-right font-semibold text-blue-700 border-l border-[#E4DCC8]"
              >
                {mes.apertura !== null ? formatoPesos(mes.apertura) : '—'}
              </td>
            ))}
          </tr>

          {/* INGRESOS */}
          <tr className="border-b border-[#E4DCC8] bg-green-50">
            <td className="px-3 py-2 font-bold text-[#2C2419]">INGRESOS</td>
            {mesesData.map((mes) => (
              <td key={`ing-header-${mes.mesNumerico}`} className="px-2 py-2 text-center font-semibold text-green-700 border-l border-[#E4DCC8]">
                {formatoPesos(totalIngresos(mes))}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  Efectivo</td>
            {mesesData.map((mes) => (
              <td
                key={`ing-efe-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-green-700 border-l border-[#E4DCC8]"
              >
                {mes.efectivoIngresos > 0 ? formatoPesos(mes.efectivoIngresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  MercadoPago</td>
            {mesesData.map((mes) => (
              <td
                key={`ing-mp-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-green-700 border-l border-[#E4DCC8]"
              >
                {mes.mercadopagoIngresos > 0 ? formatoPesos(mes.mercadopagoIngresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  Cheque</td>
            {mesesData.map((mes) => (
              <td
                key={`ing-chq-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-green-700 border-l border-[#E4DCC8]"
              >
                {mes.chequeIngresos > 0 ? formatoPesos(mes.chequeIngresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  E-Cheq</td>
            {mesesData.map((mes) => (
              <td
                key={`ing-echq-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-green-700 border-l border-[#E4DCC8]"
              >
                {mes.echeqIngresos > 0 ? formatoPesos(mes.echeqIngresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  Otros</td>
            {mesesData.map((mes) => (
              <td
                key={`ing-otros-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-green-700 border-l border-[#E4DCC8]"
              >
                {mes.otrosIngresos > 0 ? formatoPesos(mes.otrosIngresos) : '—'}
              </td>
            ))}
          </tr>

          {/* EGRESOS */}
          <tr className="border-b border-[#E4DCC8] bg-red-50">
            <td className="px-3 py-2 font-bold text-[#2C2419]">EGRESOS</td>
            {mesesData.map((mes) => (
              <td key={`egr-header-${mes.mesNumerico}`} className="px-2 py-2 text-center font-semibold text-red-700 border-l border-[#E4DCC8]">
                {formatoPesos(totalEgresos(mes))}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  Efectivo</td>
            {mesesData.map((mes) => (
              <td
                key={`egr-efe-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-red-700 border-l border-[#E4DCC8]"
              >
                {mes.efectivoEgresos > 0 ? formatoPesos(mes.efectivoEgresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  MercadoPago</td>
            {mesesData.map((mes) => (
              <td
                key={`egr-mp-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-red-700 border-l border-[#E4DCC8]"
              >
                {mes.mercadopagoEgresos > 0 ? formatoPesos(mes.mercadopagoEgresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  Cheque</td>
            {mesesData.map((mes) => (
              <td
                key={`egr-chq-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-red-700 border-l border-[#E4DCC8]"
              >
                {mes.chequeEgresos > 0 ? formatoPesos(mes.chequeEgresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  E-Cheq</td>
            {mesesData.map((mes) => (
              <td
                key={`egr-echq-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-red-700 border-l border-[#E4DCC8]"
              >
                {mes.echeqEgresos > 0 ? formatoPesos(mes.echeqEgresos) : '—'}
              </td>
            ))}
          </tr>

          <tr className="border-b border-[#E4DCC8]">
            <td className="px-3 py-2 pl-6 text-[#2C2419]">  Otros</td>
            {mesesData.map((mes) => (
              <td
                key={`egr-otros-${mes.mesNumerico}`}
                className="px-2 py-2 text-right text-red-700 border-l border-[#E4DCC8]"
              >
                {mes.otrosEgresos > 0 ? formatoPesos(mes.otrosEgresos) : '—'}
              </td>
            ))}
          </tr>

          {/* NETO */}
          <tr className="bg-amber-100 border-b border-[#D8CDB0]">
            <td className="px-3 py-2 font-bold text-[#2C2419]">NETO</td>
            {mesesData.map((mes) => (
              <td
                key={`neto-${mes.mesNumerico}`}
                className="px-2 py-2 text-right font-bold text-[#2C2419] border-l border-[#D8CDB0]"
              >
                {formatoPesos(neto(mes))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
