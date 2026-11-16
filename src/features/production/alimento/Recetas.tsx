import { useState } from 'react';
import { ChevronDown, Pencil, Plus } from 'lucide-react';
import type { RecipeChange } from '../../../target/alimento';
import { versionsEffectiveOn, type FeedTypeRow, type FormulaLineRow, type FormulaSection, type FormulaVersionRow } from '../../../target/feed';
import type { ExpenseCategoryRow } from '../../../target/masters';
import { getTodayDate } from '../../../utils/dateUtils';
import { useMasterList, useMasterMutations } from '../../admin/useMasters';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { fechaDMA, kgLinea, kgTxt, pctLinea, SECCIONES } from './format';
import { botonPrimario, botonSecundario, Tabla, Titulo, td, tdR, thL, thR } from './ui';
import { useAlimentoMutations, useAllFeedTypes, useComposition, useRecipeChanges, useVersions } from './useAlimento';

interface Ingrediente { id: string; nombre: string; activo: boolean }
type Editor = { tipo: 'receta' } | { tipo: 'modificar'; receta: FeedTypeRow } | { tipo: 'batch'; receta: FeedTypeRow } | null;

/**
 * Recetas (ADMIN). List → versions with their validity and comment → ingredients by section. «Modificar ingredientes»
 * publishes a new version (RPC 48); the standard batch never creates a version; every change is in the history
 * (report_feed_recipe_change).
 */
