import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useCrearMovimientoCaja } from '../../hooks/useCaja';
import type { MovimientoTipo, FormaPago } from '../../types/domain';

interface FormMovimientoProps {
  onGuardar: () => void;
  onCancelar: () => void;
}

function getTodayDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function FormMovimiento({ onGuardar, onCancelar }: FormMovimientoProps) {
  const crearMutation = useCrearMovimientoCaja();
  const [error, setError] = useState<string | null>(null);

  const [tipo, setTipo] = useState<MovimientoTipo>('ingreso');
  const [concepto, setConcepto] = useState('');
  const [monto, setMonto] = useState('');
  const [formaPago, setFormaPago] = useState<FormaPago>('efectivo');
  const [fechaOperacion, setFechaOperacion] = useState(getTodayDate());
  const [fechaPago, setFechaPago] = useState(getTodayDate());
  const [notas, setNotas] = useState('');

  async function handleGuardar() {
    setError(null);

    if (!concepto.trim()) {
      setError('El concepto es requerido');
      return;
    }

    const montoNum = parseFloat(monto);
    if (!monto || isNaN(montoNum) || montoNum <= 0) {
      setError('El monto debe ser mayor a 0');
      return;
    }

    try {
      await crearMutation.mutateAsync({
        tipo,
        concepto: concepto.trim(),
        monto: montoNum,
        forma_pago: formaPago,
        fecha_operacion: fechaOperacion,
        fecha_pago: fechaPago,
        estado: 'confirmado',
        notas: notas.trim() || undefined,
      });
      onGuardar();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    }
  }

  return (
    <div className="flex-1 flex flex-col">
      <header className="px-5 pt-6 pb-4 border-b border-[#E4DCC8] flex items-center gap-3">
        <button
          onClick={onCancelar}
          className="w-9 h-9 flex items-center justify-center rounded-full bg-[#A8552E] text-white active:scale-95 transition-transform"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold text-[#2C2419]">Nuevo movimiento</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-20">
        {error && (
          <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-3 py-2 rounded-lg mb-4">
            {error}
          </div>
        )}

        {/* Tipo */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-2">
            Tipo
          </label>
          <div className="flex gap-3">
            <button
              onClick={() => setTipo('ingreso')}
              className={`flex-1 py-2.5 rounded-lg font-semibold transition-colors ${
                tipo === 'ingreso'
                  ? 'bg-green-600 text-white'
                  : 'bg-green-100 text-green-700'
              }`}
            >
              Ingreso
            </button>
            <button
              onClick={() => setTipo('egreso')}
              className={`flex-1 py-2.5 rounded-lg font-semibold transition-colors ${
                tipo === 'egreso'
                  ? 'bg-red-600 text-white'
                  : 'bg-red-100 text-red-700'
              }`}
            >
              Egreso
            </button>
          </div>
        </div>

        {/* Concepto */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Concepto
          </label>
          <input
            type="text"
            placeholder="Ej: Venta de huevos, Pago de sueldo"
            value={concepto}
            onChange={(e) => setConcepto(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          />
        </div>

        {/* Monto */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Monto
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[#8A7A5C]">$</span>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className="flex-1 border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            />
          </div>
        </div>

        {/* Forma de pago */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Forma de pago
          </label>
          <select
            value={formaPago}
            onChange={(e) => setFormaPago(e.target.value as FormaPago)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          >
            <option value="efectivo">Efectivo</option>
            <option value="mercadopago">MercadoPago</option>
            <option value="cheque">Cheque</option>
            <option value="echeq">Echeq</option>
          </select>
        </div>

        {/* Fechas */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Fecha de operación
          </label>
          <input
            type="date"
            value={fechaOperacion}
            onChange={(e) => setFechaOperacion(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Fecha de pago
          </label>
          <input
            type="date"
            value={fechaPago}
            onChange={(e) => setFechaPago(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          />
        </div>

        {/* Notas */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Notas (opcional)
          </label>
          <textarea
            placeholder="Detalles adicionales"
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] resize-none"
            rows={2}
          />
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-5 bg-[#FAF6EE] border-t border-[#E4DCC8]">
        <button
          onClick={handleGuardar}
          disabled={crearMutation.isPending || !concepto.trim() || !monto}
          className="w-full bg-[#A8552E] disabled:bg-[#D8CDB0] disabled:text-[#A89878] text-white font-semibold py-3.5 rounded-lg active:scale-95 transition-transform"
        >
          {crearMutation.isPending ? 'Guardando...' : 'Guardar movimiento'}
        </button>
      </div>
    </div>
  );
}
