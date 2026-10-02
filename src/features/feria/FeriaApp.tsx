import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { ATTACHMENT_TYPES, type AttachmentFile } from '../../target/attachments';
import { type FeriaClosingRow, type SessionCashRow, type SessionRow } from '../../target/feria';
import { worksheetSignedUrl } from '../../target/feriaWorksheet';
import { errorMessage } from '../../target/messages';
import { shiftDate } from '../../target/production';
import { getTodayDate } from '../../utils/dateUtils';
import { supabase } from '../../lib/supabase';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { useFeriaClosingMutations, useFeriaClosings, useSessionCash, useSessionMovements, useSessions } from './useFeriaFiscal';

const DIAS = 365;
const MOVIMIENTO = { DISPATCH: 'Despacho', RETURN: 'Devolución', LOSS: 'Pérdida', ADJUSTMENT: 'Ajuste' } as const;

/**
 * Feria V1 (ADR-016, ADMIN). The paper / spreadsheet worksheet stays the detailed record; the app keeps one
 * summarized closing per Feria (RPC 51) and its rectified versions (RPC 52). Every derived figure shown here
 * (total sales, expected cash, cash difference) comes from the backend — the RPC result or report_feria_closing.
 * Sessions closed with the earlier detailed flow stay readable below (no actions).
 */