export function Recetas() {
  const tipos = useAllFeedTypes();
  const versiones = useVersions();
  const historial = useRecipeChanges();
  const m = useAlimentoMutations();
  const [abierta, setAbierta] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const hoy = getTodayDate();
  const lista = [...(tipos.data ?? [])].sort((a, b) => Number(b.activo) - Number(a.activo) || a.nombre.localeCompare(b.nombre));
  const delTipo = (id: string) => (versiones.data ?? []).filter((v) => v.feed_type_id === id).sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  const comp = useComposition(abierta ? delTipo(abierta).map((v) => v.id) : []);

  if (tipos.isLoading || versiones.isLoading) return <p className="text-sm text-gray-500">Cargando recetas…</p>;
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center">
        <button className={botonPrimario} onClick={() => setEditor({ tipo: 'receta' })}><Plus className="w-4 h-4 inline -mt-0.5" /> Nueva receta</button>
        <span className="text-xs text-gray-600">Los ingredientes son las subcategorías marcadas como insumo en Administración → Categorías de gasto.</span>
      </div>
      {lista.map((t) => {
        const vs = delTipo(t.id);
        const enUso = t.activo ? versionsEffectiveOn(vs, hoy)[0] : undefined;
        const siguiente = Math.max(0, ...vs.map((v) => v.version)) + 1;
        return (
          <div key={t.id} className={`bg-white rounded-lg border ${t.activo ? 'border-[#E4DCC8]' : 'border-dashed border-gray-300'}`}>
            <button onClick={() => setAbierta(abierta === t.id ? null : t.id)} className="w-full flex items-center gap-2 p-3 text-left text-sm flex-wrap">
              <ChevronDown className={`w-4 h-4 transition ${abierta === t.id ? 'rotate-180' : ''}`} />
              <span className={`font-semibold ${t.activo ? '' : 'text-gray-500'}`}>{t.nombre}</span>
              <span className="text-gray-600">{vs.length} versión{vs.length === 1 ? '' : 'es'}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${t.activo ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                {t.activo ? 'Activa' : `Inactiva${t.inactive_from ? ` desde ${fechaDMA(t.inactive_from)}` : ''}`}
              </span>
            </button>
            {abierta === t.id && (
              <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] space-y-3 pt-3">
                <div className="flex gap-2 flex-wrap items-center">
                  {t.activo && <button className={botonPrimario} onClick={() => setEditor({ tipo: 'modificar', receta: t })}><Pencil className="w-4 h-4 inline -mt-0.5" /> {vs.length ? 'Modificar ingredientes' : 'Cargar ingredientes'}</button>}
                  <button className={botonSecundario} disabled={m.active.isPending} onClick={() => m.active.mutate({ feedTypeId: t.id, active: !t.activo })}>{t.activo ? 'Desactivar' : 'Activar'}</button>
                  {t.activo && <button className={botonSecundario} onClick={() => setEditor({ tipo: 'batch', receta: t })}>Batch estándar: {kgTxt(t.standard_batch_kg)} · cambiar</button>}
                </div>
                {m.active.error ? <p className="text-xs text-red-700">No se pudo cambiar el estado.</p> : null}
                {t.activo && <p className="text-xs text-gray-600">{vs.length ? `Modificar ingredientes crea automáticamente la versión v${siguiente}. ` : ''}El batch estándar es el tamaño predeterminado en «Ver recetas»; cambiarlo no crea versión.</p>}
                {vs.length === 0 && <p className="text-sm text-[#8A7A5C]">Todavía no tiene ingredientes cargados.</p>}
                {vs.map((v) => (
                  <VersionItem key={v.id} v={v} enUso={v.id === enUso?.id} hoy={hoy} inactivaDesde={t.activo ? null : t.inactive_from}
                    lineas={(comp.data ?? []).filter((l) => l.formula_version_id === v.id)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <section>
        <Titulo>Historial de modificaciones</Titulo>
        {(historial.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin modificaciones.</p> : (
          <Tabla cabecera={<><th className={thL}>Fecha</th><th className={thL}>Quién</th><th className={thL}>Receta</th><th className={thL}>Qué cambió</th></>}>
            {(historial.data ?? []).map((h) => (
              <tr key={h.id}>
                <td className={`${td} whitespace-nowrap`}>{new Date(h.performed_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td className={td}>{h.performed_by_name ?? '—'}</td><td className={`${td} font-semibold`}>{h.feed_type_nombre ?? '—'}</td>
                <td className={td}>{describirCambio(h)}</td>
              </tr>
            ))}
          </Tabla>
        )}
      </section>

      {editor?.tipo === 'batch' && <BatchModal receta={editor.receta} onClose={() => setEditor(null)} />}
      {editor?.tipo === 'receta' && <RecetaModal onClose={() => setEditor(null)} />}
      {editor?.tipo === 'modificar' && <RecetaModal receta={editor.receta} base={versionsEffectiveOn(delTipo(editor.receta.id), hoy)[0] ?? delTipo(editor.receta.id)[0]}
        ultimaDesde={delTipo(editor.receta.id)[0]?.effective_from} onClose={() => setEditor(null)} />}
    </div>
  );
}

type LineaJson = { ingredient_id: string; quantity_kg: number; section: FormulaSection };
/** One history row in words. PUBLISH lists what changed against the previous version (names resolved by the caller's ingredients). */
function describirCambio(h: RecipeChange): string {
  const a = h.after_values ?? {}; const b = h.before_values ?? {};
  switch (h.action) {
    case 'PUBLISH': {
      const prev = new Map(((a.previous_lines as LineaJson[] | null) ?? []).map((l) => [l.ingredient_id, l]));
      const nuevas = (a.lines as LineaJson[] | null) ?? [];
      const cambios = nuevas.filter((l) => prev.get(l.ingredient_id)?.quantity_kg !== l.quantity_kg || prev.get(l.ingredient_id)?.section !== l.section).length;
      const quitados = [...prev.keys()].filter((id) => !nuevas.some((l) => l.ingredient_id === id)).length;
      const desde = typeof a.effective_from === 'string' ? fechaDMA(a.effective_from) : '';
      return `Versión v${a.version} desde ${desde}${prev.size ? `: ${cambios} ingrediente(s) nuevo(s) o modificado(s)${quitados ? `, ${quitados} quitado(s)` : ''}` : ' (primera)'}${a.comment ? ` · «${a.comment}»` : ''}`;
    }
    case 'COMMENT': return `Comentario de v${a.version}: «${b.comment ?? '—'}» → «${a.comment ?? '—'}»`;
    case 'STANDARD_BATCH': return `Batch estándar: ${b.standard_batch_kg} → ${a.standard_batch_kg} kg (sin versión nueva)`;
    case 'DEACTIVATE': return `Desactivada desde ${typeof a.inactive_from === 'string' ? fechaDMA(a.inactive_from) : ''}`;
    case 'ACTIVATE': return 'Activada';
    default: return h.action;
  }
}

function VersionItem({ v, enUso, hoy, inactivaDesde, lineas }: { v: FormulaVersionRow; enUso: boolean; hoy: string; inactivaDesde: string | null; lineas: FormulaLineRow[] }) {
  const m = useAlimentoMutations();
  const [ver, setVer] = useState(enUso);
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(v.comment ?? '');
  const batch = lineas.reduce((s, l) => s + l.quantity_kg, 0);
  const hasta = v.effective_to ? fechaDMA(v.effective_to) : inactivaDesde ? `inactiva desde ${fechaDMA(inactivaDesde)}` : v.effective_from > hoy ? 'próxima' : 'hoy';
  return (
    <div className={`bg-white rounded-lg border text-sm ${enUso ? 'border-amber-500' : 'border-[#E4DCC8]'}`}>
      <button onClick={() => setVer(!ver)} className="w-full flex items-center gap-2 px-3 py-2 text-left flex-wrap">
        <ChevronDown className={`w-4 h-4 transition ${ver ? 'rotate-180' : ''}`} />
        <span className="font-semibold">Versión {v.version}</span>
        <span className="text-gray-600">vigente {fechaDMA(v.effective_from)} → {hasta}</span>
        {enUso && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">En uso</span>}
        <span className="ml-auto text-xs text-gray-500">Ingredientes</span>
      </button>
      <div className="px-3 pb-2 -mt-1 text-xs">
        {editando ? (
          <div className="flex gap-2 items-center flex-wrap">
            <input type="text" autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Comentario de la versión" className="flex-1 min-w-48 border border-gray-300 rounded px-2 py-1" />
            <button className="text-[#A8552E] font-semibold hover:underline disabled:opacity-50" disabled={texto.trim() === (v.comment ?? '') || m.comment.isPending}
              onClick={() => m.comment.mutate({ formulaVersionId: v.id, comment: texto }, { onSuccess: () => setEditando(false) })}>Guardar</button>
            <button className="text-gray-600 hover:underline" onClick={() => { setTexto(v.comment ?? ''); setEditando(false); }}>Cancelar</button>
            {m.comment.error ? <span className="text-red-700">No se pudo guardar.</span> : null}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-gray-700">
            {v.comment ? <span className="italic">«{v.comment}»</span> : <span className="text-gray-400">Sin comentario</span>}
            <button aria-label="Editar comentario" title={v.comment ? 'Editar comentario' : 'Agregar comentario'} onClick={() => setEditando(true)}
              className="text-[#A8552E] hover:text-[#8B4423] inline-flex items-center gap-0.5"><Pencil className="w-3.5 h-3.5" />{v.comment ? '' : ' agregar'}</button>
          </p>
        )}
      </div>
      {ver && (
        <div className="px-3 pb-3">
          {lineas.length === 0 ? <p className="text-xs text-gray-500">Cargando ingredientes…</p> : <IngredientesTabla lineas={lineas} batch={batch} titulo={`Kg para batch de ${kgTxt(batch)}`} />}
        </div>
      )}
    </div>
  );
}

function IngredientesTabla({ lineas, batch, titulo, otra }: { lineas: FormulaLineRow[]; batch: number; titulo: string; otra?: { titulo: string; lineas: FormulaLineRow[] } }) {
  return (
    <Tabla cabecera={<><th className={thL}>Ingrediente</th><th className={thR}>%</th><th className={thR}>{titulo}</th>{otra && <th className={thR}>{otra.titulo}</th>}</>}>
      {SECCIONES.flatMap((s) => {
        const ls = lineas.filter((l) => l.section === s.id);
        return [
          <tr key={s.id} className="bg-[#FAF6EE]">
            <td className={`${td} text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]`} colSpan={2}>{s.label}</td>
            <td className={`${tdR} text-xs text-gray-600`}>{ls.length ? kgLinea(ls.reduce((t, l) => t + l.quantity_kg, 0), s.id) : '—'}</td>{otra && <td />}
          </tr>,
          ...ls.map((l) => (
            <tr key={`${s.id}-${l.ingredient_id}`}>
              <td className={`${td} pl-6`}>{l.ingredient_name}</td><td className={tdR}>{pctLinea(l.quantity_kg, batch, s.id)}</td>
              <td className={`${tdR} tabular-nums`}>{kgLinea(l.quantity_kg, s.id)}</td>
              {otra && <td className={`${tdR} tabular-nums`}>{kgLinea(otra.lineas.find((x) => x.ingredient_id === l.ingredient_id)?.quantity_kg ?? 0, s.id)}</td>}
            </tr>
          )),
        ];
      })}
    </Tabla>
  );
}

function BatchModal({ receta, onClose }: { receta: FeedTypeRow; onClose: () => void }) {
  const m = useAlimentoMutations();
  const [kg, setKg] = useState(String(receta.standard_batch_kg));
  const n = Number(kg);
  return (
    <Modal titulo={`Tamaño estándar del batch — ${receta.nombre}`} onClose={onClose} guardando={m.batch.isPending} error={m.batch.error}
      puedeGuardar={n > 0 && n !== receta.standard_batch_kg} onSubmit={() => m.batch.mutate({ feedTypeId: receta.id, kg: n }, { onSuccess: onClose })}>
      <p className="text-sm text-gray-700">Es el tamaño que aparece por defecto en «Ver recetas» y en Nueva fabricación. Las proporciones no cambian y no se crea una versión nueva.</p>
      <label className={etiqueta}>Tamaño estándar del batch (kg)<input type="number" min="1" value={kg} onChange={(e) => setKg(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

type Fila = { ingredientId: string; kg: string; section: FormulaSection };
/** New recipe (feed type + v1) or «Modificar ingredientes» (publishes the next version from the one in use). */
function RecetaModal({ receta, base, ultimaDesde, onClose }: { receta?: FeedTypeRow; base?: FormulaVersionRow; ultimaDesde?: string; onClose: () => void }) {
  const m = useAlimentoMutations();
  const crearTipo = useMasterMutations('feed_type').create;
  const ingredientes = useMasterList<Ingrediente>('feed_ingredient');
  const categorias = useMasterList<ExpenseCategoryRow>('expense_category');
  const comp = useComposition(base ? [base.id] : []);
  const hoy = getTodayDate();
  const [nombre, setNombre] = useState('');
  const [batch, setBatch] = useState('200');
  const [desde, setDesde] = useState(hoy);
  const [comentario, setComentario] = useState('');
  const [filas, setFilas] = useState<Fila[] | null>(receta ? null : [{ ingredientId: '', kg: '', section: 'PREMIX' }, { ingredientId: '', kg: '', section: 'MACRO' }]);
  const actuales = (comp.data ?? []).filter((l) => l.formula_version_id === base?.id);
  const lineas: Fila[] = filas ?? actuales.map((l) => ({ ingredientId: l.ingredient_id, kg: String(l.quantity_kg), section: l.section }));
  const setL = (i: number, p: Partial<Fila>) => setFilas(lineas.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const completas = lineas.filter((l) => l.ingredientId && Number(l.kg) > 0);
  const repetido = new Set(completas.map((l) => l.ingredientId)).size !== completas.length;
  const sinCambios = !!receta && actuales.length > 0 && completas.length === actuales.length
    && completas.every((l) => actuales.some((a) => a.ingredient_id === l.ingredientId && a.quantity_kg === Number(l.kg) && a.section === l.section));
  const fechaOk = !ultimaDesde || desde > ultimaDesde;
  const puede = (!!receta || (nombre.trim() !== '' && Number(batch) > 0)) && completas.length > 0 && completas.length === lineas.length && !repetido && !sinCambios && fechaOk;
  // the ingredients offered = the feed ingredients of the ACTIVE expense subcategories marked «insumo» (Categorías de gasto), named as
  // the subcategory; an ingredient the version being modified already uses stays selectable
  const enUsoIds = new Set(actuales.map((l) => l.ingredient_id));
  const vinculados = new Map((categorias.data ?? []).filter((c) => c.activo && c.feed_ingredient_id).map((c) => [c.feed_ingredient_id as string, c.nombre]));
  const activos = (ingredientes.data ?? []).filter((x) => (x.activo && vinculados.has(x.id)) || enUsoIds.has(x.id))
    .map((x) => ({ ...x, nombre: vinculados.get(x.id) ?? x.nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const error = m.publish.error ?? crearTipo.error ?? m.batch.error;
  const guardar = async () => {
    const lines = completas.map((l) => ({ ingredientId: l.ingredientId, quantityKg: Number(l.kg), section: l.section }));
    let feedTypeId = receta?.id;
    if (!feedTypeId) {
      const creado = await crearTipo.mutateAsync({ nombre: nombre.trim(), feed_category: 'LAYER' }) as { id: string };
      feedTypeId = creado.id;
      if (Number(batch) !== 200) await m.batch.mutateAsync({ feedTypeId, kg: Number(batch) });
    }
    await m.publish.mutateAsync({ feedTypeId, effectiveFrom: desde, lines, comment: comentario });
    onClose();
  };
  return (
    <Modal titulo={receta ? `Modificar ingredientes — ${receta.nombre}` : 'Nueva receta'} onClose={onClose} guardando={m.publish.isPending || crearTipo.isPending}
      error={error} puedeGuardar={puede} textoGuardar={receta && base ? `Crear versión v${base.version + 1}` : 'Guardar'} onSubmit={() => { void guardar().catch(() => undefined); }}>
      {receta && base && <p className="text-sm text-amber-900 bg-amber-50 rounded px-2 py-1">Partís de la versión v{base.version}. Al guardar se crea una versión nueva; la anterior queda en el historial hasta el día anterior.</p>}
      {!receta && <label className={etiqueta}>Nombre<input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} className={campo} placeholder="Ej: Ponedoras - Pre postura" /></label>}
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Vigente desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={campo} /></label>
        {!receta && <label className={etiqueta}>Batch estándar (kg)<input type="number" min="1" value={batch} onChange={(e) => setBatch(e.target.value)} className={campo} /></label>}
      </div>
      {receta && !filas && comp.isLoading && <p className="text-xs text-gray-500">Cargando la versión actual…</p>}
      {SECCIONES.map((s) => {
        const otra = SECCIONES.find((x) => x.id !== s.id)!;
        const propias = lineas.map((l, i) => ({ l, i })).filter(({ l }) => l.section === s.id);
        return (
          <fieldset key={s.id} className="border border-[#E4DCC8] rounded-lg p-2 space-y-2">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">{s.label} · {kgLinea(propias.reduce((t, { l }) => t + (Number(l.kg) || 0), 0), s.id)}</legend>
            {propias.length === 0 && <p className="text-xs text-gray-400">Sin ingredientes.</p>}
            {propias.map(({ l, i }) => (
              <div key={i} className="grid grid-cols-[1fr_6.5rem_auto] gap-2 items-end">
                <label className={etiqueta}>Ingrediente
                  <select value={l.ingredientId} onChange={(e) => setL(i, { ingredientId: e.target.value })} className={campo}>
                    <option value="">Elegir…</option>
                    {activos.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                  </select>
                </label>
                <label className={etiqueta}>Kg<input type="number" min="0" step={s.id === 'PREMIX' ? '0.001' : '0.01'} value={l.kg} placeholder={s.id === 'PREMIX' ? '0,290' : ''}
                  onChange={(e) => setL(i, { kg: e.target.value })} className={campo} /></label>
                <span className="flex flex-col items-start pb-1 gap-0.5">
                  <button type="button" onClick={() => setL(i, { section: otra.id })} className="text-[11px] text-[#A8552E] hover:underline whitespace-nowrap">→ {otra.label}</button>
                  <button type="button" onClick={() => setFilas(lineas.filter((_, j) => j !== i))} disabled={lineas.length === 1} className="text-[11px] text-red-700 hover:underline disabled:opacity-40">Quitar</button>
                </span>
              </div>
            ))}
            <button type="button" onClick={() => setFilas([...lineas, { ingredientId: '', kg: '', section: s.id }])} className="text-xs text-[#A8552E] hover:underline">+ Agregar a {s.label}</button>
          </fieldset>
        );
      })}
      <p className="text-xs text-gray-600">Total del batch: {kgLinea(completas.reduce((t, l) => t + Number(l.kg), 0), 'PREMIX')}</p>
      <label className={etiqueta}>Comentario de la versión (opcional)<input type="text" value={comentario} onChange={(e) => setComentario(e.target.value)} className={campo} /></label>
      {repetido && <p className="text-xs text-red-700">Hay un ingrediente repetido.</p>}
      {sinCambios && <p className="text-xs text-red-700">No hay cambios en los ingredientes.</p>}
      {!fechaOk && ultimaDesde && <p className="text-xs text-red-700">La fecha debe ser posterior al {fechaDMA(ultimaDesde)} (inicio de la última versión).</p>}
      {activos.length === 0 && <p className="text-sm text-amber-800">No hay insumos de alimento: marcalos en Administración → Categorías de gasto («Marcar insumos de alimento»).</p>}
    </Modal>
  );
}
