import { PyLProfesional } from '../caja/PyLProesional';
import { useAuth } from '../../auth/useAuth';

export function FinanzasApp() {
  const { rol } = useAuth();

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede acceder a Finanzas.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
            Granja Santo Tomás
          </p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Finanzas</h1>
        </header>

        {/* Contenido Principal */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {/* Estado de Resultados (P&L) */}
          <div className="mb-8">
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
              Estado de Resultados (Devengado)
            </p>
            <PyLProfesional />
          </div>
        </div>
      </div>
    </div>
  );
}
