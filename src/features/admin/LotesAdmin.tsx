import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { FlockRow, ShedRow, SupplierRow } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { MasterEditor } from './MasterEditor';
import { useFlockLifecycle, useFlocks, useMasterList } from './useMasters';

const ESTADO_LABEL: Record<FlockRow['estado'], string> = { ACTIVE: 'Activo', RETIRED: 'Retirado', ARCHIVED: 'Archivado' };
const emptyForm = () => ({ shedId: '', entryDate: getTodayDate(), initialPopulation: '', geneticsLine: '', birthDate: '', supplierId: '' });

/**
 * Target `sheds` (ADMIN master, editable) and `flocks`. Flocks have no direct write grant: they are registered and
 * closed only through RPC 44 register_flock / RPC 45 close_flock (ADR-007), which validate the dates, the
 * one-ACTIVE-flock-per-shed rule, the period and the recorded activity. The pullet purchase link (`purchase_id`)
 * stays optional in the RPC and is not offered here: choosing a purchase belongs to the purchases screens (F27-D).
 */
export function LotesAdmin() {
  const galpones = useMasterList<ShedRow>('sheds');
  const proveedores = useMasterList<SupplierRow>('suppliers');
  const flocks = useFlocks();
  const { register, close } = useFlockLifecycle();
  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [salida, setSalida] = useState<{ flock: FlockRow; fecha: string; motivo: string } | null>(null);

  const nombreGalpon = (id: string) => galpones.data?.find((s) => s.id === id)?.nombre ?? '—';
  const activos = (flocks.data ?? []).filter((f) => f.estado === 'ACTIVE');
  const otros = (flocks.data ?? []).filter((f) => f.estado !== 'ACTIVE');
  const galponesActivos = (galpones.data ?? []).filter((s) => s.activo);
  const proveedoresActivos = (proveedores.data ?? []).filter((s) => s.activo);
  const formOk = form.shedId !== '' && form.entryDate !== '' && form.initialPopulation.trim() !== '';

  const guardarLote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formOk) return;
    register.mutate(
      { shedId: form.shedId, entryDate: form.entryDate, initialPopulation: Number(form.initialPopulation), geneticsLine: form.geneticsLine,
        birthDate: form.birthDate, supplierId: form.supplierId, reason: null },
      { onSuccess: () => { setForm(emptyForm()); setMostrarFormulario(false); } },
    );
  };
  const confirmarSalida = () => {
    if (!salida || !salida.fecha) return;
    close.mutate({ flockId: salida.flock.id, exitDate: salida.fecha, reason: salida.motivo }, { onSuccess: () => setSalida(null) });
  };

  const input = 'w-full border border-amber-300 rounded px-3 py-2';
  const Lote = ({ f }: { f: FlockRow }) => (
    <div className={`border rounded-lg p-4 ${f.estado === 'ACTIVE' ? 'bg-white border-amber-200' : 'bg-gray-50 border-gray-200 opacity-75'}`}>
      <div className="flex justify-between items-start gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-bold text-amber-900">{nombreGalpon(f.shed_id)}</h4>
            <span className={`text-xs px-2 py-1 rounded ${f.estado === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
              {ESTADO_LABEL[f.estado]}
            </span>
          </div>
          <p className="text-sm text-gray-600">
            Entrada: {formatearFechaLocal(f.entry_date)} • {Number(f.initial_population).toLocaleString('es-AR')} aves iniciales
            {f.exit_date ? ` • Salida: ${formatearFechaLocal(f.exit_date)}` : ''}
          </p>
          {f.genetics_line && <p className="text-sm text-gray-600">Línea: {f.genetics_line}</p>}
        </div>
        {f.estado === 'ACTIVE' && (
          <button onClick={() => { close.reset(); setSalida({ flock: f, fecha: getTodayDate(), motivo: '' }); }}
            className="bg-red-100 text-red-600 hover:bg-red-200 px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1">
            <Check className="w-4 h-4" />
            Marcar salida
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <MasterEditor
        table="sheds"
        title="Galpones"
        fields={[
          { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Ej: Galpón 1' },
          { key: 'capacidad', label: 'Capacidad (aves)', type: 'number', placeholder: 'Capacidad (opcional)' },
        ]}
      />

      <div className="px-6 pb-6 space-y-6">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-bold text-amber-900">Lotes</h3>
          <button onClick={() => { register.reset(); setMostrarFormulario(!mostrarFormulario); }}
            className="bg-amber-600 text-white px-4 py-2 rounded-lg hover:bg-amber-700 font-medium">
            {mostrarFormulario ? 'Cancelar' : '+ Nuevo lote'}
          </button>
        </div>

        {mostrarFormulario && (
          <form onSubmit={guardarLote} className="p-4 border border-amber-200 rounded-lg bg-amber-50 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="block text-sm font-medium text-gray-700">Galpón
                <select value={form.shedId} onChange={(e) => setForm({ ...form, shedId: e.target.value })} className={`${input} mt-1`} required>
                  <option value="">Elegir galpón…</option>
                  {galponesActivos.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium text-gray-700">Fecha de entrada
                <input type="date" value={form.entryDate} max={getTodayDate()} onChange={(e) => setForm({ ...form, entryDate: e.target.value })} className={`${input} mt-1`} required />
              </label>
              <label className="block text-sm font-medium text-gray-700">Aves iniciales
                <input type="number" min={0} value={form.initialPopulation} onChange={(e) => setForm({ ...form, initialPopulation: e.target.value })}
                  placeholder="1000" className={`${input} mt-1`} required />
              </label>
              <label className="block text-sm font-medium text-gray-700">Línea genética
                <input type="text" value={form.geneticsLine} onChange={(e) => setForm({ ...form, geneticsLine: e.target.value })}
                  placeholder="Hy-Line Brown" className={`${input} mt-1`} />
              </label>
              <label className="block text-sm font-medium text-gray-700">Fecha de nacimiento
                <input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} className={`${input} mt-1`} />
              </label>
              <label className="block text-sm font-medium text-gray-700">Proveedor
                <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} className={`${input} mt-1`}>
                  <option value="">Sin proveedor</option>
                  {proveedoresActivos.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
              </label>
            </div>
            {register.error && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(register.error)}</div>}
            <button type="submit" disabled={register.isPending || !formOk}
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:bg-gray-400 font-medium">
              {register.isPending ? 'Guardando...' : 'Guardar lote'}
            </button>
          </form>
        )}

        {flocks.isLoading ? (
          <p className="text-gray-500 text-sm">Cargando lotes...</p>
        ) : flocks.error ? (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(flocks.error)}</div>
        ) : (
          <>
            <div>
              <h4 className="font-semibold text-amber-900 mb-2">Activos ({activos.length})</h4>
              {activos.length === 0 ? <p className="text-gray-500 text-sm">No hay lotes activos</p>
                : <div className="space-y-3">{activos.map((f) => <Lote key={f.id} f={f} />)}</div>}
            </div>
            {otros.length > 0 && (
              <div>
                <h4 className="font-semibold text-gray-700 mb-2">Retirados / archivados ({otros.length})</h4>
                <div className="space-y-2">{otros.map((f) => <Lote key={f.id} f={f} />)}</div>
              </div>
            )}
          </>
        )}
      </div>

      {salida && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-sm w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900">Marcar salida — {nombreGalpon(salida.flock.shed_id)}</h3>
              <button onClick={() => setSalida(null)} className="text-gray-400 hover:text-gray-600"><X size={22} /></button>
            </div>
            <div className="space-y-4">
              <label className="block text-sm font-medium text-gray-700">Fecha de salida
                <input type="date" value={salida.fecha} min={salida.flock.entry_date} max={getTodayDate()}
                  onChange={(e) => setSalida({ ...salida, fecha: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 mt-1" />
              </label>
              <label className="block text-sm font-medium text-gray-700">Motivo
                <input type="text" value={salida.motivo} onChange={(e) => setSalida({ ...salida, motivo: e.target.value })}
                  placeholder="Ej: venta de gallinas de descarte" className="w-full border border-gray-300 rounded-lg px-3 py-2 mt-1" />
              </label>
              <p className="text-xs text-gray-500">Al marcar la salida, las asignaciones de operadores del lote quedan inactivas.</p>
              {close.error && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(close.error)}</div>}
              <div className="flex gap-3 justify-end">
                <button onClick={() => setSalida(null)} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium">Cancelar</button>
                <button onClick={confirmarSalida} disabled={close.isPending || !salida.fecha}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:bg-gray-400 font-medium">
                  {close.isPending ? 'Guardando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
