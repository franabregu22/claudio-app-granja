import { useEffect, useState } from 'react';
import { getMPMonthlyReport } from '../../api/mercadopago-monthly';
import type { MonthlyReport } from '../../api/mercadopago-monthly';

export function MonthlyReportTable() {
  const [data, setData] = useState<MonthlyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const report = await getMPMonthlyReport();
        setData(report);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error al cargar reporte');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const formatMonth = (mes: string) => {
    const [year, month] = mes.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1);
    return date.toLocaleDateString('es-AR', { year: 'numeric', month: 'long' });
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6">
        <div className="animate-pulse space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
        {error}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-8 text-center">
        <p className="text-gray-500">No hay datos mensuales</p>
      </div>
    );
  }

  const totals = {
    ingresos: data.reduce((sum, row) => sum + row.ingresos, 0),
    egresos: data.reduce((sum, row) => sum + row.egresos, 0),
    rendimientos: data.reduce((sum, row) => sum + row.rendimientos, 0),
    impuesto: data.reduce((sum, row) => sum + row.impuesto_al_cheque, 0),
  };

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#F5F1E8] border-b border-[#E4DCC8]">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#2C2419] uppercase">
                Mes
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#2C2419] uppercase">
                Ingresos
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#2C2419] uppercase">
                Egresos
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#2C2419] uppercase">
                Rendimientos
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#2C2419] uppercase">
                Impuesto al Cheque
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, idx) => (
              <tr
                key={row.mes}
                className={`border-b border-[#E4DCC8] ${
                  idx % 2 === 0 ? 'bg-white' : 'bg-[#FDFAF3]'
                }`}
              >
                <td className="px-4 py-3 text-sm font-medium text-[#2C2419]">
                  {formatMonth(row.mes)}
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium text-green-600">
                  {formatCurrency(row.ingresos)}
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium text-red-600">
                  {formatCurrency(row.egresos)}
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium text-yellow-600">
                  {formatCurrency(row.rendimientos)}
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium text-orange-600">
                  {formatCurrency(row.impuesto_al_cheque)}
                </td>
              </tr>
            ))}
            <tr className="bg-[#F5F1E8] border-t-2 border-[#E4DCC8] font-semibold">
              <td className="px-4 py-3 text-sm text-[#2C2419]">TOTAL</td>
              <td className="px-4 py-3 text-right text-sm text-green-700">
                {formatCurrency(totals.ingresos)}
              </td>
              <td className="px-4 py-3 text-right text-sm text-red-700">
                {formatCurrency(totals.egresos)}
              </td>
              <td className="px-4 py-3 text-right text-sm text-yellow-700">
                {formatCurrency(totals.rendimientos)}
              </td>
              <td className="px-4 py-3 text-right text-sm text-orange-700">
                {formatCurrency(totals.impuesto)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
