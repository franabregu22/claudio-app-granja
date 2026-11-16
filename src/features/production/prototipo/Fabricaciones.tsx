import { useState } from 'react';
import { Lock, Pencil, Plus } from 'lucide-react';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { ahora, diffFabricacion, fechaDMA, HOY, kgTxt, mesCerrado, opcionesFabricacion, type Estado, type Fabricacion } from './datos';
import { botonPrimario, Ficticio, Tabla, Titulo, td, tdR, thL, thR } from './ui';

type Set = (f: (e: Estado) => Estado) => void;

/** Fabricaciones (simuladas) — ADMIN y EMPLEADO. Un mes cerrado no admite altas ni ediciones; cada cambio queda auditado. */
export function Fabricaciones({ e, set, quien }: { e: Estado; set: Set; quien: string }) {
  const [form, setForm] = useState<Fabricacion | 'nueva' | null>(null);
  const receta = (id: string) => e.recetas.find((r) => r.id === id);
  const etiquetaFab = (f: Pick<Fabricacion, 'recetaId' | 'versionId'>) => {
    const r = receta(f.recetaId); const v = r?.versiones.find((x) => x.id === f.versionId);
    return `${r?.nombre ?? '—'} · v${v?.version ?? '?'}`;
  };
  const lista = [...e.fabricaciones].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 40);

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><button className={botonPrimario} onClick={() => setForm('nueva')}><Plus className="w-4 h-4 inline -mt-0.5" /> Nueva fabricación</button></div>
      <section>
        <Titulo>Historial de fabricaciones</Titulo>
        <Tabla cabecera={<><th className={thL}>Fecha</th><th className={thL}>Tipo / versión</th><th className={thR}>Kilos</th><th className={thL}>Responsable</th><th className={`${thL} hidden md:table-cell`}>Comentario</th><th className={thR} /></>}>
          {lista.map((f) => {
            const cerrado = mesCerrado(e, f.fecha);
            return (
              <tr key={f.id}>
                <td className={td}>{f.fecha.slice(8, 10)}/{f.fecha.slice(5, 7)}/{f.fecha.slice(0, 4)}</td>
                <td className={td}>{etiquetaFab(f)}{f.nuevo && <Ficticio />}{(f.rectificaciones?.length ?? 0) > 0 && <Rectificada f={f} />}</td><td className={tdR}>{kgTxt(f.kg)}</td><td className={td}>{f.responsable}</td>
                <td className={`${td} hidden md:table-cell text-gray-600`}>{f.comentario || '—'}</td>
                <td className={tdR}>{cerrado
                  ? <span title="Mes cerrado: no se puede editar" className="inline-flex items-center gap-1 text-xs text-gray-500"><Lock className="w-3.5 h-3.5" /> Mes cerrado</span>
                  : <button aria-label="Editar" title="Editar" onClick={() => setForm(f)} className="text-[#A8552E] hover:text-[#8B4423]"><Pencil className="w-4 h-4" /></button>}</td>
              </tr>
            );
          })}
        </Tabla>
      </section>
      <section>
        <Titulo>Registro de auditoría (simulado)</Titulo>
        <div className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-xs space-y-1 max-h-60 overflow-y-auto">
          {e.auditoria.map((a, i) => <p key={i}><span className="text-gray-500">{a.cuando} · {a.quien}:</span> {a.que}</p>)}
        </div>
      </section>
      {form && <FabricacionModal e={e} fab={form === 'nueva' ? null : form} quien={quien} etiquetaFab={etiquetaFab} onClose={() => setForm(null)}
        onGuardar={(f) => {
          const previa = form === 'nueva' ? null : form;
          const cambios = previa ? diffFabricacion(previa, f, etiquetaFab) : [];
          if (previa && cambios.length === 0) { setForm(null); return; }   // sin cambios: no rectifica
          const nueva: Fabricacion = previa
            ? { ...f, nuevo: previa.nuevo, rectificaciones: [{ cuando: ahora(), quien, cambios }, ...(previa.rectificaciones ?? [])] }
            : { ...f, nuevo: true };
          const que = previa
            ? `Rectificó fabricación del ${fechaDMA(previa.fecha)}: ${cambios.join(' · ')}`
            : `Fabricación ${fechaDMA(f.fecha)} ${etiquetaFab(f)}: ${f.kg} kg (alta)`;
          set((s) => ({
            ...s, fabricaciones: previa ? s.fabricaciones.map((x) => (x.id === previa.id ? nueva : x)) : [nueva, ...s.fabricaciones],
            auditoria: [{ cuando: ahora(), quien, que }, ...s.auditoria],
          }));
          setForm(null);
        }} />}
    </div>
  );
}

