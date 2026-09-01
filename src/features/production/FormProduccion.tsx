import { useState, useEffect } from 'react';
import { getTodayDate } from '../../utils/dateUtils';
import type { Produccion } from '../../types/domain';

interface FormProduccionProps {
  galpones: string[];
  onGuardar: (data: any) => void;
  isLoading: boolean;
  produccionEnEdicion: Produccion | null;
  onCancelar: () => void;
}

export function FormProduccion({
  galpones,
  onGuardar,
  isLoading,
  produccionEnEdicion,
  onCancelar,
}: FormProduccionProps) {
  const [fecha, setFecha] = useState(getTodayDate());
  const [galpon, setGalpon] = useState(galpones[0]);
  const [huevosSanosMediodia, setHuevosSanosMediodia] = useState(0);
  const [huevosCachadosMediodia, setHuevosCachadosMediodia] = useState(0);
  const [huevosSanosTarde, setHuevosSanosTarde] = useState(0);
  const [huevosCachadosTarde, setHuevosCachadosTarde] = useState(0);
  const [mortandad, setMortandad] = useState(0);
  const [observaciones, setObservaciones] = useState('');

  useEffect(() => {
    if (produccionEnEdicion) {
      setFecha(produccionEnEdicion.fecha);
      setGalpon(produccionEnEdicion.galpon);
      setHuevosSanosMediodia(produccionEnEdicion.huevos_totales_mediodia);
      setHuevosCachadosMediodia(produccionEnEdicion.huevos_cachados_mediodia);
      setHuevosSanosTarde(produccionEnEdicion.huevos_totales_tarde);
      setHuevosCachadosTarde(produccionEnEdicion.huevos_cachados_tarde);
      setMortandad(produccionEnEdicion.mortandad);
      setObservaciones(produccionEnEdicion.observaciones || '');
    }
  }, [produccionEnEdicion]);

  const huevosTotalesToardeMedio = huevosSanosMediodia + huevosSanosTarde;
  const huevosCachadosTotal = huevosCachadosMediodia + huevosCachadosTarde;
  const huevosSanosTotal = huevosTotalesToardeMedio - huevosCachadosTotal;
  const huevosGrandTotal = huevosTotalesToardeMedio;

  const handleGuardar = () => {
    onGuardar({
      id: produccionEnEdicion?.id,
      fecha,
      galpon,
      huevos_totales_mediodia: huevosSanosMediodia,
      huevos_cachados_mediodia: huevosCachadosMediodia,
      huevos_totales_tarde: huevosSanosTarde,
      huevos_cachados_tarde: huevosCachadosTarde,
      mortandad,
      observaciones,
    });
  };

  return (
    <div className="bg-white p-6 rounded-lg border border-amber-200">
      <h2 className="text-lg font-semibold text-amber-900 mb-4">
        {produccionEnEdicion ? 'Editar registro de postura' : 'Registrar postura'}
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Fecha</label>
          <input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            disabled={!!produccionEnEdicion}
            className="w-full border border-gray-300 rounded px-3 py-2 disabled:bg-gray-100"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Galpón</label>
          <select
            value={galpon}
            onChange={(e) => setGalpon(e.target.value)}
            disabled={!!produccionEnEdicion}
            className="w-full border border-gray-300 rounded px-3 py-2 disabled:bg-gray-100"
          >
            {galpones.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Carga mediodía */}
      <div className="mb-6 p-4 bg-amber-50 rounded-lg border border-amber-100">
        <h3 className="font-semibold text-amber-900 mb-1">Carga mediodía</h3>
        <p className="text-xs text-amber-700 mb-3">Los huevos totales = huevos sanos + huevos cachados</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Huevos totales</label>
            <input
              type="number"
              min="0"
              value={huevosSanosMediodia === 0 ? '' : huevosSanosMediodia}
              onChange={(e) => setHuevosSanosMediodia(e.target.value === '' ? 0 : Number(e.target.value))}
              onFocus={(e) => e.target.select()}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Huevos cachados</label>
            <input
              type="number"
              min="0"
              value={huevosCachadosMediodia === 0 ? '' : huevosCachadosMediodia}
              onChange={(e) => setHuevosCachadosMediodia(e.target.value === '' ? 0 : Number(e.target.value))}
              onFocus={(e) => e.target.select()}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>
        </div>
      </div>

      {/* Carga tarde */}
      <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-100">
        <h3 className="font-semibold text-blue-900 mb-1">Carga tarde</h3>
        <p className="text-xs text-blue-700 mb-3">Estos valores son independientes de la carga del mediodía. No sumar con mediodía.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Huevos totales</label>
            <input
              type="number"
              min="0"
              value={huevosSanosTarde === 0 ? '' : huevosSanosTarde}
              onChange={(e) => setHuevosSanosTarde(e.target.value === '' ? 0 : Number(e.target.value))}
              onFocus={(e) => e.target.select()}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Huevos cachados</label>
            <input
              type="number"
              min="0"
              value={huevosCachadosTarde === 0 ? '' : huevosCachadosTarde}
              onChange={(e) => setHuevosCachadosTarde(e.target.value === '' ? 0 : Number(e.target.value))}
              onFocus={(e) => e.target.select()}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>
        </div>
      </div>

      {/* Totales */}
      <div className="mb-6 p-4 bg-green-50 rounded-lg border border-green-200">
        <h3 className="font-semibold text-green-900 mb-3">Totales del día</h3>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-gray-600">Sanos</p>
            <p className="text-2xl font-bold text-green-700">{huevosSanosTotal}</p>
          </div>
          <div>
            <p className="text-gray-600">Cachados</p>
            <p className="text-2xl font-bold text-orange-700">{huevosCachadosTotal}</p>
          </div>
          <div>
            <p className="text-gray-600">Gran total</p>
            <p className="text-2xl font-bold text-gray-900">{huevosGrandTotal}</p>
          </div>
        </div>
      </div>

      {/* Otros campos */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Mortandad</label>
          <input
            type="number"
            min="0"
            value={mortandad === 0 ? '' : mortandad}
            onChange={(e) => setMortandad(e.target.value === '' ? 0 : Number(e.target.value))}
            onFocus={(e) => e.target.select()}
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Observaciones</label>
          <input
            type="text"
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            placeholder="Notas opcionales"
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
        </div>
      </div>

      {/* Botones */}
      <div className="flex gap-2">
        <button
          onClick={handleGuardar}
          disabled={isLoading}
          className="flex-1 bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium disabled:opacity-50"
        >
          {isLoading ? 'Guardando...' : produccionEnEdicion ? 'Actualizar' : 'Guardar'}
        </button>
        {produccionEnEdicion && (
          <button
            onClick={onCancelar}
            disabled={isLoading}
            className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded font-medium hover:bg-gray-50"
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}
