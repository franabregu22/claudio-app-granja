import { useState } from 'react';
import { Plus } from 'lucide-react';
import { versionsEffectiveOn, type FeedTypeRow, type FormulaVersionRow } from '../../target/feed';
import { UNIT_TYPES, type UnitType } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useFormulaComposition, useFormulaVersions, usePublishFormula } from '../production/useProduction';
import { MasterEditor } from './MasterEditor';
import { useMasterList } from './useMasters';

const CATEGORIA: Record<FeedTypeRow['feed_category'], string> = { LAYER: 'Ponedoras', PULLET: 'Recría', BROILER: 'Parrilleros', INPUT: 'Insumo' };
const UNIDAD: Record<UnitType, string> = { KG: 'Kg', TON: 'Tonelada', LITER: 'Litro', UNIT: 'Unidad', CARTON: 'Maple' };
type Seccion = 'tipos' | 'ingredientes' | 'formulas';

/**
 * Administración → Alimento (ADR-013, owner D-FEED-3). Feed types and ingredients are ADMIN masters (direct INSERT /
 * UPDATE, deactivate instead of delete). Formulas are versions of a feed type: they are only published through
 * RPC 48 publish_feed_formula_version (atomic; the previous version closes the day before). A published version is
 * never edited: a change is a new version.
 */
