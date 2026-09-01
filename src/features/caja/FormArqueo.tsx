import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useCrearArqueo } from '../../hooks/useArqueos';
import { formatoPesos } from '../pedidos/helpers';
import { getTodayDate } from '../../utils/dateUtils';
import * as api from '../../api/arqueos';
import type { CuentaCaja } from '../../types/domain';

interface FormArqueoProps {
  cuenta: CuentaCaja;
  onClose: () => void;
  onGuardar: () => void;
}

export function FormArqueo({ cuenta, onClose, onGuardar }: FormArqueoProps) {
  const crearMutation = useCrearArqueo();
  const [error, setError] = useState<string | null>(null);
  const [montoFisico, setMontoFisico] = useState('');
  const [notas, setNotas] = useState('');
  const [fechaArqueo] = useState(getTodayDate());
  const [montoRegistrado, setMontoRegistrado] = useState<number | null>(null);
  const [calculando, setCalculando] = useState(false);

  // Calcular monto registrado en el sistema
  useEffect(() => {
    const calcular = async () => {
      try {
        setCalculando(true);
        const saldo = await api.calcularSaldoEfectivoRegistrado(fechaArqueo);
        setMontoRegistrado(saldo);
      } catch (err) {
        setError('Error al calcular saldo');
      } finally {
        setCalculando(false);
      }
    };

    calcular();
  }, [fechaArqueo]);

  const montoNum = parseFloat(montoFisico) || 0;
  const diferencia = montoRegistrado !== null ? montoNum - montoRegistrado : 0;

  async function handleGuardar() {
    setError(null);

    if (!montoFisico || isNaN(montoNum) || montoNum < 0) {
      setError('Ingresá un monto válido');
      return;
    }

    try {
      await crearMutation.mutateAsync({
        cuentaId: cuenta.id,
        fechaArqueo,
        montoFisico: montoNum,
        notas: notas.trim() || undefined,
      });
      onGuardar();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-sm w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-[#2C2419]">Arqueo de {cuenta.nombre}</h2>
          <button
            onClick={onClose}
            className="text-[#8A7A5C] hover:text-[#2C2419]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg mb-4">
            {error}
          </div>
        )}

        <div className="space-y-4">
          {/* Fecha */}
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase mb-1.5">
              Fecha
            </label>
            <input
              type="date"
              value={fechaArqueo}
              disabled
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-gray-50 text-[#2C2419]"
            />
          </div>

          {/* Monto Registrado */}
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase mb-1.5">
              Saldo Sistema
            </label>
            {calculando ? (
              <div className="bg-gray-50 border border-[#D8CDB0] rounded-lg px-3 py-2.5 text-[#8A7A5C]">
                Calculando...
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5">
                <p className="font-bold text-blue-700">
                  {montoRegistrado !== null ? formatoPesos(montoRegistrado) : '—'}
                </p>
                <p className="text-xs text-blue-600 mt-1">
                  Lo que el sistema dice que deberías tener
                </p>
              </div>
            )}
          </div>

          {/* Monto Físico */}
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase mb-1.5">
              ¿Cuánto efectivo contás?
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[#8A7A5C]">$</span>
              <input
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={montoFisico}
                onChange={(e) => setMontoFisico(e.target.value)}
                className="flex-1 border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
              />
            </div>
          </div>

          {/* Diferencia */}
          {montoRegistrado !== null && montoFisico && (
            <div className={`rounded-lg p-3 ${
              diferencia === 0 ? 'bg-green-50 border border-green-200' :
              diferencia < 0 ? 'bg-red-50 border border-red-200' :
              'bg-yellow-50 border border-yellow-200'
            }`}>
              <p className="text-xs text-[#8A7A5C] mb-1">Diferencia:</p>
              <p className={`font-bold text-lg ${
                diferencia === 0 ? 'text-green-700' :
                diferencia < 0 ? 'text-red-700' : 'text-yellow-700'
              }`}>
                {diferencia === 0 ? '✓ Cuadra' : (diferencia > 0 ? '+' : '')} {formatoPesos(diferencia)}
              </p>
            </div>
          )}

          {/* Notas */}
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase mb-1.5">
              Notas (opcional)
            </label>
            <textarea
              placeholder="Ej: Faltante por revisar, debo contar de nuevo, etc."
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] resize-none text-sm"
              rows={2}
            />
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-[#D8CDB0] rounded-lg text-[#2C2419] font-medium hover:bg-[#F5EFE6]"
          >
            Cancelar
          </button>
          <button
            onClick={handleGuardar}
            disabled={crearMutation.isPending || !montoFisico}
            className="flex-1 px-4 py-2 bg-[#A8552E] text-white rounded-lg font-medium hover:bg-[#8B4423] disabled:opacity-50 transition-colors"
          >
            {crearMutation.isPending ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
