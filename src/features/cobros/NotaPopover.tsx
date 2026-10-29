import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare } from 'lucide-react';

const ANCHO = 256;   // px; clamped to the viewport on small screens
const MARGEN = 8;

/**
 * "Nota" cell: a message icon that opens the full comment in a popover; a discreet dash when there is none. The popover is
 * portalled to <body> with fixed coordinates, so the table's horizontal scroll never clips it (desktop and phone alike).
 * Closes on outside click / tap, Escape, scroll or resize. Display only: the stored comment is never changed.
 */
export function NotaPopover({ nota }: { nota: string | null | undefined }) {
  const texto = nota?.trim() ?? '';
  const boton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!pos) return;
    const cerrar = () => setPos(null);
    const fuera = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !boton.current?.contains(t)) cerrar();
    };
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar(); };
    document.addEventListener('pointerdown', fuera);
    document.addEventListener('keydown', tecla);
    window.addEventListener('scroll', cerrar, true);
    window.addEventListener('resize', cerrar);
    return () => {
      document.removeEventListener('pointerdown', fuera);
      document.removeEventListener('keydown', tecla);
      window.removeEventListener('scroll', cerrar, true);
      window.removeEventListener('resize', cerrar);
    };
  }, [pos]);

  if (texto === '') return <span className="text-gray-300" aria-label="Sin nota">—</span>;

  function alternar() {
    if (pos) { setPos(null); return; }
    const r = boton.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(ANCHO, window.innerWidth - 2 * MARGEN);
    const left = Math.min(Math.max(MARGEN, r.right - width), window.innerWidth - width - MARGEN);
    const abajo = window.innerHeight - r.bottom;   // not enough room below (e.g. last rows on a phone) → open upwards
    setPos(abajo >= 160 || abajo >= r.top ? { top: r.bottom + 4, left, width } : { bottom: window.innerHeight - r.top + 4, left, width });
  }

  return (
    <>
      <button ref={boton} type="button" onClick={alternar} aria-label="Ver nota" aria-expanded={pos !== null}
        className="p-0.5 -m-0.5 rounded text-amber-700 hover:text-amber-900 hover:bg-amber-50">
        <MessageSquare size={14} />
      </button>
      {pos && createPortal(
        <div ref={panel} role="dialog" aria-label="Nota del cobro" style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
          className="z-[1000] bg-white border border-[#E4DCC8] rounded-lg shadow-lg p-3 text-xs text-gray-700 whitespace-pre-wrap [overflow-wrap:anywhere] max-h-60 overflow-y-auto">
          {texto}
        </div>,
        document.body,
      )}
    </>
  );
}
