import { useState } from 'react';
import { Trash2, Check } from 'lucide-react';
import { useLotes, useCrearLote, useActualizarLote } from '../../hooks/useLotes';
import { getTodayDate } from '../../utils/dateUtils';
import type { Lote } from '../../types/domain';

export function LotesAdmin() {
  const { data: lotes = [], isLoading } = useLotes();
  const crearMutation = useCrearLote();
  const actualizarMutation = useActualizarLote();

  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [loteParaMarcarSalida, setLoteParaMarcarSalida] = useState<string | null>(null);
  const [fechaSalida, setFechaSalida] = useState(getTodayDate());
  const [formData, setFormData] = useState({
    galpon: 'Galpón 1',
    fecha_entrada: getTodayDate(),
    aves_iniciales_postura: '',
    linea: '',
    lote_id: '',
    notas: '',
  });

  const handleCrear = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await crearMutation.mutateAsync({
        galpon: formData.galpon,
        fecha_entrada: formData.fecha_entrada,
        aves_iniciales_postura: parseInt(formData.aves_iniciales_postura, 10),
        linea: formData.linea || undefined,
        lote_id: formData.lote_id || undefined,
        notas: formData.notas || undefined,
      });
      setFormData({
        galpon: 'Galpón 1',
        fecha_entrada: getTodayDate(),
        aves_iniciales_postura: '',
        linea: '',
        lote_id: '',
        notas: '',
      });
      setMostrarFormulario(false);
    } catch (err) {
      throw err;
    }
  };

  const handleMarcarSalida = async () => {
    if (!loteParaMarcarSalida) return;
    try {
      await actualizarMutation.mutateAsync({
        id: loteParaMarcarSalida,
        data: {
          fecha_salida: fechaSalida,
          estado: 'Retirado',
        },
      });
      setLoteParaMarcarSalida(null);
      setFechaSalida(new Date().toISOString().split('T')[0]);
    } catch (err) {
      console.error('Error al marcar salida:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Cargando lotes...</p>
      </div>
    );
  }

  const activos = lotes.filter((l) => !l.fecha_salida);
  const retirados = lotes.filter((l) => l.fecha_salida);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-amber-200">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-amber-900">Maestro de Lotes</h2>
            <p className="text-sm text-gray-600 mt-1">Gestiona los lotes de gallinas</p>
          </div>
          <button
            onClick={() => setMostrarFormulario(!mostrarFormulario)}
            className="bg-amber-600 text-white px-4 py-2 rounded-lg hover:bg-amber-700 font-medium"
          >
            {mostrarFormulario ? 'Cancelar' : '+ Nuevo lote'}
          </button>
        </div>
      </div>

      {/* Formulario */}
      {mostrarFormulario && (
        <div className="p-6 border-b border-amber-200 bg-amber-50">
          <form onSubmit={handleCrear} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Galpón
                </label>
                <select
                  value={formData.galpon}
                  onChange={(e) =>
                    setFormData({ ...formData, galpon: e.target.value })
                  }
                  className="w-full border border-amber-300 rounded px-3 py-2"
                >
                  <option>Galpón 1</option>
                  <option>Galpón 2</option>
                  <option>Galpón 3</option>
                  <option>Galpón 4</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Fecha entrada
                </label>
                <input
                  type="date"
                  value={formData.fecha_entrada}
                  onChange={(e) =>
                    setFormData({ ...formData, fecha_entrada: e.target.value })
                  }
                  className="w-full border border-amber-300 rounded px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Aves iniciales (postura)
                </label>
                <input
                  type="number"
                  value={formData.aves_iniciales_postura}
                  onChange={(e) =>
                    setFormData({ ...formData, aves_iniciales_postura: e.target.value })
                  }
                  placeholder="1000"
                  className="w-full border border-amber-300 rounded px-3 py-2"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Línea
                </label>
                <input
                  type="text"
                  value={formData.linea}
                  onChange={(e) =>
                    setFormData({ ...formData, linea: e.target.value })
                  }
                  placeholder="HY-Line Brown"
                  className="w-full border border-amber-300 rounded px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  ID Lote
                </label>
                <input
                  type="text"
                  value={formData.lote_id}
                  onChange={(e) =>
                    setFormData({ ...formData, lote_id: e.target.value })
                  }
                  placeholder="G01-2501"
                  className="w-full border border-amber-300 rounded px-3 py-2"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notas
              </label>
              <textarea
                value={formData.notas}
                onChange={(e) =>
                  setFormData({ ...formData, notas: e.target.value })
                }
                placeholder="Observaciones adicionales"
                className="w-full border border-amber-300 rounded px-3 py-2 text-sm"
                rows={2}
              />
            </div>

            <button
              type="submit"
              disabled={crearMutation.isPending}
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:bg-gray-400 font-medium"
            >
              {crearMutation.isPending ? 'Guardando...' : 'Guardar lote'}
            </button>
          </form>
        </div>
      )}

      {/* Contenido */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Lotes activos */}
        <div>
          <h3 className="text-lg font-bold text-amber-900 mb-3">
            Lotes activos ({activos.length})
          </h3>
          {activos.length === 0 ? (
            <p className="text-gray-500 text-sm">No hay lotes activos</p>
          ) : (
            <div className="space-y-3">
              {activos.map((lote) => (
                <div
                  key={lote.id}
                  className="bg-white border border-amber-200 rounded-lg p-4"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-bold text-amber-900">
                          {lote.galpon} — {lote.lote_id || 'Sin ID'}
                        </h4>
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                          Activo
                        </span>
                      </div>
                      <p className="text-sm text-gray-600">
                        Entrada: {new Date(lote.fecha_entrada).toLocaleDateString('es-AR')} •{' '}
                        {lote.aves_iniciales_postura} aves
                      </p>
                      {lote.linea && (
                        <p className="text-sm text-gray-600">Línea: {lote.linea}</p>
                      )}
                      {lote.notas && (
                        <p className="text-sm text-gray-500 mt-1">📝 {lote.notas}</p>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setLoteParaMarcarSalida(lote.id);
                        setFechaSalida(new Date().toISOString().split('T')[0]);
                      }}
                      disabled={actualizarMutation.isPending}
                      className="bg-red-100 text-red-600 hover:bg-red-200 px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1"
                    >
                      <Check className="w-4 h-4" />
                      Marcar salida
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Lotes retirados */}
        {retirados.length > 0 && (
          <div>
            <h3 className="text-lg font-bold text-gray-700 mb-3">
              Lotes retirados ({retirados.length})
            </h3>
            <div className="space-y-2">
              {retirados.map((lote) => (
                <div
                  key={lote.id}
                  className="bg-gray-50 border border-gray-200 rounded-lg p-3 opacity-75"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-700">
                        {lote.galpon} — {lote.lote_id || 'Sin ID'}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {new Date(lote.fecha_entrada).toLocaleDateString('es-AR')} a{' '}
                        {lote.fecha_salida
                          ? new Date(lote.fecha_salida).toLocaleDateString('es-AR')
                          : '-'}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Modal para elegir fecha de salida */}
      {loteParaMarcarSalida && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-sm w-full p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">
              Marcar salida del lote
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Fecha de salida
                </label>
                <input
                  type="date"
                  value={fechaSalida}
                  onChange={(e) => setFechaSalida(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setLoteParaMarcarSalida(null)}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleMarcarSalida}
                  disabled={actualizarMutation.isPending}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:bg-gray-400 font-medium"
                >
                  {actualizarMutation.isPending ? 'Guardando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
