import { Check, ChevronDown, Filter } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const ANCHO = 256;

/**
 * A column title with an Excel-like filter: an arrow next to the name opens a drop-down under it (fixed position, so a table that
 * scrolls sideways does not clip it). The arrow becomes a filter icon while the column is filtered. Escape, a click outside or
 * scrolling the page closes it.
 */
export function FiltroColumna({ titulo, activo, derecha = false, children }: {
  titulo: string; activo: boolean; derecha?: boolean; children: (cerrar: () => void) => ReactNode;
}) {
  const boton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cerrar = () => setPos(null);
  const abrir = () => {
    const r = boton.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(derecha ? r.right - ANCHO : r.left, window.innerWidth - ANCHO - 8));
    setPos({ top: Math.min(r.bottom + 4, window.innerHeight - 120), left });
  };
  useEffect(() => {
    if (!pos) return undefined;
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar(); };
    const desplazar = (e: Event) => { if (!panel.current?.contains(e.target as Node)) cerrar(); };
    window.addEventListener('keydown', tecla);
    window.addEventListener('resize', cerrar);
    window.addEventListener('scroll', desplazar, true);
    return () => { window.removeEventListener('keydown', tecla); window.removeEventListener('resize', cerrar); window.removeEventListener('scroll', desplazar, true); };
  }, [pos]);

  return (
    <>
      <button ref={boton} type="button" onClick={() => (pos ? cerrar() : abrir())} aria-expanded={!!pos} aria-haspopup="dialog"
        title={activo ? `${titulo}: filtrado` : `Filtrar por ${titulo.toLowerCase()}`}
        className={`inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-amber-50 ${activo ? 'text-[#A8552E] font-semibold' : ''}`}>
        {titulo}
        {activo ? <Filter className="w-3 h-3 fill-current" aria-label="filtrado" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={cerrar} aria-hidden />
          <div ref={panel} role="dialog" aria-label={`Filtro: ${titulo}`} style={{ top: pos.top, left: pos.left, width: ANCHO }}
            className="fixed z-50 max-h-[70vh] overflow-y-auto overflow-x-hidden [&_label>input]:block rounded-lg border border-[#E4DCC8] bg-white p-2 text-sm font-normal normal-case text-[#2C2419] shadow-lg">
            {children(cerrar)}
          </div>
        </>
      )}
    </>
  );
}

/** One choice among a list (plus «todos»), with a search box when the list is long — the body of a FiltroColumna. */
export function OpcionesFiltro({ valor, opciones, todos = 'Todos', onElegir, subtitulo }: {
  valor: string; opciones: { v: string; t: string }[]; todos?: string; onElegir: (v: string) => void; subtitulo?: string;
}) {
  const [q, setQ] = useState('');
  const norm = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const vistas = q.trim() ? opciones.filter((o) => norm(o.t).includes(norm(q.trim()))) : opciones;
  const item = (v: string, t: string) => (
    <li key={v || '__todos'}>
      <button type="button" onClick={() => onElegir(v)} className={`w-full flex items-center gap-2 rounded px-2 py-1 text-left hover:bg-amber-50 ${valor === v ? 'font-semibold text-[#A8552E]' : ''}`}>
        <Check className={`w-3.5 h-3.5 shrink-0 ${valor === v ? '' : 'invisible'}`} />{t}
      </button>
    </li>
  );
  return (
    <div className="space-y-1">
      {subtitulo && <p className="px-2 text-xs font-semibold uppercase tracking-wide text-[#8A7A5C]">{subtitulo}</p>}
      {opciones.length > 8 && (
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" aria-label="Buscar en la lista"
          className="w-full border border-[#E4DCC8] rounded px-2 py-1 text-sm" />
      )}
      <ul>
        {!q.trim() && item('', todos)}
        {vistas.map((o) => item(o.v, o.t))}
        {vistas.length === 0 && <li className="px-2 py-1 text-xs text-[#8A7A5C]">Sin coincidencias</li>}
      </ul>
    </div>
  );
}