export function FeriaApp() {
  const { rol } = useAuth();
  const hoy = getTodayDate();
  const desde = shiftDate(hoy, -DIAS);
  const sesiones = useSessions();
  const cierres = useFeriaClosings(desde, hoy);
  const caja = useSessionCash(desde, hoy);
  const [cerrando, setCerrando] = useState<{ session?: SessionRow } | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede gestionar la feria.</p>
        </div>
      </div>
    );
  }
  const error = sesiones.error ?? cierres.error ?? caja.error;
  const versiones = new Map<string, FeriaClosingRow[]>();
  for (const c of cierres.data ?? []) versiones.set(c.sales_session_id, [...(versiones.get(c.sales_session_id) ?? []), c]);
  const vigentes = (cierres.data ?? []).filter((c) => c.is_current);
  const abiertas = (sesiones.data ?? []).filter((s) => s.estado === 'OPEN');
  const anteriores = (sesiones.data ?? []).filter((s) => s.estado === 'CLOSED' && !versiones.has(s.id));
  const cajaPorSesion = new Map<string, SessionCashRow[]>();
  for (const r of caja.data ?? []) cajaPorSesion.set(r.sales_session_id, [...(cajaPorSesion.get(r.sales_session_id) ?? []), r]);

  return (
    <div className="min-h-screen bg-[#FAF6EE] px-4 md:px-6 pt-6 pb-20 space-y-6">
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Feria</h1>
        </div>
        <button onClick={() => setCerrando({})} className="text-sm px-4 py-2 bg-[#A8552E] text-white rounded-lg hover:bg-[#8B4423]">Cierre de Feria</button>
      </div>
      {error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}

      {abiertas.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[#6B5D45] uppercase">Ferias abiertas sin cierre</h2>
          {abiertas.map((s) => (
            <div key={s.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 flex items-center justify-between text-sm">
              <span className="font-semibold text-amber-900">{s.session_date} · {s.location ?? '—'}</span>
              <button onClick={() => setCerrando({ session: s })} className="text-xs px-2 py-1 rounded bg-[#A8552E] text-white hover:bg-[#8B4423]">Cerrar</button>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[#6B5D45] uppercase">Cierres</h2>
        {cierres.isLoading ? <p className="text-sm text-gray-500">Cargando cierres…</p> : vigentes.length === 0 ? (
          <p className="text-sm text-[#8A7A5C]">No hay cierres de feria registrados.</p>
        ) : vigentes.map((c) => (
          <Cierre key={c.closing_id} cierre={c} versiones={versiones.get(c.sales_session_id) ?? [c]}
            abierto={abierto === c.closing_id} onToggle={() => setAbierto(abierto === c.closing_id ? null : c.closing_id)} />
        ))}
      </section>

      {anteriores.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[#6B5D45] uppercase">Ferias anteriores (modo detallado, solo lectura)</h2>
          {anteriores.map((s) => (
            <SesionAnterior key={s.id} sesion={s} caja={cajaPorSesion.get(s.id) ?? []} abierta={abierto === s.id}
              onToggle={() => setAbierto(abierto === s.id ? null : s.id)} />
          ))}
        </section>
      )}
      {cerrando && <CierreModal session={cerrando.session} onClose={() => setCerrando(null)} />}
    </div>
  );
}

const Dato = ({ label, valor, fuerte }: { label: string; valor: string; fuerte?: boolean }) => (
  <p className="text-xs text-[#6B5D45]">{label} <b className={fuerte ? 'text-[#2C2419]' : ''}>{valor}</b></p>
);
const diferenciaTexto = (d: number) => (d === 0 ? 'sin diferencia' : d < 0 ? `faltante ${formatoPesos(-d)}` : `sobrante ${formatoPesos(d)}`);

function Cierre({ cierre: c, versiones, abierto, onToggle }: { cierre: FeriaClosingRow; versiones: FeriaClosingRow[]; abierto: boolean; onToggle: () => void }) {
  const [rectificando, setRectificando] = useState(false);
  const anteriores = versiones.filter((v) => !v.is_current);
  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8]">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-2 p-3 text-left text-sm">
        <span className="flex items-center gap-2">
          <ChevronDown className={`w-4 h-4 transition ${abierto ? 'rotate-180' : ''}`} />
          <span className="font-semibold text-amber-900">{c.closing_date} · {c.location ?? '—'}</span>
          {c.version_seq > 0 && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">Rectificado (v{c.version_seq})</span>}
        </span>
        <span className="text-[#6B5D45]">Ventas {formatoPesos(c.total_sales)} · <span className={c.cash_difference === 0 ? 'text-green-700' : 'text-red-700'}>{diferenciaTexto(c.cash_difference)}</span></span>
      </button>
      {abierto && (
        <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] space-y-3 text-sm">
          <Detalle c={c} />
          {anteriores.length > 0 && (
            <div className="text-xs space-y-1">
              <p className="font-semibold text-[#6B5D45] uppercase">Versiones anteriores</p>
              {anteriores.map((v) => (
                <p key={v.closing_id} className="text-gray-600">v{v.version_seq} ({v.created_at.slice(0, 10)}): ventas {formatoPesos(v.total_sales)} · contado {formatoPesos(v.counted_cash)} · {diferenciaTexto(v.cash_difference)}{v.has_worksheet ? ' · con planilla' : ''}{v.rectification_reason ? ` · motivo: ${v.rectification_reason}` : ''}</p>
              ))}
            </div>
          )}
          <button onClick={() => setRectificando(true)} className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Rectificar</button>
        </div>
      )}
      {rectificando && <CierreModal rectificar={c} onClose={() => setRectificando(false)} />}
    </div>
  );
}

function Detalle({ c }: { c: FeriaClosingRow }) {
  const [error, setError] = useState<unknown>(null);
  const ver = async () => {
    setError(null);
    try { window.open(await worksheetSignedUrl(supabase, c.worksheet_path ?? ''), '_blank', 'noopener'); } catch (e) { setError(e); }
  };
  return (
    <div className="pt-3 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Dato label="Ventas totales" valor={formatoPesos(c.total_sales)} fuerte />
        <Dato label="Efectivo" valor={formatoPesos(c.cash_sales)} />
        <Dato label="Mercado Pago" valor={formatoPesos(c.mp_sales)} />
        <Dato label="Transferencia" valor={formatoPesos(c.transfer_sales)} />
        <Dato label="Fondo inicial" valor={formatoPesos(c.opening_float)} />
        <Dato label="Gastos de Feria" valor={formatoPesos(c.expenses)} />
        <Dato label="Efectivo esperado" valor={formatoPesos(c.expected_cash)} fuerte />
        <Dato label="Efectivo contado" valor={formatoPesos(c.counted_cash)} fuerte />
        <Dato label="Diferencia de caja" valor={`${formatoPesos(c.cash_difference)} (${diferenciaTexto(c.cash_difference)})`} fuerte />
        <Dato label="Efectivo a" valor={c.cash_account_name} />
        {c.transfer_account_name && <Dato label="Transferencias a" valor={c.transfer_account_name} />}
        {c.merma !== null && <Dato label="Merma" valor={String(c.merma)} />}
      </div>
      {c.notes && <p className="text-xs text-gray-600">Notas: {c.notes}</p>}
      {c.rectification_reason && <p className="text-xs text-gray-600">Motivo de la rectificación: {c.rectification_reason}</p>}
      <p className="text-xs text-gray-600">Planilla: {c.has_worksheet
        ? <button onClick={ver} className="underline text-amber-900">{c.worksheet_file_name ?? 'ver'}</button>
        : 'no adjunta'}</p>
      {error ? <p className="text-xs text-red-700">{errorMessage(error)}</p> : null}
    </div>
  );
}

/** "Cierre de Feria" (new date, or an open session) and its rectification share one form; the backend derives everything. */
function CierreModal({ session, rectificar, onClose }: { session?: SessionRow; rectificar?: FeriaClosingRow; onClose: () => void }) {
  const { user } = useAuth();
  const { close, rectify } = useFeriaClosingMutations();
  const cuentas = useFinancialAccounts();
  const fisicas = (cuentas.data ?? []).filter((a) => a.account_type !== 'EXTERNAL_SERVICE');
  const cajaChica = fisicas.find((a) => a.account_type === 'CASH' && /caja\s*chica/i.test(a.nombre));
  const r = rectificar;
  const txt = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? '' : String(n));
  const [fecha, setFecha] = useState(getTodayDate());
  const [lugar, setLugar] = useState('Feria');
  const [efectivo, setEfectivo] = useState(txt(r?.cash_sales));
  const [mp, setMp] = useState(txt(r?.mp_sales));
  const [transferencia, setTransferencia] = useState(txt(r?.transfer_sales));
  const [gastos, setGastos] = useState(txt(r?.expenses));
  const [contado, setContado] = useState(r ? String(r.counted_cash) : '');
  const [fondo, setFondo] = useState(txt(r?.opening_float));
  const [merma, setMerma] = useState(r?.merma === null || r?.merma === undefined ? '' : String(r.merma));
  const [notas, setNotas] = useState(r?.notes ?? '');
  const [cuentaElegida, setCuentaElegida] = useState<string | null>(r?.cash_account_id ?? null);
  const [cuentaTrf, setCuentaTrf] = useState(r?.transfer_account_id ?? '');
  const [archivo, setArchivo] = useState<(AttachmentFile & Blob) | null>(null);
  const [motivo, setMotivo] = useState('');
  const [masDatos, setMasDatos] = useState(Boolean(r && (r.opening_float || r.merma !== null || r.notes)));
  const [clave] = useState(() => `FERIA-${crypto.randomUUID()}`);   // idempotency: one session per submitted form
  const [resultado, setResultado] = useState<{ total_sales: number; expected_cash: number; cash_difference: number } | null>(null);
  const cuentaId = cuentaElegida ?? cajaChica?.id ?? '';
  const n = (v: string) => (v.trim() === '' ? 0 : Number(v));
  const montosOk = [efectivo, mp, transferencia, gastos, fondo].every((v) => v.trim() === '' || Number(v) >= 0) && contado.trim() !== '' && Number(contado) >= 0;
  const puede = montosOk && cuentaId !== '' && (n(transferencia) === 0 || cuentaTrf !== '') && (!r || motivo.trim() !== '') && (Boolean(session) || Boolean(r) || fecha !== '');
  const mutation = r ? rectify : close;

  if (resultado) {
    return (
      <Modal titulo="Cierre registrado" onClose={onClose} puedeGuardar guardando={false} textoGuardar="Listo" onSubmit={onClose}>
        <Dato label="Ventas totales" valor={formatoPesos(resultado.total_sales)} fuerte />
        <Dato label="Efectivo esperado" valor={formatoPesos(resultado.expected_cash)} fuerte />
        <Dato label="Efectivo contado" valor={formatoPesos(n(contado))} fuerte />
        <Dato label="Diferencia de caja" valor={`${formatoPesos(resultado.cash_difference)} (${diferenciaTexto(resultado.cash_difference)})`} fuerte />
      </Modal>
    );
  }
  const enviar = () => {
    const base = {
      userId: user!.id, file: archivo, cashSales: n(efectivo), mpSales: n(mp), transferSales: n(transferencia), expenses: n(gastos),
      countedCash: n(contado), cashAccountId: cuentaId, transferAccountId: n(transferencia) > 0 ? cuentaTrf : null, openingFloat: n(fondo),
      merma: merma.trim() === '' ? null : Number(merma), notes: notas,
    };
    const onSuccess = (res: unknown) => setResultado(res as { total_sales: number; expected_cash: number; cash_difference: number });
    if (r) rectify.mutate({ ...base, closingId: r.closing_id, reason: motivo.trim(), keepWorksheet: true }, { onSuccess });
    else if (session) close.mutate({ ...base, sessionId: session.id }, { onSuccess });
    else close.mutate({ ...base, date: fecha, location: lugar.trim() || 'Feria', idempotencyKey: clave }, { onSuccess });
  };
  const titulo = r ? `Rectificar cierre — ${r.closing_date}` : session ? `Cierre de Feria — ${session.session_date}` : 'Cierre de Feria';
  const montoInput = (label: string, v: string, set: (s: string) => void) => (
    <label className={etiqueta}>{label}<input type="number" min="0" step="0.01" inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} className={campo} /></label>
  );
  return (
    <Modal titulo={titulo} onClose={onClose} puedeGuardar={puede} guardando={mutation.isPending} error={mutation.error ?? cuentas.error}
      textoGuardar={r ? 'Rectificar' : 'Cerrar feria'} onSubmit={enviar}>
      {!session && !r && <label className={etiqueta}>Fecha<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>}
      {montoInput('Ventas en efectivo', efectivo, setEfectivo)}
      {montoInput('Ventas Mercado Pago', mp, setMp)}
      {montoInput('Ventas por transferencia', transferencia, setTransferencia)}
      {montoInput('Gastos de Feria', gastos, setGastos)}
      {montoInput('Efectivo contado', contado, setContado)}
      <label className={etiqueta}>Destino del efectivo
        <select value={cuentaId} onChange={(e) => setCuentaElegida(e.target.value)} className={campo}>
          <option value="">Elegir caja o cuenta…</option>
          {fisicas.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      {n(transferencia) > 0 && (
        <label className={etiqueta}>Cuenta de las transferencias
          <select value={cuentaTrf} onChange={(e) => setCuentaTrf(e.target.value)} className={campo}>
            <option value="">Elegir cuenta…</option>
            {fisicas.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </label>
      )}
      <label className={etiqueta}>Planilla (foto o PDF, opcional)
        <input type="file" accept={Object.keys(ATTACHMENT_TYPES).join(',')} onChange={(e) => setArchivo((e.target.files?.[0] as (AttachmentFile & Blob) | undefined) ?? null)} className={campo} />
      </label>
      {r?.has_worksheet && !archivo && <p className="text-xs text-gray-500">Se mantiene la planilla adjunta ({r.worksheet_file_name}).</p>}
      {!archivo && !r?.has_worksheet && <p className="text-xs text-gray-500">Recomendado: adjuntá la planilla de la feria.</p>}
      <button type="button" onClick={() => setMasDatos(!masDatos)} className="text-xs text-amber-900 underline">{masDatos ? 'Menos datos' : 'Más datos'}</button>
      {masDatos && (
        <>
          {!session && !r && <label className={etiqueta}>Lugar<input type="text" value={lugar} onChange={(e) => setLugar(e.target.value)} className={campo} /></label>}
          {montoInput('Fondo inicial', fondo, setFondo)}
          {montoInput('Merma (opcional)', merma, setMerma)}
          <label className={etiqueta}>Notas<input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} /></label>
        </>
      )}
      {r && <label className={etiqueta}>Motivo de la rectificación<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>}
      <p className="text-xs text-gray-500">El sistema calcula las ventas totales, el efectivo esperado y la diferencia de caja al registrar el cierre.</p>
    </Modal>
  );
}

/** A session closed with the earlier detailed flow: readable, no actions (ADR-016 keeps backend and history). */
function SesionAnterior({ sesion, caja, abierta, onToggle }: { sesion: SessionRow; caja: SessionCashRow[]; abierta: boolean; onToggle: () => void }) {
  const movs = useSessionMovements(abierta ? sesion.id : '');
  const r = caja[0];
  const conteos = caja.filter((c) => c.count_event_id !== null);
  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8]">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-2 p-3 text-left text-sm">
        <span className="flex items-center gap-2">
          <ChevronDown className={`w-4 h-4 transition ${abierta ? 'rotate-180' : ''}`} />
          <span className="font-semibold text-amber-900">{sesion.session_date} · {sesion.location ?? '—'}</span>
        </span>
        {r && <span className="text-[#6B5D45]">Esperado en caja {formatoPesos(r.expected_cash)}</span>}
      </button>
      {abierta && (
        <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] space-y-2 text-xs pt-3">
          {r && <p>Fondo inicial {formatoPesos(r.opening_fund)} · Gastos {formatoPesos(r.expenses)} · Retiros {formatoPesos(r.withdrawals)} · Transferencias {formatoPesos(r.transfers_out)}</p>}
          {conteos.map((c) => <p key={c.count_event_id}>Conteo {c.count_date}: contado {formatoPesos(c.counted_cash ?? 0)} · diferencia {formatoPesos(c.variance ?? 0)}</p>)}
          {(movs.data ?? []).map((m) => <p key={m.id} className="text-gray-700">{MOVIMIENTO[m.movement_type]} · {m.cantidad} {m.producto_nombre}{m.reason ? ` · ${m.reason}` : ''}</p>)}
        </div>
      )}
    </div>
  );
}
