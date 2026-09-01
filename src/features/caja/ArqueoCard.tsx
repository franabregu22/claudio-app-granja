import { CheckCircle2, AlertCircle, Plus } from 'lucide-react';
import { useUltimoArqueo } from '../../hooks/useArqueos';
import { formatoPesos } from '../pedidos/helpers';
import type { CuentaCaja } from '../../types/domain';

interface ArqueoCardProps {
  cuenta: CuentaCaja;
  onArquear: () => void;
}

export function ArqueoCard({ cuenta, onArquear }: ArqueoCardProps) {
  const ultimoArqueo = useUltimoArqueo(cuenta.id);
  const ultimo = ultimoArqueo.data;

  const getStatusColor = (diferencia: number): string => {
    if (diferencia === 0) return 'bg-green-50 border-green-200';
    if (diferencia < 0) return 'bg-red-50 border-red-200';
    return 'bg-yellow-50 border-yellow-200';
  };

  const getStatusIcon = (diferencia: number) => {
    if (diferencia === 0) return <CheckCircle2 className="w-5 h-5 text-green-600" />;
    return <AlertCircle className="w-5 h-5 text-red-600" />;
  };

  const getStatusLabel = (diferencia: number): string => {
    if (diferencia === 0) return 'Cuadra ✓';
    if (diferencia < 0) return `Faltante: ${formatoPesos(Math.abs(diferencia))}`;
    return `Sobrante: ${formatoPesos(diferencia)}`;
  };

  return (
    <div className={`border rounded-lg p-4 ${getStatusColor(ultimo?.diferencia || 0)}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <h3 className="font-bold text-[#2C2419] text-sm">{cuenta.nombre}</h3>
            <p className="text-xs text-[#8A7A5C]">{cuenta.descripcion || cuenta.tipo}</p>
          </div>
        </div>
        {ultimo && getStatusIcon(ultimo.diferencia)}
      </div>

      {ultimo ? (
        <div className="mb-3 text-sm">
          <p className="text-xs text-[#8A7A5C] mb-1">
            Último arqueo: {new Date(ultimo.fecha_arqueo).toLocaleDateString('es-AR')}
          </p>
          <p className={`font-bold text-sm ${
            ultimo.diferencia === 0 ? 'text-green-700' :
            ultimo.diferencia < 0 ? 'text-red-700' : 'text-yellow-700'
          }`}>
            {getStatusLabel(ultimo.diferencia)}
          </p>
          {ultimo.notas && (
            <p className="text-xs text-[#6B5D45] mt-1 italic">"{ultimo.notas}"</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-[#8A7A5C] mb-3">Sin arqueos registrados</p>
      )}

      {cuenta.tipo === 'efectivo' && (
        <button
          onClick={onArquear}
          className="w-full flex items-center justify-center gap-2 bg-[#A8552E] hover:bg-[#8B4423] text-white text-sm font-semibold py-2 rounded transition-colors"
        >
          <Plus className="w-4 h-4" /> Arquear ahora
        </button>
      )}
    </div>
  );
}
