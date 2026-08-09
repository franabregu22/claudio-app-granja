import { useState } from 'react';
import { useProducciones, useCrearProduccion, useActualizarProduccion } from '../../hooks/useProducciones';
import { FormProduccion } from './FormProduccion';
import { ListaProducciones } from './ListaProducciones';

const GALPONES = ['Galpón 1', 'Galpón 2', 'Galpón 3'];

export function ProductionApp() {
  const { data: producciones = [], isLoading } = useProducciones();
  const crearMutation = useCrearProduccion();
  const actualizarMutation = useActualizarProduccion();
  const [produccionEnEdicion, setProduccionEnEdicion] = useState<string | null>(null);

  const handleGuardar = (data: any) => {
    if (produccionEnEdicion) {
      actualizarMutation.mutate(
        { id: produccionEnEdicion, ...data },
        { onSuccess: () => setProduccionEnEdicion(null) }
      );
    } else {
      crearMutation.mutate(data);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando datos de producción...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Formulario */}
      <FormProduccion
        galpones={GALPONES}
        onGuardar={handleGuardar}
        isLoading={crearMutation.isPending || actualizarMutation.isPending}
        produccionEnEdicion={
          produccionEnEdicion
            ? producciones.find((p) => p.id === produccionEnEdicion) || null
            : null
        }
        onCancelar={() => setProduccionEnEdicion(null)}
      />

      {/* Lista */}
      <ListaProducciones
        producciones={producciones}
        onEditar={(id) => setProduccionEnEdicion(id)}
        produccionEnEdicion={produccionEnEdicion}
      />
    </div>
  );
}
