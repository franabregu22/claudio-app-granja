import { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useActualizarMovimientoCaja } from '../../hooks/useCaja';
import { useAuth } from '../../auth/useAuth';
import type { MovimientoCaja } from '../../types/domain';
import { formatoPesos } from '../pedidos/helpers';

interface ModalEditarMovimientoProps {
  movimiento: MovimientoCaja;
  onClose: () => void;
  onGuardar: () => void;
}

export function ModalEditarMovimiento({ movimiento, onClose, onGuardar }: ModalEditarMovimientoProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { user } = useAuth();
  const actualizarMutation = useActualizarMovimientoCaja();

  const [monto, setMonto] = useState(movimiento.monto.toString());
  const [impuestoCheque, setImpuestoCheque] = useState((movimiento.impuesto_cheque || 0).toString());
  const [concepto, setConcepto] = useState(movimiento.concepto || '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const handleClose = () => {
    dialogRef.current?.close();
    onClose();
  };

  const handleGuardar = async () => {
    setError(null);
    setLoading(true);

    try {
      const montoNum = parseFloat(monto);
      const impuestoNum = parseFloat(impuestoCheque);

      if (!monto || isNaN(montoNum) || montoNum <= 0) {
        setError('El monto debe ser mayor a 0');
        return;
      }

      if (isNaN(impuestoNum) || impuestoNum < 0) {
        setError('El impuesto no puede ser negativo');
        return;
      }

      await actualizarMutation.mutateAsync({
        id: movimiento.id,
        movimiento: {
          monto: montoNum,
          impuesto_cheque: impuestoNum,
          concepto: concepto.trim(),
          actualizado_por: user?.id,
        },
      });

      onGuardar();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="rounded-lg shadow-xl backdrop:bg-black/50 w-full max-w-md"
      onClose={handleClose}
    >
      <div className="bg-[#FAF6EE] p-6 rounded-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-[#2C2419]">Editar Movimiento</h2>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-[#E4DCC8] rounded transition"
          >
            <X className="w-5 h-5 text-[#6B5D45]" />
          </button>
        </div>

        {error && (
          <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-3 py-2 rounded-lg mb-4">
            {error}
          </div>
        )}

        <div className="space-y-4">
          {/* Concepto */}
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase mb-1">
              Concepto
            </label>
            <input
              type="text"
              value={concepto}
              onChange={(e) => setConcepto(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded px-3 py-2 bg-white text-[#2C2419]"
            />
          </div>

          {/* Monto */}
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase mb-1">
              Monto
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[#8A7A5C]">$</span>
              <input
                type="number"
                inputMode="decimal"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                className="flex-1 border border-[#D8CDB0] rounded px-3 py-2 bg-white text-[#2C2419]"
              />
            </div>
          </div>

          {/* Impuesto Cheque */}
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase mb-1">
              Impuesto Cheque/Débito 0.6%
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[#8A7A5C]">$</span>
              <input
                type="number"
                inputMode="decimal"
                value={impuestoCheque}
                onChange={(e) => setImpuestoCheque(e.target.value)}
                className="flex-1 border border-[#D8CDB0] rounded px-3 py-2 bg-white text-[#2C2419]"
              />
            </div>
            {parseFloat(monto) > 0 && parseFloat(impuestoCheque) > 0 && (
              <p className="text-xs text-[#8A7A5C] mt-1">
                Monto total: {formatoPesos(parseFloat(monto))}
              </p>
            )}
          </div>

          {/* Info original */}
          <div className="text-xs text-[#8A7A5C] bg-[#F5EFE0] p-3 rounded">
            <p><span className="font-semibold">Fecha:</span> {movimiento.fecha_operacion}</p>
            <p><span className="font-semibold">Tipo:</span> {movimiento.tipo}</p>
            <p><span className="font-semibold">Estado:</span> {movimiento.movimiento_estado}</p>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2 border border-[#D8CDB0] text-[#6B5D45] rounded-lg hover:bg-[#F5EFE0] transition"
          >
            Cancelar
          </button>
          <button
            onClick={handleGuardar}
            disabled={loading}
            className="flex-1 px-4 py-2 bg-[#A8552E] text-white rounded-lg hover:bg-[#8B4423] transition disabled:opacity-50"
          >
            {loading ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
