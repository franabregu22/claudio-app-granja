import { useState } from 'react';
import { X } from 'lucide-react';
import { useCrearPago } from '../../hooks/usePagos';
import type { ClienteSaldo, MetodoPago } from '../../types/domain';
import { formatoPesos } from '../pedidos/helpers';

interface RegistroPagoModalProps {
  cliente: ClienteSaldo;
  onClose: () => void;
}

const METODOS_PAGO: Array<{ id: MetodoPago; label: string }> = [
  { id: 'efectivo', label: 'Efectivo' },
  { id: 'transferencia', label: 'Transferencia' },
  { id: 'tarjeta', label: 'Tarjeta' },
  { id: 'mercadopago', label: 'MercadoPago' },
  { id: 'otro', label: 'Otro' },
];

function getTodayDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function RegistroPagoModal({ cliente, onClose }: RegistroPagoModalProps) {
  const [monto, setMonto] = useState('');
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo');
  const [fechaPago, setFechaPago] = useState(getTodayDate());
  const [notas, setNotas] = useState('');
  const [error, setError] = useState<string | null>(null);

  const crearPagoMutation = useCrearPago();

  async function guardarPago(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const montoNum = Number(monto);
    if (!montoNum || montoNum <= 0) {
      setError('Ingresa un monto válido');
      return;
    }

    if (montoNum > cliente.saldo) {
      setError(`El monto supera el saldo (${formatoPesos(cliente.saldo)})`);
      return;
    }

    try {
      await crearPagoMutation.mutateAsync({
        clienteId: cliente.cliente_id,
        monto: montoNum,
        metodoPago: metodo,
        fechaPago,
        notas: notas || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar pago');
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-sm w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-amber-900">Registrar pago</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={24} />
          </button>
        </div>

        <div className="bg-stone-50 p-3 rounded-lg text-sm mb-4">
          <div className="text-gray-600">
            Saldo pendiente:{' '}
            <span className="font-bold text-lg text-red-600">{formatoPesos(cliente.saldo)}</span>
          </div>
        </div>

        <form onSubmit={guardarPago} className="space-y-4">
          {/* Monto */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Monto a registrar
            </label>
            <input
              type="number"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              placeholder="0"
              step="1"
              min="0"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          {/* Método de pago */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Método de pago
            </label>
            <div className="grid grid-cols-2 gap-2">
              {METODOS_PAGO.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMetodo(m.id)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition ${
                    metodo === m.id
                      ? 'bg-amber-600 text-white'
                      : 'bg-stone-100 text-gray-700 hover:bg-stone-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Fecha de pago */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Fecha del pago
            </label>
            <input
              type="date"
              value={fechaPago}
              onChange={(e) => setFechaPago(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
          </div>

          {/* Notas */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notas (opcional)
            </label>
            <textarea
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Ej: Pagó la mitad, vuelve mañana"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600 resize-none"
              rows={2}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          {/* Botones */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={crearPagoMutation.isPending}
              className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {crearPagoMutation.isPending ? 'Guardando...' : 'Guardar pago'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
