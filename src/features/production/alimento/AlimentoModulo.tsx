import { useState } from 'react';
import { useAuth } from '../../../auth/useAuth';
import { Compras } from './Compras';
import { Fabricaciones } from './Fabricaciones';
import { Recetas } from './Recetas';
import { Resumen } from './Resumen';
import { Stock } from './Stock';
import { VerRecetas } from './VerRecetas';

type Vista = 'resumen' | 'stock' | 'compras' | 'recetas' | 'fabricaciones' | 'ver';
const ADMIN_VISTAS: { id: Vista; label: string }[] = [
  { id: 'resumen', label: 'Resumen' }, { id: 'stock', label: 'Stock' }, { id: 'compras', label: 'Compras e insumos' }, { id: 'recetas', label: 'Recetas' },
];
const OPERATIVAS: Vista[] = ['fabricaciones', 'ver'];

/** Alimento Balanceado: ADMIN sees the four administrative views plus the operational ones; OPERATOR only Fabricaciones and Ver recetas. */
export function AlimentoModulo() {
  const { rol } = useAuth();
  const esAdmin = rol === 'ADMIN';
  const [vista, setVista] = useState<Vista>(esAdmin ? 'resumen' : 'fabricaciones');
  const actual: Vista = esAdmin || OPERATIVAS.includes(vista) ? vista : 'fabricaciones';
  const pestana = (id: Vista, label: string) => (
    <button key={id} onClick={() => setVista(id)}
      className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium ${actual === id ? 'bg-[#A8552E] text-white' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>{label}</button>
  );
  return (
    <div className="space-y-4">
      <nav className="flex gap-2 overflow-x-auto items-center">
        {esAdmin && ADMIN_VISTAS.map((v) => pestana(v.id, v.label))}
        {esAdmin && <span className="w-px h-6 bg-[#E4DCC8] mx-1" aria-hidden />}
        {pestana('fabricaciones', 'Fabricaciones')}
        {pestana('ver', 'Ver recetas')}
      </nav>
      {actual === 'resumen' && <Resumen />}
      {actual === 'stock' && <Stock />}
      {actual === 'compras' && <Compras />}
      {actual === 'recetas' && <Recetas />}
      {actual === 'fabricaciones' && <Fabricaciones />}
      {actual === 'ver' && <VerRecetas />}
    </div>
  );
}
