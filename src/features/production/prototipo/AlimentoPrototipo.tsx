import { useState } from 'react';
import { useAuth } from '../../../auth/useAuth';
import { Compras } from './Compras';
import { ConsultaRecetas } from './ConsultaRecetas';
import { estadoInicial, type Estado } from './datos';
import { Fabricaciones } from './Fabricaciones';
import { Recetas } from './Recetas';
import { Resumen } from './Resumen';
import { Stock } from './Stock';

type Vista = 'resumen' | 'stock' | 'compras' | 'recetas' | 'fabricaciones' | 'consulta';
const OPERATIVAS: Vista[] = ['fabricaciones', 'consulta'];   // las que ve el empleado
const ADMIN_VISTAS: { id: Vista; label: string }[] = [
  { id: 'resumen', label: 'Resumen' }, { id: 'stock', label: 'Stock' }, { id: 'compras', label: 'Compras e insumos' }, { id: 'recetas', label: 'Recetas' },
];

/**
 * PROTOTIPO Alimento Balanceado (etapa 1). Datos ficticios en memoria: ningún formulario escribe en Supabase y todo
 * vuelve al estado inicial al recargar. ADMIN ve las cuatro vistas administrativas y Fabricaciones; OPERATOR
 * (empleado) solo Fabricaciones. Un ADMIN puede previsualizar la vista de empleado.
 */
export function AlimentoPrototipo() {
  const { rol } = useAuth();
  const [e, setE] = useState<Estado>(estadoInicial);
  const [comoEmpleado, setComoEmpleado] = useState(false);
  const esAdmin = rol === 'ADMIN' && !comoEmpleado;
  const [vista, setVista] = useState<Vista>(esAdmin ? 'resumen' : 'fabricaciones');
  const actual: Vista = esAdmin || OPERATIVAS.includes(vista) ? vista : 'fabricaciones';
  const quien = esAdmin ? 'Vos (admin)' : 'Vos (empleado)';
  const set = (f: (s: Estado) => Estado) => setE(f);
  const pestana = (id: Vista, label: string) => (
    <button key={id} onClick={() => setVista(id)}
      className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium ${actual === id ? 'bg-[#A8552E] text-white' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-900 flex flex-wrap items-center gap-2" role="note">
        <b>Prototipo con datos ficticios.</b> Nada se guarda en la base; al recargar vuelve al estado inicial.
        <button className="ml-auto text-xs underline" onClick={() => setE(estadoInicial())}>Restablecer datos</button>
        {rol === 'ADMIN' && (
          <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={comoEmpleado} onChange={(ev) => setComoEmpleado(ev.target.checked)} /> Ver como empleado</label>
        )}
      </div>
      <nav className="flex gap-2 overflow-x-auto items-center">
        {esAdmin && ADMIN_VISTAS.map((v) => pestana(v.id, v.label))}
        {esAdmin && <span className="w-px h-6 bg-[#E4DCC8] mx-1" aria-hidden />}
        {pestana('fabricaciones', 'Fabricaciones')}
        {pestana('consulta', 'Ver recetas')}
      </nav>
      {actual === 'resumen' && <Resumen e={e} />}
      {actual === 'stock' && <Stock e={e} set={set} quien={quien} esAdmin={esAdmin} />}
      {actual === 'compras' && <Compras e={e} set={set} quien={quien} />}
      {actual === 'recetas' && <Recetas e={e} set={set} quien={quien} />}
      {actual === 'fabricaciones' && <Fabricaciones e={e} set={set} quien={quien} />}
      {actual === 'consulta' && <ConsultaRecetas e={e} />}
    </div>
  );
}
