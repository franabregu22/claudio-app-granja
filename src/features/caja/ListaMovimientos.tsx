import type { MovimientoCaja } from '../../types/domain';
import { formatoPesos } from '../pedidos/helpers';

interface ListaMovimientosProps {
  movimientos: MovimientoCaja[];
}

export function ListaMovimientos({ movimientos }: ListaMovimientosProps) {
  if (movimientos.length === 0) {
    return (
      <div className="border border-dashed border-[#D8CDB0] rounded-lg p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">No hay movimientos registrados</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {movimientos.map((m) => (
        <div
          key={m.id}
          className="bg-white border border-[#E4DCC8] rounded-lg p-4 flex items-center justify-between"
        >
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="font-semibold text-[#2C2419]">{m.concepto}</p>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                m.tipo === 'ingreso'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-red-100 text-red-700'
              }`}>
                {m.tipo}
              </span>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                m.forma_pago === 'efectivo' ? 'bg-yellow-100 text-yellow-700' :
                m.forma_pago === 'mercadopago' ? 'bg-blue-100 text-blue-700' :
                m.forma_pago === 'cheque' ? 'bg-purple-100 text-purple-700' :
                'bg-gray-100 text-gray-700'
              }`}>
                {m.forma_pago}
              </span>
            </div>
            {m.notas && (
              <p className="text-xs text-[#8A7A5C] mt-1">{m.notas}</p>
            )}
            {m.estado !== 'confirmado' && (
              <p className="text-xs text-[#A89878] mt-1">Estado: {m.estado}</p>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className={`text-lg font-bold ${
              m.tipo === 'ingreso' ? 'text-green-700' : 'text-red-700'
            }`}>
              {m.tipo === 'ingreso' ? '+' : '-'}{formatoPesos(m.monto)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
