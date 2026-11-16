import { useState } from 'react';
import { ChevronDown, Pencil, Plus } from 'lucide-react';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import {
  ahora, diffReceta, escalarTanda, fechaDMA, hastaVersion, HOY, kgLinea, kgTxt, SECCIONES, versionVigente,
  type Estado, type Linea, type Receta, type Seccion, type Version,
} from './datos';
import { IngredientesTabla } from './IngredientesTabla';
import { botonPrimario, botonSecundario, Ficticio, Tabla, Titulo, td, thL } from './ui';

type Set = (f: (e: Estado) => Estado) => void;
type Editor = { tipo: 'receta' } | { tipo: 'modificar'; receta: Receta } | { tipo: 'tanda'; receta: Receta } | { tipo: 'ingrediente' } | null;

/**
 * Recetas (simuladas): lista con cantidad de versiones y estado → desplegable con las versiones y su vigencia →
 * desplegable con los ingredientes. «Modificar ingredientes» crea automáticamente una versión nueva; cada cambio
 * queda en el historial de modificaciones.
 */
export function Recetas({ e, set, quien }: { e: Estado; set: Set; quien: string }) {
  const [abierta, setAbierta] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const nombre = (id: string) => e.ingredientes.find((i) => i.id === id)?.nombre ?? id;
  const registrar = (s: Estado, receta: string, cambio: string): Estado =>
    ({ ...s, historialRecetas: [{ cuando: ahora(), quien, receta, cambio }, ...s.historialRecetas], auditoria: [{ cuando: ahora(), quien, que: `${receta}: ${cambio}` }, ...s.auditoria] });
  const recetas = [...e.recetas].sort((a, b) => Number(b.activa) - Number(a.activa));

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button className={botonPrimario} onClick={() => setEditor({ tipo: 'receta' })}><Plus className="w-4 h-4 inline -mt-0.5" /> Nueva receta</button>
        <button className={botonSecundario} onClick={() => setEditor({ tipo: 'ingrediente' })}>Nuevo ingrediente</button>
      </div>

      {recetas.map((r) => {
        const enUso = r.activa ? versionVigente(r, HOY) : undefined;
        const versiones = [...r.versiones].sort((a, b) => b.desde.localeCompare(a.desde));
        return (
          <div key={r.id} className={`bg-white rounded-lg border ${r.activa ? 'border-[#E4DCC8]' : 'border-dashed border-gray-300'}`}>
            <button onClick={() => setAbierta(abierta === r.id ? null : r.id)} className="w-full flex items-center gap-2 p-3 text-left text-sm flex-wrap">
              <ChevronDown className={`w-4 h-4 transition ${abierta === r.id ? 'rotate-180' : ''}`} />
              <span className={`font-semibold ${r.activa ? '' : 'text-gray-500'}`}>{r.nombre}</span>
              <span className="text-gray-600">{r.versiones.length} versión{r.versiones.length === 1 ? '' : 'es'}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${r.activa ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                {r.activa ? 'Activa' : `Inactiva${r.inactivaDesde ? ` desde ${fechaDMA(r.inactivaDesde)}` : ''}`}
              </span>
              {r.nuevo && <Ficticio />}
            </button>
            {abierta === r.id && (
              <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] space-y-3 pt-3">
                <div className="flex gap-2 flex-wrap items-center">
                  {r.activa && (
                    <button className={botonPrimario} onClick={() => setEditor({ tipo: 'modificar', receta: r })}>
                      <Pencil className="w-4 h-4 inline -mt-0.5" /> Modificar ingredientes
                    </button>
                  )}
                  <button className={botonSecundario} onClick={() => set((s) => registrar({
                    ...s, recetas: s.recetas.map((x) => (x.id === r.id ? { ...x, activa: !x.activa, inactivaDesde: x.activa ? HOY : undefined } : x)),
                  }, r.nombre, r.activa ? `Desactivada desde ${fechaDMA(HOY)}` : 'Activada'))}>
                    {r.activa ? 'Desactivar' : 'Activar'}
                  </button>
                  {r.activa && enUso && (
                    <button className={botonSecundario} onClick={() => setEditor({ tipo: 'tanda', receta: r })}>Batch estándar: {kgTxt(enUso.tandaKg)} · cambiar</button>
                  )}
                </div>
                {r.activa && <p className="text-xs text-gray-600">Modificar ingredientes crea automáticamente la versión v{Math.max(...r.versiones.map((v) => v.version)) + 1}. El batch estándar es el tamaño predeterminado en «Ver recetas» (el operario puede elegir otro ahí); cambiarlo no crea versión.</p>}
                {versiones.map((v) => (
                  <VersionItem key={v.id} v={v} hasta={hastaVersion(r, v)} enUso={v.id === enUso?.id} nombre={nombre}
                    onComentario={(texto) => set((s) => registrar({
                      ...s, recetas: s.recetas.map((x) => (x.id === r.id ? { ...x, versiones: x.versiones.map((y) => (y.id === v.id ? { ...y, comentario: texto } : y)) } : x)),
                    }, r.nombre, `Comentario de v${v.version}: «${v.comentario || '—'}» → «${texto || '—'}»`))} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <section>
        <Titulo>Historial de modificaciones</Titulo>
        {e.historialRecetas.length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin modificaciones.</p> : (
          <Tabla cabecera={<><th className={thL}>Fecha</th><th className={thL}>Quién</th><th className={thL}>Receta</th><th className={thL}>Qué cambió</th></>}>
            {e.historialRecetas.map((h, i) => (
              <tr key={i}><td className={`${td} whitespace-nowrap`}>{h.cuando}</td><td className={td}>{h.quien}</td><td className={`${td} font-semibold`}>{h.receta}</td><td className={td}>{h.cambio}</td></tr>
            ))}
          </Tabla>
        )}
      </section>

      {editor?.tipo === 'ingrediente' && <IngredienteModal onClose={() => setEditor(null)} onGuardar={(n) => {
        set((s) => ({ ...s, ingredientes: [...s.ingredientes, { id: `ing-${Date.now()}`, nombre: n, nuevo: true }], auditoria: [{ cuando: ahora(), quien, que: `Nuevo ingrediente: ${n}` }, ...s.auditoria] }));
        setEditor(null);
      }} />}
      {editor?.tipo === 'receta' && <RecetaModal e={e} onClose={() => setEditor(null)} onGuardar={(n, v) => {
        const id = `rec-${Date.now()}`;
        set((s) => registrar({ ...s, recetas: [...s.recetas, { id, nombre: n, activa: true, nuevo: true, versiones: [{ ...v, id: `${id}-1`, version: 1 }] }] },
          n, `Receta nueva v1 desde ${fechaDMA(v.desde)}: ${diffReceta(undefined, v, nombre)}`));
        setEditor(null);
      }} />}
      {editor?.tipo === 'tanda' && <TandaModal receta={editor.receta} nombre={nombre} onClose={() => setEditor(null)} onGuardar={(kg) => {
        const r = editor.receta; const v = versionVigente(r, HOY)!;
        set((s) => registrar({ ...s, recetas: s.recetas.map((x) => (x.id === r.id
          ? { ...x, versiones: x.versiones.map((y) => (y.id === v.id ? { ...y, tandaKg: kg, lineas: escalarTanda(y, kg) } : y)) } : x)) },
          r.nombre, `Batch estándar: ${v.tandaKg} → ${kg} kg (sin versión nueva)`));
        setEditor(null);
      }} />}
      {editor?.tipo === 'modificar' && <RecetaModal e={e} receta={editor.receta} onClose={() => setEditor(null)} onGuardar={(_, v) => {
        const r = editor.receta; const n = Math.max(...r.versiones.map((x) => x.version)) + 1;
        set((s) => registrar({ ...s, recetas: s.recetas.map((x) => (x.id === r.id ? { ...x, versiones: [...x.versiones, { ...v, id: `${r.id}-${n}`, version: n }] } : x)) },
          r.nombre, `Nueva versión v${n} desde ${fechaDMA(v.desde)}: ${diffReceta(versionVigente(r, HOY), v, nombre)}`));
        setEditor(null);
      }} />}
    </div>
  );
}

/** Una versión: vigencia y comentario (editable); adentro, el desplegable con los ingredientes para el batch estándar. */
function VersionItem({ v, hasta, enUso, nombre, onComentario }: {
  v: Version; hasta: string | null; enUso: boolean; nombre: (id: string) => string; onComentario: (texto: string) => void;
}) {
  const [ver, setVer] = useState(enUso);
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(v.comentario ?? '');
  return (
    <div className={`bg-white rounded-lg border text-sm ${enUso ? 'border-amber-500' : 'border-[#E4DCC8]'}`}>
      <button onClick={() => setVer(!ver)} className="w-full flex items-center gap-2 px-3 py-2 text-left flex-wrap">
        <ChevronDown className={`w-4 h-4 transition ${ver ? 'rotate-180' : ''}`} />
        <span className="font-semibold">Versión {v.version}</span>
        <span className="text-gray-600">vigente {fechaDMA(v.desde)} → {hasta ? fechaDMA(hasta) : v.desde > HOY ? 'próxima' : 'hoy'}</span>
        {enUso && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">En uso</span>}
        <span className="ml-auto text-xs text-gray-500">Ingredientes</span>
      </button>
      <div className="px-3 pb-2 -mt-1 text-xs">
        {editando ? (
          <div className="flex gap-2 items-center flex-wrap">
            <input type="text" autoFocus value={texto} onChange={(ev) => setTexto(ev.target.value)} placeholder="Comentario de la versión"
              className="flex-1 min-w-48 border border-gray-300 rounded px-2 py-1" />
            <button className="text-[#A8552E] font-semibold hover:underline" disabled={texto.trim() === (v.comentario ?? '')}
              onClick={() => { onComentario(texto.trim()); setEditando(false); }}>Guardar (simulado)</button>
            <button className="text-gray-600 hover:underline" onClick={() => { setTexto(v.comentario ?? ''); setEditando(false); }}>Cancelar</button>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-gray-700">
            {v.comentario ? <span className="italic">«{v.comentario}»</span> : <span className="text-gray-400">Sin comentario</span>}
            <button aria-label="Editar comentario" title={v.comentario ? 'Editar comentario' : 'Agregar comentario'} onClick={() => setEditando(true)}
              className="text-[#A8552E] hover:text-[#8B4423] inline-flex items-center gap-0.5"><Pencil className="w-3.5 h-3.5" />{v.comentario ? '' : ' agregar'}</button>
          </p>
        )}
      </div>
      {ver && (
        <div className="px-3 pb-3">
          <IngredientesTabla lineas={v.lineas} batchKg={v.tandaKg} nombre={nombre} columnaKg={`Kg para batch de ${kgTxt(v.tandaKg)}`} />
        </div>
      )}
    </div>
  );
}

/** Batch estándar: el tamaño predeterminado en «Ver recetas»; mismas proporciones, NO crea versión (queda en el historial). */
function TandaModal({ receta, nombre, onClose, onGuardar }: { receta: Receta; nombre: (id: string) => string; onClose: () => void; onGuardar: (kg: number) => void }) {
  const v = versionVigente(receta, HOY)!;
  const [kg, setKg] = useState(String(v.tandaKg));
  const n = Number(kg);
  const valido = n > 0 && n !== v.tandaKg;
  return (
    <Modal titulo={`Tamaño estándar del batch — ${receta.nombre}`} onClose={onClose} guardando={false} puedeGuardar={valido} textoGuardar="Guardar (simulado)" onSubmit={() => onGuardar(n)}>
      <p className="text-xs text-purple-800 bg-purple-50 rounded px-2 py-1">Simulación: no se guarda nada en la base.<Ficticio /></p>
      <p className="text-sm text-gray-700">Es el tamaño que aparece por defecto en «Ver recetas». Las proporciones no cambian y no se crea una versión nueva.</p>
      <label className={etiqueta}>Tamaño estándar del batch (kg)<input type="number" min="1" value={kg} onChange={(ev) => setKg(ev.target.value)} className={campo} /></label>
      <IngredientesTabla lineas={v.lineas} batchKg={v.tandaKg} nombre={nombre} columnaKg={`Ahora (${kgTxt(v.tandaKg)})`}
        otra={n > 0 ? { titulo: `Nuevo (${kgTxt(n)})`, lineas: escalarTanda(v, n) } : undefined} />
    </Modal>
  );
}

function IngredienteModal({ onClose, onGuardar }: { onClose: () => void; onGuardar: (n: string) => void }) {
  const [n, setN] = useState('');
  return (
    <Modal titulo="Nuevo ingrediente" onClose={onClose} guardando={false} puedeGuardar={n.trim() !== ''} textoGuardar="Crear (simulado)" onSubmit={() => onGuardar(n.trim())}>
      <label className={etiqueta}>Nombre<input type="text" value={n} onChange={(ev) => setN(ev.target.value)} className={campo} placeholder="Ej: Harina de carne" /></label>
    </Modal>
  );
}

/** Nueva receta, o modificar una existente: parte de la versión en uso y al guardar crea la versión siguiente. */
function RecetaModal({ e, receta, onClose, onGuardar }: { e: Estado; receta?: Receta; onClose: () => void; onGuardar: (nombre: string, v: Omit<Version, 'id' | 'version'>) => void }) {
  const base = receta ? versionVigente(receta, HOY) : undefined;
  const siguiente = receta ? Math.max(...receta.versiones.map((v) => v.version)) + 1 : 1;
  const ultimaDesde = receta ? [...receta.versiones].map((v) => v.desde).sort().at(-1)! : '';
  const nombre = (id: string) => e.ingredientes.find((i) => i.id === id)?.nombre ?? id;
  const [nombreReceta, setNombreReceta] = useState('');
  const [desde, setDesde] = useState(HOY);
  const [comentario, setComentario] = useState('');
  const [tanda, setTanda] = useState(String(base?.tandaKg ?? 200));
  type Fila = { ingredienteId: string; kg: string; seccion: Seccion };
  const [lineas, setLineas] = useState<Fila[]>(base
    ? base.lineas.map((l) => ({ ingredienteId: l.ingredienteId, kg: String(l.kg), seccion: l.seccion }))
    : [{ ingredienteId: '', kg: '', seccion: 'PREMEZCLA' }, { ingredienteId: '', kg: '', seccion: 'MACRO' }]);
  const setL = (i: number, p: Partial<Fila>) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const suma = lineas.reduce((t, l) => t + (Number(l.kg) || 0), 0);
  const completas: Linea[] = lineas.filter((l) => l.ingredienteId && Number(l.kg) > 0).map((l) => ({ ingredienteId: l.ingredienteId, kg: Number(l.kg), seccion: l.seccion }));
  const repetido = new Set(completas.map((l) => l.ingredienteId)).size !== completas.length;
  const cambios = receta ? diffReceta(base, { tandaKg: Number(tanda), lineas: completas }, nombre) : '';
  const sinCambios = !!receta && cambios === 'sin cambios en los ingredientes';
  const puede = (receta || nombreReceta.trim() !== '') && Number(tanda) > 0 && completas.length === lineas.length && completas.length > 0
    && Math.abs(suma - Number(tanda)) < 0.001 && !repetido && !sinCambios && (!receta || desde > ultimaDesde);
  return (
    <Modal titulo={receta ? `Modificar ingredientes — ${receta.nombre}` : 'Nueva receta'} onClose={onClose} guardando={false} puedeGuardar={!!puede}
      textoGuardar={receta ? `Crear versión v${siguiente} (simulado)` : 'Guardar (simulado)'}
      onSubmit={() => onGuardar(nombreReceta.trim(), { desde, tandaKg: Number(tanda), lineas: completas, comentario: comentario.trim() || undefined })}>
      <p className="text-xs text-purple-800 bg-purple-50 rounded px-2 py-1">Simulación: no se guarda nada en la base.<Ficticio /></p>
      {receta && <p className="text-sm text-amber-900 bg-amber-50 rounded px-2 py-1">Partís de la versión v{base?.version}. Al guardar se crea la <b>versión v{siguiente}</b>; la v{base?.version} queda en el historial hasta el día anterior.</p>}
      {!receta && <label className={etiqueta}>Nombre<input type="text" value={nombreReceta} onChange={(ev) => setNombreReceta(ev.target.value)} className={campo} /></label>}
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Vigente desde<input type="date" min={receta ? ultimaDesde : undefined} value={desde} onChange={(ev) => setDesde(ev.target.value)} className={campo} /></label>
        {receta
          ? <p className="text-sm text-gray-700 self-end pb-2">Kg para batch de <b>{kgTxt(Number(tanda))}</b></p>
          : <label className={etiqueta}>Batch estándar (kg)<input type="number" min="1" value={tanda} onChange={(ev) => setTanda(ev.target.value)} className={campo} /></label>}
      </div>
      {SECCIONES.map((s) => {
        const otra = SECCIONES.find((x) => x.id !== s.id)!;
        const filas = lineas.map((l, i) => ({ l, i })).filter(({ l }) => l.seccion === s.id);
        const sub = filas.reduce((t, { l }) => t + (Number(l.kg) || 0), 0);
        return (
          <fieldset key={s.id} className="border border-[#E4DCC8] rounded-lg p-2 space-y-2">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">{s.label} · {kgLinea(sub, s.id)}</legend>
            {filas.length === 0 && <p className="text-xs text-gray-400">Sin ingredientes.</p>}
            {filas.map(({ l, i }) => (
              <div key={i} className="grid grid-cols-[1fr_6.5rem_auto] gap-2 items-end">
                <label className={etiqueta}>Ingrediente
                  <select value={l.ingredienteId} onChange={(ev) => setL(i, { ingredienteId: ev.target.value })} className={campo}>
                    <option value="">Elegir…</option>
                    {e.ingredientes.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                  </select>
                </label>
                <label className={etiqueta}>Kg<input type="number" min="0" step={s.id === 'PREMEZCLA' ? '0.001' : '0.01'} value={l.kg}
                  placeholder={s.id === 'PREMEZCLA' ? '0,290' : ''} onChange={(ev) => setL(i, { kg: ev.target.value })} className={campo} /></label>
                <span className="flex flex-col items-start pb-1 gap-0.5">
                  <button type="button" onClick={() => setL(i, { seccion: otra.id })} className="text-[11px] text-[#A8552E] hover:underline whitespace-nowrap">→ {otra.label}</button>
                  <button type="button" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))} disabled={lineas.length === 1} className="text-[11px] text-red-700 hover:underline disabled:opacity-40">Quitar</button>
                </span>
              </div>
            ))}
            <button type="button" onClick={() => setLineas((ls) => [...ls, { ingredienteId: '', kg: '', seccion: s.id }])} className="text-xs text-[#A8552E] hover:underline">+ Agregar a {s.label}</button>
          </fieldset>
        );
      })}
      <p className={`text-xs ${Math.abs(suma - Number(tanda)) < 0.001 ? 'text-gray-600' : 'text-red-700'}`}>Suma de ingredientes {kgLinea(suma, 'PREMEZCLA')} — debe ser igual al batch ({kgTxt(Number(tanda) || 0)}).</p>
      <label className={etiqueta}>Comentario de la versión (opcional)
        <input type="text" value={comentario} onChange={(ev) => setComentario(ev.target.value)} className={campo} placeholder="Ej: más conchilla por cáscara fina" />
      </label>
      {repetido && <p className="text-xs text-red-700">Hay un ingrediente repetido.</p>}
      {receta && <p className={`text-xs ${sinCambios ? 'text-red-700' : 'text-gray-700'}`}><b>Cambios:</b> {cambios}</p>}
      {receta && desde <= ultimaDesde && <p className="text-xs text-red-700">La fecha debe ser posterior al {fechaDMA(ultimaDesde)} (inicio de la última versión).</p>}
    </Modal>
  );
}
