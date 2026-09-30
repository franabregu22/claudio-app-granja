import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { currentPrice } from '../../target/commercial';
import { SESSION_MOVEMENT_TYPES, type AggregatedLine, type SessionCashEventType, type SessionCashRow, type SessionMovementType, type SessionRow } from '../../target/feria';
import { errorMessage } from '../../target/messages';
import { shiftDate } from '../../target/production';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useExpenseCategories } from '../caja/useTreasury';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts, useOrderCatalog } from '../pedidos/useCommercial';
import { useFeriaMutations, useSessionCash, useSessionMovements, useSessions } from './useFeriaFiscal';

const DIAS = 60;
const MOVIMIENTO: Record<SessionMovementType, string> = { DISPATCH: 'Despacho', RETURN: 'Devolución', LOSS: 'Pérdida', ADJUSTMENT: 'Ajuste' };
const EVENTO: Record<Exclude<SessionCashEventType, 'COUNT'>, string> = { EXPENSE: 'Gasto', WITHDRAWAL: 'Retiro', TRANSFER_OUT: 'Transferencia' };

/**
 * Feria (F27-F, ADMIN). Sessions are opened, fed with goods movements and cash events, counted and closed only
 * through RPCs 30–33. The cash reconciliation (expected cash and each count's variance) is report_feria_session_cash
 * as reported: a variance stays visible and is never corrected here. This is the Feria session count, not the
 * retired general cash count (P27-D1).
 */
export function FeriaApp() {
  const { rol } = useAuth();
  const hoy = getTodayDate();
  const sesiones = useSessions();
  const caja = useSessionCash(shiftDate(hoy, -DIAS), hoy);
  const [abriendo, setAbriendo] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);

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
  const error = sesiones.error ?? caja.error;
  const cajaPorSesion = new Map<string, SessionCashRow[]>();
  for (const r of caja.data ?? []) cajaPorSesion.set(r.sales_session_id, [...(cajaPorSesion.get(r.sales_session_id) ?? []), r]);

  return (
    <div className="min-h-screen bg-[#FAF6EE] px-4 md:px-6 pt-6 pb-20 space-y-6">
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Feria</h1>
        </div>
        <button onClick={() => setAbriendo(true)} className="text-sm px-4 py-2 bg-[#A8552E] text-white rounded-lg hover:bg-[#8B4423]">Abrir feria</button>
      </div>
      {error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}
      {sesiones.isLoading ? <p className="text-sm text-gray-500">Cargando ferias…</p> : (sesiones.data ?? []).length === 0 ? (
        <p className="text-sm text-[#8A7A5C]">No hay ferias registradas.</p>
      ) : (
        <div className="space-y-2">
          {(sesiones.data ?? []).map((s) => (
            <Sesion key={s.id} sesion={s} caja={cajaPorSesion.get(s.id) ?? []} abierta={abierta === s.id} onToggle={() => setAbierta(abierta === s.id ? null : s.id)} />
          ))}
        </div>
      )}
      {abriendo && <AbrirModal onClose={() => setAbriendo(false)} />}
    </div>
  );
}