export function AlimentoAdmin() {
  const [seccion, setSeccion] = useState<Seccion>('formulas');
  const tabs: { id: Seccion; label: string }[] = [
    { id: 'tipos', label: 'Tipos de alimento' }, { id: 'ingredientes', label: 'Ingredientes' }, { id: 'formulas', label: 'Fórmulas / Recetas' },
  ];
  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex gap-2 flex-wrap">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setSeccion(t.id)}
            className={`text-sm px-3 py-1.5 rounded-lg ${seccion === t.id ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {seccion === 'tipos' && (
        <MasterEditor table="feed_type" title="Tipos de alimento" fields={[
          { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Ej: Ponedoras 18+ semanas' },
          { key: 'feed_category', label: 'Categoría', type: 'select', options: Object.entries(CATEGORIA).map(([value, label]) => ({ value, label })) },
        ]} />
      )}
      {seccion === 'ingredientes' && <Ingredientes />}
      {seccion === 'formulas' && <Formulas />}
    </div>
  );
}

function Ingredientes() {
  const proveedores = useMasterList<{ id: string; nombre: string; activo: boolean }>('suppliers');
  return (
    <MasterEditor table="feed_ingredient" title="Ingredientes" fields={[
      { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Ej: Maíz' },
      { key: 'unit_type', label: 'Unidad', type: 'select', options: UNIT_TYPES.map((u) => ({ value: u, label: UNIDAD[u] })) },
      { key: 'supplier_id', label: 'Proveedor', type: 'select', options: [{ value: '', label: 'Sin proveedor' },
        ...(proveedores.data ?? []).filter((p) => p.activo).map((p) => ({ value: p.id, label: p.nombre }))] },
    ]} />
  );
}

function Formulas() {
  const tipos = useMasterList<FeedTypeRow>('feed_type');
  const versiones = useFormulaVersions();
  const [tipoId, setTipoId] = useState('');
  const [nueva, setNueva] = useState(false);
  const hoy = getTodayDate();
  const delTipo = (versiones.data ?? []).filter((v) => v.feed_type_id === tipoId).sort((a, b) => b.version - a.version);
  const composicion = useFormulaComposition(delTipo.map((v) => v.id));
  const vigente = versionsEffectiveOn(delTipo, hoy)[0];
  const tipo = (tipos.data ?? []).find((t) => t.id === tipoId);

  if (tipos.isLoading || versiones.isLoading) return <p className="text-sm text-gray-500">Cargando fórmulas…</p>;
  const error = tipos.error ?? versiones.error ?? composicion.error;
  return (
    <div className="space-y-4 max-w-2xl">
      {error ? <p className="text-sm text-red-700">{errorMessage(error)}</p> : null}
      {(tipos.data ?? []).length === 0 && <p className="text-sm text-amber-800">Primero creá un tipo de alimento en "Tipos de alimento".</p>}
      <label className={etiqueta}>Tipo de alimento
        <select value={tipoId} onChange={(e) => setTipoId(e.target.value)} className={campo}>
          <option value="">Elegir…</option>
          {(tipos.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.nombre}{t.activo ? '' : ' (inactivo)'}</option>)}
        </select>
      </label>
      {tipo && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-amber-900">
              {vigente ? `Fórmula vigente: versión ${vigente.version}` : 'Sin fórmula vigente hoy'}
            </p>
            <button onClick={() => setNueva(true)} disabled={!tipo.activo}
              className="flex items-center gap-1 text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50">
              <Plus className="w-4 h-4" /> Nueva versión
            </button>
          </div>
          {delTipo.length === 0 && <p className="text-sm text-[#8A7A5C]">Este tipo todavía no tiene fórmulas.</p>}
          {delTipo.map((v) => (
            <div key={v.id} className={`bg-white rounded-lg border p-3 text-sm ${v.id === vigente?.id ? 'border-amber-500' : 'border-[#E4DCC8]'}`}>
              <p className="font-semibold">Versión {v.version}{v.id === vigente?.id ? ' · vigente' : ''}</p>
              <p className="text-xs text-gray-600">Desde {v.effective_from}{v.effective_to ? ` hasta ${v.effective_to}` : ' (sin fecha de fin)'}</p>
              {(composicion.data ?? []).filter((l) => l.formula_version_id === v.id).map((l) => (
                <p key={l.ingredient_id}>{l.ingredient_name} — {l.quantity_kg} kg</p>
              ))}
            </div>
          ))}
        </>
      )}
      {nueva && tipo && <NuevaVersionModal tipo={tipo} ultima={delTipo[0]} onClose={() => setNueva(false)} />}
    </div>
  );
}

/** D-FEED-4: composition in kg (the formula-line unit), published atomically by RPC 48; the previous version closes automatically. */
function NuevaVersionModal({ tipo, ultima, onClose }: { tipo: FeedTypeRow; ultima?: FormulaVersionRow; onClose: () => void }) {
  const publicar = usePublishFormula();
  const ingredientes = useMasterList<{ id: string; nombre: string; activo: boolean }>('feed_ingredient');
  const [desde, setDesde] = useState(getTodayDate());
  const [lineas, setLineas] = useState<{ ingredientId: string; kg: string }[]>([{ ingredientId: '', kg: '' }]);
  const activos = (ingredientes.data ?? []).filter((i) => i.activo);
  const set = (i: number, patch: Partial<{ ingredientId: string; kg: string }>) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const completas = lineas.filter((l) => l.ingredientId !== '' && Number(l.kg) > 0);
  const puede = desde !== '' && completas.length > 0 && completas.length === lineas.length;
  return (
    <Modal titulo={`Nueva versión — ${tipo.nombre}`} onClose={onClose} textoGuardar="Publicar versión" puedeGuardar={puede}
      guardando={publicar.isPending} error={publicar.error ?? ingredientes.error}
      onSubmit={() => publicar.mutate({ feedTypeId: tipo.id, effectiveFrom: desde, lines: completas.map((l) => ({ ingredientId: l.ingredientId, quantityKg: Number(l.kg) })) },
        { onSuccess: onClose })}>
      <label className={etiqueta}>Vigente desde
        <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={campo} />
      </label>
      {ultima && <p className="text-xs text-gray-600">La versión {ultima.version} (desde {ultima.effective_from}) se cierra automáticamente el día anterior.</p>}
      {activos.length === 0 && <p className="text-sm text-amber-800">No hay ingredientes activos. Crealos en "Ingredientes".</p>}
      {lineas.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-2 items-end">
          <label className={etiqueta}>Ingrediente
            <select value={l.ingredientId} onChange={(e) => set(i, { ingredientId: e.target.value })} className={campo}>
              <option value="">Elegir…</option>
              {activos.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
          </label>
          <label className={etiqueta}>Cantidad (kg)
            <input type="number" min="0" step="0.001" value={l.kg} onChange={(e) => set(i, { kg: e.target.value })} className={campo} />
          </label>
          <button type="button" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))} disabled={lineas.length === 1}
            className="text-xs text-red-700 hover:underline disabled:opacity-40 pb-2">Quitar</button>
        </div>
      ))}
      <button type="button" onClick={() => setLineas((ls) => [...ls, { ingredientId: '', kg: '' }])} className="text-xs text-[#A8552E] hover:underline">+ Agregar ingrediente</button>
      <p className="text-xs text-gray-500">Una versión publicada no se edita: para cambiar la receta se publica una versión nueva.</p>
    </Modal>
  );
}
