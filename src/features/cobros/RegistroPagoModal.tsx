import { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useCrearPago } from '../../hooks/usePagos';
import { useMovimientosDisponibles } from '../../hooks/useCaja';
import { getTodayDate } from '../../utils/dateUtils';
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

export function RegistroPagoModal({ cliente, onClose }: RegistroPagoModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [monto, setMonto] = useState('');
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo');
  const [fechaPago, setFechaPago] = useState(getTodayDate());
  const [notas, setNotas] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [movimientoSeleccionado, setMovimientoSeleccionado] = useState<number | null>(null);

  const crearPagoMutation = useCrearPago();
  const movimientosDisponiblesQuery = useMovimientosDisponibles();

  useEffect(() => {
    if (dialogRef.current) {
      dialogRef.current.showModal();
    }
  }, []);

  const handleClose = () => {
    dialogRef.current?.close();
    onClose();
  };

  async function guardarPago(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Si se selecciona un movimiento, usar su monto
    if (movimientoSeleccionado) {
      const movimiento = movimientosDisponiblesQuery.data?.find(m => m.id === movimientoSeleccionado);
      if (!movimiento) {
        setError('Movimiento no encontrado');
        return;
      }

      // Extraer monto bruto de las notas si existe (para MercadoPago)
      let montoAVincular = movimiento.monto;
      if (movimiento.notas && movimiento.notas.includes('Bruto:')) {
        const match = movimiento.notas.match(/Bruto:\s*\$?([\d.]+)/);
        if (match && match[1]) {
          montoAVincular = Number(match[1]);
        }
      }

      if (montoAVincular > cliente.saldo) {
        setError(`El monto (${formatoPesos(montoAVincular)}) supera el saldo (${formatoPesos(cliente.saldo)})`);
        return;
      }

      try {
        await crearPagoMutation.mutateAsync({
          clienteId: cliente.cliente_id,
          monto: montoAVincular,
          metodoPago: metodo,
          fechaPago: movimiento.fecha_operacion,
          notas: notas || undefined,
          movimientoCajaId: movimiento.id,
        });
        handleClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error al guardar pago');
      }
    } else {
      // Flujo normal de ingreso manual
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
        handleClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error al guardar pago');
      }
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="w-full max-w-sm p-6 rounded-lg backdrop:bg-black backdrop:bg-opacity-50 backdrop:backdrop-blur-sm"
      onClose={handleClose}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-amber-900">Registrar pago</h2>
        <button
          onClick={handleClose}
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
          {/* Seleccionar movimiento existente o ingresar manual */}
          {movimientosDisponiblesQuery.data && movimientosDisponiblesQuery.data.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                ¿Vincular movimiento de Caja existente?
              </label>
              <select
                value={movimientoSeleccionado || ''}
                onChange={(e) => setMovimientoSeleccionado(e.target.value ? Number(e.target.value) : null)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600"
              >
                <option value="">— Ingresar monto manual —</option>
                {movimientosDisponiblesQuery.data.map((mov) => {
                  // Extraer bruto si existe
                  let montoMostrar = mov.monto;
                  if (mov.notas && mov.notas.includes('Bruto:')) {
                    const match = mov.notas.match(/Bruto:\s*\$?([\d.]+)/);
                    if (match && match[1]) {
                      montoMostrar = Number(match[1]);
                    }
                  }
                  return (
                    <option key={mov.id} value={mov.id}>
                      {mov.concepto} ({formatoPesos(montoMostrar)}) - {mov.fecha_operacion}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* Monto (solo si no se selecciona movimiento) */}
          {!movimientoSeleccionado && (
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
          )}

          {/* Método de pago (solo si no se selecciona movimiento) */}
          {!movimientoSeleccionado && (
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
          )}

          {/* Fecha de pago (solo si no se selecciona movimiento) */}
          {!movimientoSeleccionado && (
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
          )}

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
              onClick={handleClose}
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
    </dialog>
  );
}