/** Etiqueta «Rectificada» (como en la vista real) con el historial flotante de cambios al pasar el mouse o tocarla. */
function Rectificada({ f }: { f: Fabricacion }) {
  const rs = f.rectificaciones ?? [];
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);   // fijo a la ventana: la tabla con scroll no lo recorta
  const abrir = (el: HTMLElement) => { const r = el.getBoundingClientRect(); setPos({ x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 4 }); };
  return (
    <span tabIndex={0} className="ml-1.5 inline-block align-middle focus:outline-none"
      onMouseEnter={(ev) => abrir(ev.currentTarget)} onMouseLeave={() => setPos(null)} onFocus={(ev) => abrir(ev.currentTarget)} onBlur={() => setPos(null)}>
      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded cursor-help">Rectificada{rs.length > 1 ? ` ×${rs.length}` : ''}</span>
      {pos && <span style={{ left: Math.max(8, pos.x), top: pos.y }} className="fixed z-50 block w-72 max-w-[80vw] bg-white border border-[#E4DCC8] rounded-lg shadow p-3 text-xs text-gray-700 space-y-2 text-left font-normal">
        <span className="block font-semibold text-[#2C2419]">Historial de cambios</span>
        {rs.map((r, i) => (
          <span key={i} className="block border-t border-amber-100 pt-1.5 first:border-0 first:pt-0">
            <span className="block text-gray-500">{r.cuando} · {r.quien}</span>
            {r.cambios.map((c) => <span key={c} className="block">{c}</span>)}
          </span>
        ))}
        <span className="block text-gray-500 border-t border-amber-100 pt-1.5">Registrada por {f.responsable}</span>
      </span>}
    </span>
  );
}

function FabricacionModal({ e, fab, quien, etiquetaFab, onClose, onGuardar }: {
  e: Estado; fab: Fabricacion | null; quien: string; etiquetaFab: (f: Pick<Fabricacion, 'recetaId' | 'versionId'>) => string; onClose: () => void; onGuardar: (f: Fabricacion) => void;
}) {
  const [fecha, setFecha] = useState(fab?.fecha ?? HOY);
  const [opcion, setOpcion] = useState(fab ? `${fab.recetaId}|${fab.versionId}` : '');
  const [kilos, setKilos] = useState(String(fab?.kg ?? 200));
  const [comentario, setComentario] = useState(fab?.comentario ?? '');
  const opciones = opcionesFabricacion(e, fecha);
  const valida = opciones.some((o) => `${o.receta.id}|${o.version.id}` === opcion);
  const cerrado = mesCerrado(e, fecha);
  return (
    <Modal titulo={fab ? 'Editar fabricación' : 'Nueva fabricación'} onClose={onClose} guardando={false} textoGuardar="Guardar (simulado)"
      puedeGuardar={valida && !cerrado && Number(kilos) > 0 && fecha !== '' && fecha <= HOY}
      onSubmit={() => { const [recetaId, versionId] = opcion.split('|');
        onGuardar({ id: fab?.id ?? `f-${Date.now()}`, fecha, recetaId, versionId, kg: Number(kilos), comentario, responsable: fab?.responsable ?? quien }); }}>
      <p className="text-xs text-purple-800 bg-purple-50 rounded px-2 py-1">Simulación: no se guarda nada en la base.<Ficticio /></p>
      <label className={etiqueta}>Fecha<input type="date" max={HOY} value={fecha} onChange={(ev) => setFecha(ev.target.value)} className={campo} /></label>
      {cerrado && <p className="text-sm text-amber-800 flex items-center gap-1"><Lock className="w-4 h-4" /> El mes de esa fecha está cerrado: no se puede registrar ni editar.</p>}
      <label className={etiqueta}>Tipo / versión
        <select value={valida ? opcion : ''} onChange={(ev) => setOpcion(ev.target.value)} className={campo}>
          <option value="">Elegir…</option>
          {opciones.map((o) => <option key={o.version.id} value={`${o.receta.id}|${o.version.id}`}>{etiquetaFab({ recetaId: o.receta.id, versionId: o.version.id })}</option>)}
        </select>
      </label>
      {fab && !valida && <p className="text-xs text-gray-600">Registrada como {etiquetaFab(fab)}: elegí una receta activa vigente en la fecha.</p>}
      <label className={etiqueta}>Kilos<input type="number" min="0" step="0.1" value={kilos} onChange={(ev) => setKilos(ev.target.value)} className={campo} /></label>
      <label className={etiqueta}>Comentario (opcional)<input type="text" value={comentario} onChange={(ev) => setComentario(ev.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-600">Responsable: {fab?.responsable ?? quien} (automático)</p>
    </Modal>
  );
}
