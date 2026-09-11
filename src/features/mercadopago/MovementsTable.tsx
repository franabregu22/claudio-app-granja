import type { MPMovement } from '../../api/mercadopago';

interface MovementsTableProps {
  movements: MPMovement[];
  loading: boolean;
}

const typeLabels: Record<string, string> = {
  payment_in: 'Cobro',
  payment_out: 'Pago',
  yield: 'Rendimiento',
  transfer_in: 'Transferencia recibida',
  transfer_out: 'Transferencia enviada',
  unclassified: 'Sin clasificar',
};

const typeColors: Record<string, string> = {
  payment_in: 'text-green-600 bg-green-50',
  payment_out: 'text-red-600 bg-red-50',
  yield: 'text-yellow-600 bg-yellow-50',
  transfer_in: 'text-blue-600 bg-blue-50',
  transfer_out: 'text-orange-600 bg-orange-50',
  unclassified: 'text-gray-600 bg-gray-50',
};

export function MovementsTable({ movements, loading }: MovementsTableProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('es-AR');
  };

  const getTypeLabel = (type: string) => typeLabels[type] || type;
  const getTypeColor = (type: string) => typeColors[type] || 'text-gray-600 bg-gray-50';
  const isIncome = (amount: number) => amount >= 0;

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6">
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (movements.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-8 text-center">
        <p className="text-gray-500">No hay movimientos para este período</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#F5F1E8] border-b border-[#E4DCC8]">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#2C2419] uppercase">
                Fecha
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#2C2419] uppercase">
                Tipo
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#2C2419] uppercase">
                Concepto
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#2C2419] uppercase">
                Ingreso
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#2C2419] uppercase">
                Egreso
              </th>
            </tr>
          </thead>
          <tbody>
            {movements.map((mov, idx) => {
              const income = isIncome(mov.amount_pesos) ? mov.amount_pesos : null;
              const expense = !isIncome(mov.amount_pesos) ? Math.abs(mov.amount_pesos) : null;

              return (
                <tr
                  key={mov.id}
                  className={`border-b border-[#E4DCC8] hover:bg-[#FAF6EE] transition-colors ${
                    idx % 2 === 0 ? 'bg-white' : 'bg-[#FDFAF3]'
                  }`}
                >
                  <td className="px-4 py-3 text-sm text-[#2C2419]">
                    {formatDate(mov.movement_date)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={`inline-block px-2 py-1 rounded text-xs font-medium ${getTypeColor(
                        mov.movement_class
                      )}`}
                    >
                      {getTypeLabel(mov.movement_class)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-[#2C2419]">
                    {mov.description || mov.source_id || '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium">
                    {income !== null ? (
                      <span className="text-green-600">{formatCurrency(income)}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium">
                    {expense !== null ? (
                      <span className="text-red-600">{formatCurrency(expense)}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
