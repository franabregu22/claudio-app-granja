import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { errorMessage } from '../../target/messages';

export const campo = 'w-full border border-gray-300 rounded-lg px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-amber-600';
export const etiqueta = 'block text-sm font-medium text-gray-700';

interface ModalProps {
  titulo: string;
  onClose: () => void;
  onSubmit: () => void;
  puedeGuardar: boolean;
  guardando: boolean;
  error?: unknown;
  textoGuardar?: string;
  children: ReactNode;
}

/** Form dialog shared by the F27-D treasury screens: every submit is one contract RPC; errors come normalized. */
export function Modal({ titulo, onClose, onSubmit, puedeGuardar, guardando, error, textoGuardar = 'Guardar', children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const cerrar = () => { ref.current?.close(); onClose(); };

  return (
    <dialog ref={ref} onClose={cerrar} className="w-full max-w-md p-6 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-amber-900">{titulo}</h2>
        <button type="button" onClick={cerrar} className="text-gray-400 hover:text-gray-600"><X size={22} /></button>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (puedeGuardar && !guardando) onSubmit(); }} className="space-y-3">
        {children}
        {error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(error)}</div> : null}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar || guardando}
            className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">
            {guardando ? 'Guardando...' : textoGuardar}
          </button>
        </div>
      </form>
    </dialog>
  );
}
