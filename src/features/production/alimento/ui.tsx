import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

/** Piezas visuales del prototipo: las mismas clases que las tablas de Alimento / Caja. */
export const thL = 'px-3 py-2 text-left';
export const thR = 'px-3 py-2 text-right';
export const td = 'px-3 py-2';
export const tdR = 'px-3 py-2 text-right';
export const botonPrimario = 'text-sm px-3 py-2 rounded-lg font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50';
export const botonSecundario = 'text-sm px-3 py-2 rounded-lg font-medium bg-white border border-[#E4DCC8] hover:bg-stone-50 disabled:opacity-50';

export function Tabla({ cabecera, children }: { cabecera: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
      <table className="w-full text-xs md:text-sm">
        <thead className="bg-amber-50 border-b border-amber-200 text-amber-900"><tr>{cabecera}</tr></thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-amber-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Titulo({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-2">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">{children}</p>
      {info && <InfoIcono>{info}</InfoIcono>}
    </div>
  );
}

export function InfoIcono({ children }: { children: ReactNode }) {
  return (
    <details className="relative">
      <summary className="list-none cursor-pointer text-[#A8552E]" aria-label="Cómo se calcula"><Info className="w-4 h-4" /></summary>
      <div className="absolute left-0 z-10 mt-1 w-80 max-w-[85vw] bg-white border border-[#E4DCC8] rounded-lg shadow p-3 text-xs text-gray-700 space-y-1 normal-case tracking-normal font-normal">
        {children}
      </div>
    </details>
  );
}

export const Ficticio = () => <span className="ml-1 text-[10px] uppercase bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded">simulado</span>;