function Sesion({ sesion, caja, abierta, onToggle }: { sesion: SessionRow; caja: SessionCashRow[]; abierta: boolean; onToggle: () => void }) {
  const movs = useSessionMovements(abierta ? sesion.id : '');
  const [accion, setAccion] = useState<'movimiento' | 'conteo' | 'cerrar' | Exclude<SessionCashEventType, 'COUNT'> | null>(null);
  const r = caja[0];
  const conteos = caja.filter((c) => c.count_event_id !== null);
  const esAbierta = sesion.estado === 'OPEN';
  const boton = 'text-xs px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200';

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8]">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-2 p-3 text-left text-sm">
        <span className="flex items-center gap-2">
          <ChevronDown className={`w-4 h-4 transition ${abierta ? 'rotate-180' : ''}`} />
          <span className="font-semibold text-amber-900">{sesion.session_date} · {sesion.location ?? '—'}</span>
          <span className={`text-xs px-2 py-0.5 rounded ${esAbierta ? 'bg-green-100 text-green-800' : 'bg-stone-200 text-stone-700'}`}>{esAbierta ? 'Abierta' : 'Cerrada'}</span>
        </span>
        {r && <span className="text-[#6B5D45]">Esperado en caja {formatoPesos(r.expected_cash)}</span>}
      </button>
      {abierta && (
        <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] space-y-3 text-sm">
          {r && (
            <div className="pt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
              <p>Fondo inicial <b>{formatoPesos(r.opening_fund)}</b></p>
              <p>Gastos <b>{formatoPesos(r.expenses)}</b></p>
              <p>Retiros <b>{formatoPesos(r.withdrawals)}</b></p>
              <p>Transferencias <b>{formatoPesos(r.transfers_out)}</b></p>
              <p>Esperado <b>{formatoPesos(r.expected_cash)}</b></p>
            </div>
          )}
          {conteos.length > 0 && (
            <div className="text-xs space-y-1">
              {conteos.map((c) => (
                <p key={c.count_event_id}>Conteo {c.count_date}: contado {formatoPesos(c.counted_cash ?? 0)} ·{' '}
                  <span className={(c.variance ?? 0) === 0 ? 'text-green-700' : 'text-red-700 font-semibold'}>diferencia {formatoPesos(c.variance ?? 0)}</span>
                </p>
              ))}
            </div>
          )}
          <div>
            <p className="text-xs font-semibold text-[#6B5D45] uppercase mb-1">Movimientos de mercadería</p>
            {movs.isLoading ? <p className="text-xs text-gray-500">Cargando…</p> : (movs.data ?? []).length === 0 ? <p className="text-xs text-gray-500">Sin movimientos.</p> : (
              (movs.data ?? []).map((m) => <p key={m.id} className="text-xs text-gray-700">{MOVIMIENTO[m.movement_type]} · {m.cantidad} {m.producto_nombre}{m.reason ? ` · ${m.reason}` : ''}</p>)
            )}
          </div>
          {esAbierta && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setAccion('movimiento')} className={boton}>Movimiento</button>
              {(['EXPENSE', 'WITHDRAWAL', 'TRANSFER_OUT'] as const).map((t) => <button key={t} onClick={() => setAccion(t)} className={boton}>{EVENTO[t]}</button>)}
              <button onClick={() => setAccion('conteo')} className={boton}>Conteo de caja</button>
              <button onClick={() => setAccion('cerrar')} className="text-xs px-2 py-1 rounded bg-[#A8552E] text-white hover:bg-[#8B4423]">Cerrar feria</button>
            </div>
          )}
        </div>
      )}
      {accion === 'movimiento' && <MovimientoModal sessionId={sesion.id} onClose={() => setAccion(null)} />}
      {(accion === 'EXPENSE' || accion === 'WITHDRAWAL' || accion === 'TRANSFER_OUT') && <CajaModal sessionId={sesion.id} tipo={accion} onClose={() => setAccion(null)} />}
      {accion === 'conteo' && <CajaModal sessionId={sesion.id} tipo="COUNT" onClose={() => setAccion(null)} />}
      {accion === 'cerrar' && <CerrarModal sesion={sesion} onClose={() => setAccion(null)} />}
    </div>
  );
}

function CuentaSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const cuentas = useFinancialAccounts();
  return (
    <label className={etiqueta}>{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={campo}>
        <option value="">Elegir cuenta…</option>
        {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
      </select>
    </label>
  );
}

function AbrirModal({ onClose }: { onClose: () => void }) {
  const { open } = useFeriaMutations();
  const [fecha, setFecha] = useState(getTodayDate());
  const [lugar, setLugar] = useState('');
  const [fondo, setFondo] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [clave] = useState(() => `FERIA-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const conFondo = Number(fondo) > 0;
  return (
    <Modal titulo="Abrir feria" onClose={onClose} puedeGuardar={fecha !== '' && lugar.trim() !== '' && (!conFondo || cuentaId !== '')}
      guardando={open.isPending} error={open.error} textoGuardar="Abrir"
      onSubmit={() => open.mutate({ date: fecha, location: lugar.trim(), idempotencyKey: clave, openingFund: Number(fondo || 0), cashAccountId: cuentaId || null },
        { onSuccess: onClose })}>
      <label className={etiqueta}>Fecha<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Lugar<input type="text" value={lugar} onChange={(e) => setLugar(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Fondo inicial (opcional)<input type="number" min="0" step="0.01" value={fondo} onChange={(e) => setFondo(e.target.value)} className={campo} /></label>
      {conFondo && <CuentaSelect label="Cuenta de la que sale el fondo" value={cuentaId} onChange={setCuentaId} />}
    </Modal>
  );
}

function ProductoSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { products } = useOrderCatalog();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={campo}>
      <option value="">Elegir producto…</option>
      {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
    </select>
  );
}

function MovimientoModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { movement } = useFeriaMutations();
  const [tipo, setTipo] = useState<SessionMovementType>('DISPATCH');
  const [productoId, setProductoId] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo="Movimiento de mercadería" onClose={onClose} puedeGuardar={productoId !== '' && Number(cantidad) > 0}
      guardando={movement.isPending} error={movement.error}
      onSubmit={() => movement.mutate({ sessionId, type: tipo, productoId, cantidad: Number(cantidad), reason: motivo }, { onSuccess: onClose })}>
      <label className={etiqueta}>Tipo
        <select value={tipo} onChange={(e) => setTipo(e.target.value as SessionMovementType)} className={campo}>
          {SESSION_MOVEMENT_TYPES.map((t) => <option key={t} value={t}>{MOVIMIENTO[t]}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Producto<ProductoSelect value={productoId} onChange={setProductoId} /></label>
      <label className={etiqueta}>Cantidad<input type="number" min="0" step="0.01" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>{tipo === 'LOSS' || tipo === 'ADJUSTMENT' ? 'Motivo' : 'Notas (opcional)'}
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}

function CajaModal({ sessionId, tipo, onClose }: { sessionId: string; tipo: SessionCashEventType; onClose: () => void }) {
  const { cashEvent } = useFeriaMutations();
  const categorias = useExpenseCategories();
  const [monto, setMonto] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [destinoId, setDestinoId] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [motivo, setMotivo] = useState('');
  const esConteo = tipo === 'COUNT';
  const puede = Number(monto) > 0 && (esConteo || cuentaId !== '') && (tipo !== 'EXPENSE' || categoriaId !== '') && (tipo !== 'TRANSFER_OUT' || destinoId !== '');
  return (
    <Modal titulo={esConteo ? 'Conteo de caja de la feria' : EVENTO[tipo as Exclude<SessionCashEventType, 'COUNT'>]} onClose={onClose}
      puedeGuardar={puede} guardando={cashEvent.isPending} error={cashEvent.error ?? categorias.error}
      onSubmit={() => cashEvent.mutate({
        sessionId, type: tipo, amount: Number(monto), accountId: esConteo ? null : cuentaId, categoryId: tipo === 'EXPENSE' ? categoriaId : null,
        destinationAccountId: tipo === 'TRANSFER_OUT' ? destinoId : null, reason: motivo,
      }, { onSuccess: onClose })}>
      <label className={etiqueta}>{esConteo ? 'Efectivo contado' : 'Monto'}
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      {!esConteo && <CuentaSelect label="Cuenta" value={cuentaId} onChange={setCuentaId} />}
      {tipo === 'TRANSFER_OUT' && <CuentaSelect label="Cuenta de destino" value={destinoId} onChange={setDestinoId} />}
      {tipo === 'EXPENSE' && (
        <label className={etiqueta}>Categoría de gasto
          <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} className={campo}>
            <option value="">Elegir categoría…</option>
            {(categorias.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
      )}
      <label className={etiqueta}>Notas (opcional)<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
      {esConteo && <p className="text-xs text-gray-500">El conteo es una observación: no mueve dinero. El sistema muestra la diferencia contra lo esperado.</p>}
    </Modal>
  );
}

function CerrarModal({ sesion, onClose }: { sesion: SessionRow; onClose: () => void }) {
  const { close } = useFeriaMutations();
  const { products, prices } = useOrderCatalog();
  const [lineas, setLineas] = useState<AggregatedLine[]>([]);
  const [productoId, setProductoId] = useState('');
  const [motivo, setMotivo] = useState('');
  const agregar = () => {
    if (!productoId || lineas.some((l) => l.producto_id === productoId)) return;
    setLineas((ls) => [...ls, { producto_id: productoId, cantidad: 1, precio_unitario: currentPrice(prices, productoId, 'MINORISTA') ?? 0 }]);
    setProductoId('');
  };
  const set = (i: number, k: 'cantidad' | 'precio_unitario', v: string) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: Number(v) } : l)));
  const nombre = (id: string) => products.find((p) => p.id === id)?.nombre ?? '—';
  return (
    <Modal titulo={`Cerrar feria — ${sesion.session_date} ${sesion.location ?? ''}`} onClose={onClose} puedeGuardar guardando={close.isPending} error={close.error}
      textoGuardar="Cerrar feria" onSubmit={() => close.mutate({ sessionId: sesion.id, lines: lineas, reason: motivo }, { onSuccess: onClose })}>
      <p className="text-sm text-gray-600">Venta minorista de la feria (se registra como un pedido de CONSUMIDOR FINAL). Dejala vacía si no hubo venta minorista.</p>
      <div className="flex gap-2">
        <div className="flex-1"><ProductoSelect value={productoId} onChange={setProductoId} /></div>
        <button type="button" onClick={agregar} className="px-3 mt-1 bg-amber-100 text-amber-900 rounded-lg text-sm">Agregar</button>
      </div>
      {lineas.map((l, i) => (
        <div key={l.producto_id} className="grid grid-cols-3 gap-2 items-end">
          <p className="text-sm text-gray-700 pb-2">{nombre(l.producto_id)}</p>
          <label className="text-xs text-gray-600">Cantidad<input type="number" min="0" value={l.cantidad} onChange={(e) => set(i, 'cantidad', e.target.value)} className={campo} /></label>
          <label className="text-xs text-gray-600">Precio<input type="number" min="0" step="0.01" value={l.precio_unitario} onChange={(e) => set(i, 'precio_unitario', e.target.value)} className={campo} /></label>
        </div>
      ))}
      <label className={etiqueta}>Notas (opcional)<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-500">Una feria cerrada no admite más movimientos ni eventos de caja.</p>
    </Modal>
  );
}
