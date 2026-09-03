import { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatoPesos } from '../pedidos/helpers';

interface MercadoPagoRaw {
  id: string;
  data: any;
  processed: boolean;
  creado_en: string;
}

export function MercadoPagoDebug() {
  const [datos, setDatos] = useState<MercadoPagoRaw[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filtroProcessed, setFiltroProcessed] = useState<'all' | 'processed' | 'pending'>('pending');

  const cargarDatos = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('mercadopago_raw')
        .select('*')
        .order('creado_en', { ascending: false });

      if (filtroProcessed === 'processed') {
        query = query.eq('processed', true);
      } else if (filtroProcessed === 'pending') {
        query = query.eq('processed', false);
      }

      const { data, error } = await query.limit(50);
      if (error) throw error;
      setDatos(data || []);
    } catch (err) {
      console.error('Error cargando datos:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    cargarDatos();
    const interval = setInterval(cargarDatos, 30000); // Refresh cada 30s
    return () => clearInterval(interval);
  }, [filtroProcessed]);

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-[#2C2419]">Datos Raw de MercadoPago</h2>
        <button
          onClick={cargarDatos}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {(['all', 'pending', 'processed'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFiltroProcessed(f)}
            className={`px-3 py-1 rounded text-sm font-medium transition ${
              filtroProcessed === f
                ? 'bg-blue-500 text-white'
                : 'bg-[#F5EFE0] text-[#6B5D45] hover:bg-[#E4DCC8]'
            }`}
          >
            {f === 'all' ? 'Todos' : f === 'pending' ? 'Pendientes' : 'Procesados'}
          </button>
        ))}
      </div>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {datos.length === 0 ? (
          <p className="text-center text-[#8A7A5C] py-8">No hay datos</p>
        ) : (
          datos.map((item) => (
            <div
              key={item.id}
              className="border border-[#D8CDB0] rounded-lg overflow-hidden"
            >
              <button
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                className="w-full p-3 flex items-center justify-between hover:bg-[#F5EFE0] transition text-left"
              >
                <div className="flex-1">
                  <p className="font-semibold text-[#2C2419]">ID: {item.id}</p>
                  <p className="text-sm text-[#8A7A5C]">
                    ${item.data.transaction_amount || '—'} | {item.data.date_created?.substring(0, 10) || '—'}
                  </p>
                  <p className="text-xs text-[#A8552E] font-medium mt-1">
                    {item.data.status || 'sin_status'} | {item.processed ? '✓ Procesado' : '○ Pendiente'}
                  </p>
                </div>
                {expandedId === item.id ? (
                  <ChevronUp className="w-5 h-5 text-[#8A7A5C]" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-[#8A7A5C]" />
                )}
              </button>

              {expandedId === item.id && (
                <div className="bg-[#F5EFE0] p-3 border-t border-[#D8CDB0] text-xs font-mono overflow-x-auto">
                  <pre className="text-[10px]">{JSON.stringify(item.data, null, 2)}</pre>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <p className="text-xs text-[#8A7A5C] mt-4">
        Total: {datos.length} registros | Actualiza cada 30s
      </p>
    </div>
  );
}
