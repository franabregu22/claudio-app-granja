import { CheckCircle2, AlertCircle } from 'lucide-react';
import { useArqueos } from '../../hooks/useArqueos';
import { formatoPesos } from '../pedidos/helpers';
import type { CuentaCaja } from '../../types/domain';

interface HistorialArqueosProps {
  cuenta: CuentaCaja;
}

export function HistorialArqueos({ cuenta }: HistorialArqueosProps) {
  const arqueos = useArqueos(cuenta.id);

  if (arqueos.isLoading) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">Cargando historial...</p>
      </div>
    );
  }

  if (!arqueos.data || arqueos.data.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">Sin arqueos registrados</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-amber-50 border-b border-[#D8CDB0]">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Fecha</th>
            <th className="px-3 py-2 text-right font-semibold text-[#2C2419]">Físico</th>
            <th className="px-3 py-2 text-right font-semibold text-[#2C2419]">Sistema</th>
            <th className="px-3 py-2 text-right font-semibold text-[#2C2419]">Diferencia</th>
            <th className="px-3 py-2 text-center font-semibold text-[#2C2419]">Estado</th>
            <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Notas</th>
          </tr>
        </thead>
        <tbody>
          {arqueos.data.map((a) => (
            <tr key={a.id} className="border-b border-[#E4DCC8] hover:bg-amber-50 transition-colors">
              <td className="px-3 py-2 text-[#2C2419] font-medium">
                {new Date(a.fecha_arqueo).toLocaleDateString('es-AR')}
              </td>
              <td className="px-3 py-2 text-right text-[#2C2419]">
                {formatoPesos(a.monto_fisico)}
              </td>
              <td className="px-3 py-2 text-right text-[#8A7A5C]">
                {formatoPesos(a.monto_registrado)}
              </td>
              <td className={`px-3 py-2 text-right font-bold ${
                a.diferencia === 0 ? 'text-green-700' :
                a.diferencia < 0 ? 'text-red-700' : 'text-yellow-700'
              }`}>
                {a.diferencia > 0 ? '+' : ''}{formatoPesos(a.diferencia)}
              </td>
              <td className="px-3 py-2 text-center">
                {a.diferencia === 0 ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600 inline" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-600 inline" />
                )}
              </td>
              <td className="px-3 py-2 text-[#8A7A5C] text-xs">
                {a.notas ? <span className="italic">{a.notas}</span> : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
