import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

interface UnclassifiedMovement {
  id: number;
  transaction_date: string;
  settlement_amount: number;
  payer_name: string | null;
  payment_method: string | null;
  tax_amount: number | null;
  external_reference: string | null;
}

type MovementClass = 'payment_in' | 'payment_out' | 'yield' | 'transfer_in' | 'transfer_out';

const MOVEMENT_OPTIONS: { value: MovementClass; label: string; color: string }[] = [
  { value: 'payment_in', label: 'Pago Entrante', color: 'text-green-700' },
  { value: 'payment_out', label: 'Pago Saliente', color: 'text-red-700' },
  { value: 'yield', label: 'Rendimiento', color: 'text-yellow-700' },
  { value: 'transfer_in', label: 'Transferencia Entrante', color: 'text-blue-700' },
  { value: 'transfer_out', label: 'Transferencia Saliente', color: 'text-purple-700' },
];

export function UnclassifiedMovements() {
  const [movements, setMovements] = useState<UnclassifiedMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Set<number>>(new Set());

  const ACCOUNT_ID = 1054315166;

  useEffect(() => {
    const fetchUnclassified = async () => {
      try {
        setLoading(true);
        const { data, error: err } = await supabase
          .from('mp_financial_movement')
          .select(
            'id,transaction_date,settlement_amount,payer_name,payment_method,tax_amount,external_reference'
          )
          .eq('account_id', ACCOUNT_ID)
          .eq('movement_class', 'unclassified')
          .order('transaction_date', { ascending: false });

        if (err) throw err;
        setMovements(data || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando movimientos');
        setMovements([]);
      } finally {
        setLoading(false);
      }
    };

    fetchUnclassified();
  }, []);

  const handleClassify = async (id: number, newClass: MovementClass) => {
    try {
      setUpdating(prev => new Set([...prev, id]));

      const { error: err } = await supabase
        .from('mp_financial_movement')
        .update({ movement_class: newClass })
        .eq('id', id);

      if (err) throw err;

      setMovements(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error actualizando movimiento');
    } finally {
      setUpdating(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
    }).format(amount);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('es-AR');
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-6">
        <p className="text-sm text-gray-600">Cargando movimientos sin clasificar...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 rounded-lg border border-red-200 p-4 text-red-800">
        {error}
      </div>
    );
  }

  if (movements.length === 0) {
    return (
      <div className="bg-green-50 rounded-lg border border-green-200 p-4 text-green-800">
        ✅ Todos los movimientos están clasificados
      </div>
    );
  }

  return (
    <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-yellow-900">
          ⚠️ {movements.length} movimiento(s) sin clasificar
        </h3>
        <p className="text-xs text-yellow-800 mt-1">
          Elegí la clasificación correcta para cada uno
        </p>
      </div>

      <div className="space-y-3">
        {movements.map(mov => (
          <div key={mov.id} className="bg-white rounded border border-yellow-200 p-4">
            <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
              <div>
                <p className="text-xs text-gray-600 uppercase">Fecha</p>
                <p className="font-semibold text-[#2C2419]">{formatDate(mov.transaction_date)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600 uppercase">Monto</p>
                <p className={`font-semibold ${mov.settlement_amount >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {formatCurrency(mov.settlement_amount)}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-gray-600 uppercase">Pagador</p>
                <p className="text-sm text-gray-800">{mov.payer_name || '(Sin información)'}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-gray-600 uppercase">Método de pago</p>
                <p className="text-sm text-gray-800">{mov.payment_method || '(No especificado)'}</p>
              </div>
              {mov.external_reference && (
                <div className="col-span-2">
                  <p className="text-xs text-gray-600 uppercase">Referencia</p>
                  <p className="text-xs font-mono text-gray-700">{mov.external_reference}</p>
                </div>
              )}
            </div>

            <div className="border-t border-yellow-100 pt-3">
              <p className="text-xs text-gray-600 uppercase mb-2">Clasificar como:</p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {MOVEMENT_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    disabled={updating.has(mov.id)}
                    onClick={() => handleClassify(mov.id, opt.value)}
                    className={`px-3 py-2 rounded text-xs font-medium transition ${
                      updating.has(mov.id)
                        ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                        : `bg-white border border-[#E4DCC8] text-[#2C2419] hover:bg-[#FDFAF3] active:bg-yellow-100`
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
