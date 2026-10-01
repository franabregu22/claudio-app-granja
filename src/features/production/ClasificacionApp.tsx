import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { describeLine, ENTRY_UNITS, type ClassificationLineInput, type ClassificationSession, type EntryUnit, type GradeRow } from '../../target/classification';
import { errorMessage } from '../../target/messages';
import { shiftDate } from '../../target/production';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useClassificationDays, useClassificationSessions, useGrades, useRectifyClassification, useRegisterClassification } from './useProduction';

const DIAS = 14;
const hora = (ts: string) => new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

type Entrada = Record<string, { cantidad: string; unidad: EntryUnit }>;
const lineasDe = (entrada: Entrada): ClassificationLineInput[] => Object.entries(entrada)
  .filter(([, v]) => v.cantidad !== '')
  .map(([id, v]) => ({ classification_grade_id: id, quantity: Math.trunc(Number(v.cantidad)), unit: v.unidad }));

/** Quantity + unit per grade. The unit is always visible; nothing is converted here (ADR-012). */
function GradosInput({ grados, entrada, onChange }: { grados: GradeRow[]; entrada: Entrada; onChange: (e: Entrada) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {grados.map((g) => {
        const v = entrada[g.id] ?? { cantidad: '', unidad: 'UNIDAD' as EntryUnit };
        return (
          <div key={g.id} className="block text-sm font-medium text-gray-700">
            <span>{g.nombre}</span>
            <div className="flex gap-2 mt-1">
              <input type="number" inputMode="numeric" min="0" aria-label={`${g.nombre} cantidad`} value={v.cantidad} onFocus={(e) => e.target.select()}
                onChange={(e) => onChange({ ...entrada, [g.id]: { ...v, cantidad: e.target.value } })}
                className="w-full border border-gray-300 rounded px-3 py-2 text-lg" />
              <select aria-label={`${g.nombre} unidad`} value={v.unidad} onChange={(e) => onChange({ ...entrada, [g.id]: { ...v, unidad: e.target.value as EntryUnit } })}
                className="border border-gray-300 rounded px-2 py-2">
                {ENTRY_UNITS.map((u) => <option key={u} value={u}>{u === 'MAPLE' ? 'Maples' : 'Unidades'}</option>)}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Clasificación (F27-E; ADR-012 block 4; ADMIN and OPERATOR). Each save is one independent session
 * (register_classification, one idempotency key per opened form). Quantities are entered as UNIDAD or MAPLE and the
 * backend converts to eggs. The day's sessions are listed individually with their exact entry; a current session can
 * be rectified (rectify_classification, mandatory reason). The daily summary is report_classification_day as reported.
 */
export function ClasificacionApp() {
  const hoy = getTodayDate();
  const grados = useGrades();
  const resumen = useClassificationDays(shiftDate(hoy, -DIAS), hoy);
  const registrar = useRegisterClassification();
  const [fecha, setFecha] = useState(hoy);
  const [entrada, setEntrada] = useState<Entrada>({});
  const [lugar, setLugar] = useState('');
  const [notas, setNotas] = useState('');
  const [clave, setClave] = useState(() => crypto.randomUUID());   // idempotency: one per session form
  const [ok, setOk] = useState<number | null>(null);
  const [dia, setDia] = useState(hoy);

  const lineas = lineasDe(entrada);
  const puede = fecha !== '' && lineas.length > 0 && !registrar.isPending;

  function guardar() {
    registrar.mutate({ idempotencyKey: clave, date: fecha, lines: lineas, location: lugar, reason: notas }, {
      onSuccess: (r) => { setEntrada({}); setNotas(''); setClave(crypto.randomUUID()); setOk((r as { total_quantity: number }).total_quantity); setDia(fecha); },
    });
  }

  const porDia = new Map<string, NonNullable<typeof resumen.data>>();
  for (const r of resumen.data ?? []) porDia.set(r.business_date, [...(porDia.get(r.business_date) ?? []), r]);

  return (
    <div className="min-h-screen bg-[#FAF6EE] px-4 md:px-6 pt-6 pb-20 space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
        <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Clasificación</h1>
      </div>

      <div className="bg-white p-5 rounded-lg border border-amber-200 space-y-4 max-w-2xl">
        <p className="text-sm font-semibold text-amber-900">Nueva sesión de clasificación</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-gray-700">Fecha
            <input type="date" value={fecha} onChange={(e) => { setFecha(e.target.value); setOk(null); }} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
          </label>
          <label className="block text-sm font-medium text-gray-700">Lugar (opcional)
            <input type="text" value={lugar} onChange={(e) => setLugar(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
          </label>
        </div>
        {grados.isLoading ? <p className="text-sm text-gray-500">Cargando clasificaciones…</p> : (grados.data ?? []).length === 0 ? (
          <p className="text-sm text-amber-800">No hay clasificaciones activas. Un administrador debe cargarlas.</p>
        ) : (
          <GradosInput grados={grados.data ?? []} entrada={entrada} onChange={(e) => { setEntrada(e); setOk(null); }} />
        )}
        <label className="block text-sm font-medium text-gray-700">Notas (opcional)
          <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 mt-1" />
        </label>
        {(registrar.error || grados.error) ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(registrar.error ?? grados.error)}</div> : null}
        {ok !== null && <p className="text-sm text-green-700">Sesión registrada: {ok} huevos.</p>}
        <button onClick={guardar} disabled={!puede} className="w-full bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium disabled:opacity-50">
          {registrar.isPending ? 'Guardando...' : 'Guardar sesión'}
        </button>
      </div>

      <SesionesDelDia dia={dia} onDia={setDia} grados={grados.data ?? []} />

      <div>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Últimos {DIAS} días</p>
        {resumen.error ? <p className="text-sm text-red-700">{errorMessage(resumen.error)}</p> : porDia.size === 0 ? (
          <p className="text-sm text-[#8A7A5C]">Sin clasificaciones en el período.</p>
        ) : (
          <div className="space-y-2">
            {[...porDia.entries()].map(([d, rows]) => (
              <button key={d} onClick={() => setDia(d)} className="w-full text-left bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm hover:border-amber-400">
                <p className="font-semibold text-amber-900">{d} · total {rows[0].day_total} huevos · {rows[0].day_sessions} sesión(es)</p>
                <p className="text-gray-700">{rows.map((r) => `${r.grade_nombre}: ${r.quantity} (${r.share_pct.toFixed(1)}%)`).join(' · ')}</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** D-CLS-4: every session of the selected day, collapsed; the detail shows the exact entry and the rectification history. */
function SesionesDelDia({ dia, onDia, grados }: { dia: string; onDia: (d: string) => void; grados: GradeRow[] }) {
  const sesiones = useClassificationSessions(dia);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [rectificando, setRectificando] = useState<ClassificationSession | null>(null);
  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-2 gap-2">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Sesiones del día</p>
        <input type="date" aria-label="Día de las sesiones" value={dia} onChange={(e) => onDia(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm" />
      </div>
      {sesiones.isLoading ? <p className="text-sm text-gray-500">Cargando sesiones…</p> : sesiones.error ? (
        <p className="text-sm text-red-700">{errorMessage(sesiones.error)}</p>
      ) : (sesiones.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay sesiones ese día.</p> : (
        <div className="space-y-2">
          {(sesiones.data ?? []).map((s) => (
            <div key={s.current.id} className="bg-white rounded-lg border border-[#E4DCC8]">
              <button onClick={() => setAbierta(abierta === s.current.id ? null : s.current.id)} className="w-full flex items-center justify-between gap-2 p-3 text-left text-sm">
                <span className="flex items-center gap-2">
                  <ChevronDown className={`w-4 h-4 transition ${abierta === s.current.id ? 'rotate-180' : ''}`} />
                  <span>{hora(s.current.created_at)} · Total {s.current.total} huevos{s.current.location ? ` · ${s.current.location}` : ''}</span>
                  {s.history.length > 0 && <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">Rectificada</span>}
                </span>
                <span className="text-xs text-[#A8552E]">{abierta === s.current.id ? 'Ocultar' : 'Ver detalle'}</span>
              </button>
              {abierta === s.current.id && (
                <div className="px-4 pb-3 border-t border-[#E4DCC8] bg-[#FAF6EE] text-sm space-y-1">
                  {s.current.lines.map((l) => <p key={l.grade_id} className="pt-1">{l.grade_nombre} — {describeLine(l)}</p>)}
                  {s.current.rectification_reason && <p className="text-xs text-gray-600">Motivo de la rectificación: {s.current.rectification_reason}</p>}
                  {s.history.length > 0 && (
                    <details className="text-xs text-gray-600">
                      <summary className="cursor-pointer">Versiones anteriores ({s.history.length})</summary>
                      {s.history.map((h) => (
                        <div key={h.id} className="mt-1 pl-2 border-l border-gray-300">
                          <p>{hora(h.created_at)} · Total {h.total} huevos{h.rectification_reason ? ` · motivo: ${h.rectification_reason}` : ''}</p>
                          {h.lines.map((l) => <p key={l.grade_id}>{l.grade_nombre} — {describeLine(l)}</p>)}
                        </div>
                      ))}
                    </details>
                  )}
                  <button onClick={() => setRectificando(s)} className="mt-2 text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200">Rectificar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {rectificando && <RectificarModal sesion={rectificando} grados={grados} onClose={() => setRectificando(null)} />}
    </div>
  );
}

/** ADR-012 RPC 47: the whole current session is replaced; the prior version is kept; the reason is mandatory. */
function RectificarModal({ sesion, grados, onClose }: { sesion: ClassificationSession; grados: GradeRow[]; onClose: () => void }) {
  const rectificar = useRectifyClassification();
  const [entrada, setEntrada] = useState<Entrada>(() => Object.fromEntries(sesion.current.lines.map((l) =>
    [l.grade_id, { cantidad: String(l.entered_quantity), unidad: l.entered_unit }])));
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => crypto.randomUUID());   // idempotency: one per opened form
  const lineas = lineasDe(entrada);
  // grades of the session that are no longer active still need to be editable
  const visibles = [...grados, ...sesion.current.lines.filter((l) => !grados.some((g) => g.id === l.grade_id))
    .map((l) => ({ id: l.grade_id, nombre: l.grade_nombre, activo: false }))];
  return (
    <Modal titulo={`Rectificar sesión de las ${hora(sesion.current.created_at)}`} onClose={onClose} textoGuardar="Rectificar"
      puedeGuardar={lineas.length > 0 && motivo.trim() !== ''} guardando={rectificar.isPending} error={rectificar.error}
      onSubmit={() => rectificar.mutate({ idempotencyKey: clave, classificationId: sesion.current.id, lines: lineas, reason: motivo }, { onSuccess: onClose })}>
      <GradosInput grados={visibles} entrada={entrada} onChange={setEntrada} />
      <label className={etiqueta}>Motivo de la rectificación
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} />
      </label>
      <p className="text-xs text-gray-500">La sesión original queda guardada como versión anterior. Los totales del día usan la versión corregida.</p>
    </Modal>
  );
}
