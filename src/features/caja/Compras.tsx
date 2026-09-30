import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { ATTACHMENT_TYPES, validateAttachments } from '../../target/attachments';
import { UNIT_TYPES, type UnitType } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { PURCHASE_NATURES, type PurchaseLineInput, type PurchaseNature, type PurchaseRow } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { campo, etiqueta, Modal } from './Modal';
import { useExpenseCategories, useFreight, usePurchases, useSuppliers, useTreasuryMutations } from './useTreasury';

const NATURALEZA: Record<string, string> = { OPERATING: 'Operativa', REINVESTMENT: 'Reinversión', INVESTMENT: 'Inversión' };

/**
 * Compras y fletes (F27-D). Current purchase versions are read from `purchases`. A new purchase uploads its
 * receipts to the private bucket and then calls register_purchase (ADR-008; compensation on failure); rectification
 * is rectify_purchase; freight is register_freight / assign_freight_to_purchase. The supplier debt they create is
 * booked by the backend.
 */
export function Compras() {
  const compras = usePurchases();
  const fletes = useFreight();
  const [abierta, setAbierta] = useState<string | null>(null);
  const [rectificando, setRectificando] = useState<PurchaseRow | null>(null);
  const [nuevoFlete, setNuevoFlete] = useState(false);
  const [asignando, setAsignando] = useState<string | null>(null);
  const [nuevaCompra, setNuevaCompra] = useState(false);

  if (compras.isLoading || fletes.isLoading) return <p className="text-sm text-gray-500">Cargando compras...</p>;
  const error = compras.error ?? fletes.error;
  if (error) return <p className="text-sm text-red-700">{errorMessage(error)}</p>;

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Compras vigentes</p>
          <button onClick={() => setNuevaCompra(true)} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Nueva compra</button>
        </div>
        {(compras.data ?? []).length === 0 && <p className="text-sm text-[#8A7A5C]">No hay compras registradas.</p>}
        <div className="space-y-2">
          {(compras.data ?? []).map((c) => (
            <div key={c.id} className="bg-white rounded-lg border border-[#E4DCC8]">
              <button onClick={() => setAbierta(abierta === c.id ? null : c.id)} className="w-full flex items-center justify-between gap-2 p-3 text-left">
                <span className="flex items-center gap-2 text-sm">
                  <ChevronDown className={`w-4 h-4 transition ${abierta === c.id ? 'rotate-180' : ''}`} />
                  <span className="font-semibold text-amber-900">{c.supplier_nombre}</span>
                  <span className="text-[#8A7A5C]">· {formatearFechaLocal(c.economic_date)} · {c.categoria_nombre}</span>
                  {c.version_seq > 0 && <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">Rectificada</span>}
                </span>
                <span className="font-bold text-[#2C2419]">{formatoPesos(c.amount_total)}</span>
              </button>
              {abierta === c.id && (
                <div className="px-4 pb-3 border-t border-[#E4DCC8] bg-[#FAF6EE] text-xs text-gray-700 space-y-1">
                  <p className="pt-2">Neto {formatoPesos(c.amount_net)} · {NATURALEZA[c.nature] ?? c.nature}{c.supplier_invoice_number ? ` · Factura ${c.supplier_invoice_number}` : ''}</p>
                  {c.lineas.map((l) => <p key={l.id}>{l.cantidad} {l.unit_type} · {l.descripcion} · {formatoPesos(l.precio_unitario)} c/u</p>)}
                  <button onClick={() => setRectificando(c)} className="mt-2 text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200">Rectificar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Fletes</p>
          <button onClick={() => setNuevoFlete(true)} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Registrar flete</button>
        </div>
        {(fletes.data ?? []).length === 0 && <p className="text-sm text-[#8A7A5C]">No hay fletes registrados.</p>}
        {(fletes.data ?? []).map((f) => (
          <div key={f.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 mb-2 flex items-center justify-between gap-2 text-sm">
            <span>{formatearFechaLocal(f.economic_date)} · {f.supplier_nombre ?? 'Sin proveedor'}{f.document_ref ? ` · ${f.document_ref}` : ''}</span>
            <span className="flex items-center gap-3">
              <span className="font-bold">{formatoPesos(f.amount)}</span>
              <button onClick={() => setAsignando(f.id)} className="text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200">Asignar a compra</button>
            </span>
          </div>
        ))}
      </section>

      {nuevaCompra && <NuevaCompraModal onClose={() => setNuevaCompra(false)} />}
      {rectificando && <RectificarCompraModal compra={rectificando} onClose={() => setRectificando(null)} />}
      {nuevoFlete && <FleteModal onClose={() => setNuevoFlete(false)} />}
      {asignando && <AsignarFleteModal freightId={asignando} compras={compras.data ?? []} onClose={() => setAsignando(null)} />}
    </div>
  );
}

const LINEA_VACIA: PurchaseLineInput = { producto_id: null, feed_ingredient_id: null, descripcion: '', cantidad: 1, unit_type: 'UNIT', precio_unitario: 0 };

function NuevaCompraModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { createPurchase } = useTreasuryMutations();
  const proveedores = useSuppliers();
  const categorias = useExpenseCategories();
  const [proveedorId, setProveedorId] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [categoriaId, setCategoriaId] = useState('');
  const [naturaleza, setNaturaleza] = useState<PurchaseNature>('OPERATING');
  const [subcategoria, setSubcategoria] = useState('');
  const [factura, setFactura] = useState('');
  const [neto, setNeto] = useState('');
  const [total, setTotal] = useState('');
  const [lineas, setLineas] = useState<PurchaseLineInput[]>([]);
  const [archivos, setArchivos] = useState<File[]>([]);
  const [errorArchivo, setErrorArchivo] = useState<unknown>(null);
  const [notas, setNotas] = useState('');
  const [clave] = useState(() => `CMP-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const setLinea = (i: number, patch: Partial<PurchaseLineInput>) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineasOk = lineas.every((l) => l.descripcion.trim() !== '' && l.cantidad > 0 && l.precio_unitario >= 0);
  const puede = !!user && proveedorId !== '' && categoriaId !== '' && fecha !== '' && Number(total) > 0 && neto !== ''
    && archivos.length > 0 && !errorArchivo && lineasOk;

  function elegirArchivos(lista: FileList | null) {
    const files = Array.from(lista ?? []);
    setArchivos(files);
    try { validateAttachments(files); setErrorArchivo(null); } catch (e) { setErrorArchivo(files.length ? e : null); }
  }

  return (
    <Modal titulo="Nueva compra" onClose={onClose} puedeGuardar={puede} guardando={createPurchase.isPending}
      error={errorArchivo ?? createPurchase.error ?? proveedores.error ?? categorias.error} textoGuardar="Registrar compra"
      onSubmit={() => createPurchase.mutate({
        userId: user!.id, files: archivos, supplierId: proveedorId, economicDate: fecha, amountNet: Number(neto), amountTotal: Number(total),
        categoryId: categoriaId, subcategory: subcategoria.trim() || null, nature: naturaleza, lines: lineas.map((l) => ({ ...l, descripcion: l.descripcion.trim() })),
        idempotencyKey: clave, invoiceNumber: factura.trim() || null, reason: notas,
      }, { onSuccess: onClose })}>
      <label className={etiqueta}>Proveedor
        <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={campo}>
          <option value="">Elegir proveedor…</option>
          {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Fecha
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
        </label>
        <label className={etiqueta}>Nº de factura (opcional)
          <input type="text" value={factura} onChange={(e) => setFactura(e.target.value)} className={campo} />
        </label>
      </div>
      <label className={etiqueta}>Categoría de gasto
        <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} className={campo}>
          <option value="">Elegir categoría…</option>
          {(categorias.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Naturaleza
          <select value={naturaleza} onChange={(e) => setNaturaleza(e.target.value as PurchaseNature)} className={campo}>
            {PURCHASE_NATURES.map((n) => <option key={n} value={n}>{NATURALEZA[n]}</option>)}
          </select>
        </label>
        <label className={etiqueta}>Subcategoría (opcional)
          <input type="text" value={subcategoria} onChange={(e) => setSubcategoria(e.target.value)} className={campo} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Neto
          <input type="number" min="0" step="0.01" value={neto} onChange={(e) => setNeto(e.target.value)} className={campo} />
        </label>
        <label className={etiqueta}>Total
          <input type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} />
        </label>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <p className={etiqueta}>Detalle (opcional)</p>
          <button type="button" onClick={() => setLineas((ls) => [...ls, LINEA_VACIA])} className="text-xs text-[#A8552E] hover:underline">+ Agregar línea</button>
        </div>
        {lineas.map((l, i) => (
          <div key={i} className="border border-[#E4DCC8] rounded-lg p-2 mt-2 space-y-1">
            <input type="text" placeholder="Descripción" value={l.descripcion} onChange={(e) => setLinea(i, { descripcion: e.target.value })} className={campo} />
            <div className="grid grid-cols-3 gap-2">
              <input type="number" min="0" step="0.0001" value={l.cantidad} onChange={(e) => setLinea(i, { cantidad: Number(e.target.value) })} className={campo} />
              <select value={l.unit_type} onChange={(e) => setLinea(i, { unit_type: e.target.value as UnitType })} className={campo}>
                {UNIT_TYPES.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <input type="number" min="0" step="0.01" value={l.precio_unitario} onChange={(e) => setLinea(i, { precio_unitario: Number(e.target.value) })} className={campo} />
            </div>
            <button type="button" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))} className="text-xs text-red-700 hover:underline">Quitar</button>
          </div>
        ))}
      </div>
      <label className={etiqueta}>Comprobantes (PDF, JPG, PNG o WebP; hasta 10 MB cada uno)
        <input type="file" multiple accept={Object.keys(ATTACHMENT_TYPES).join(',')} onChange={(e) => elegirArchivos(e.target.files)} className={campo} />
      </label>
      <label className={etiqueta}>Notas (opcional)
        <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
      </label>
      <p className="text-xs text-gray-500">Primero se suben los comprobantes y después se registra la compra. Si el registro falla, los archivos subidos se eliminan.</p>
    </Modal>
  );
}

function RectificarCompraModal({ compra, onClose }: { compra: PurchaseRow; onClose: () => void }) {
  const { rectifyPurchase } = useTreasuryMutations();
  const [neto, setNeto] = useState(String(compra.amount_net));
  const [total, setTotal] = useState(String(compra.amount_total));
  const [lineas, setLineas] = useState<PurchaseLineInput[]>(compra.lineas.map((l) => ({
    producto_id: l.producto_id, feed_ingredient_id: l.feed_ingredient_id, descripcion: l.descripcion, cantidad: l.cantidad,
    unit_type: l.unit_type, precio_unitario: l.precio_unitario,
  })));
  const [motivo, setMotivo] = useState('');
  const set = (i: number, k: 'cantidad' | 'precio_unitario', v: string) =>
    setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: Number(v) } : l)));
  const puede = Number(total) > 0 && neto !== '' && motivo.trim() !== '' && lineas.length > 0;

  return (
    <Modal titulo={`Rectificar compra — ${compra.supplier_nombre}`} onClose={onClose} puedeGuardar={puede} guardando={rectifyPurchase.isPending}
      error={rectifyPurchase.error} textoGuardar="Rectificar"
      onSubmit={() => rectifyPurchase.mutate({ purchaseId: compra.id, amountNet: Number(neto), amountTotal: Number(total), lines: lineas, reason: motivo },
        { onSuccess: onClose })}>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Neto
          <input type="number" min="0" step="0.01" value={neto} onChange={(e) => setNeto(e.target.value)} className={campo} />
        </label>
        <label className={etiqueta}>Total
          <input type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} />
        </label>
      </div>
      {lineas.map((l, i) => (
        <div key={i} className="border border-[#E4DCC8] rounded-lg p-2">
          <p className="text-xs font-medium text-gray-700">{l.descripcion} ({l.unit_type})</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-600">Cantidad
              <input type="number" min="0" step="0.0001" value={l.cantidad} onChange={(e) => set(i, 'cantidad', e.target.value)} className={campo} />
            </label>
            <label className="text-xs text-gray-600">Precio unitario
              <input type="number" min="0" step="0.01" value={l.precio_unitario} onChange={(e) => set(i, 'precio_unitario', e.target.value)} className={campo} />
            </label>
          </div>
        </div>
      ))}
      <label className={etiqueta}>Motivo de la rectificación
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} />
      </label>
      <p className="text-xs text-gray-500">Los comprobantes adjuntos pasan a la nueva versión. La deuda con el proveedor la ajusta el sistema.</p>
    </Modal>
  );
}

function FleteModal({ onClose }: { onClose: () => void }) {
  const { registerFreight } = useTreasuryMutations();
  const proveedores = useSuppliers();
  const categorias = useExpenseCategories();
  const [fecha, setFecha] = useState(getTodayDate());
  const [monto, setMonto] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [proveedorId, setProveedorId] = useState('');
  const [documento, setDocumento] = useState('');
  const [clave] = useState(() => `FLT-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const puede = fecha !== '' && Number(monto) > 0 && categoriaId !== '';

  return (
    <Modal titulo="Registrar flete" onClose={onClose} puedeGuardar={puede} guardando={registerFreight.isPending} error={registerFreight.error ?? proveedores.error ?? categorias.error}
      onSubmit={() => registerFreight.mutate({
        economicDate: fecha, amount: Number(monto), categoryId: categoriaId, idempotencyKey: clave, supplierId: proveedorId || null, documentRef: documento,
      }, { onSuccess: onClose })}>
      <label className={etiqueta}>Fecha
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Monto
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Categoría de gasto
        <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} className={campo}>
          <option value="">Elegir categoría…</option>
          {(categorias.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Transportista (opcional)
        <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={campo}>
          <option value="">Sin proveedor</option>
          {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Comprobante (opcional)
        <input type="text" value={documento} onChange={(e) => setDocumento(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}

function AsignarFleteModal({ freightId, compras, onClose }: { freightId: string; compras: PurchaseRow[]; onClose: () => void }) {
  const { assignFreight } = useTreasuryMutations();
  const [compraId, setCompraId] = useState('');
  const [monto, setMonto] = useState('');
  const puede = compraId !== '' && Number(monto) > 0;

  return (
    <Modal titulo="Asignar flete a una compra" onClose={onClose} puedeGuardar={puede} guardando={assignFreight.isPending} error={assignFreight.error}
      textoGuardar="Asignar"
      onSubmit={() => assignFreight.mutate({ freightId, purchaseId: compraId, amount: Number(monto) }, { onSuccess: onClose })}>
      <label className={etiqueta}>Compra
        <select value={compraId} onChange={(e) => setCompraId(e.target.value)} className={campo}>
          <option value="">Elegir compra…</option>
          {compras.map((c) => <option key={c.id} value={c.id}>{c.supplier_nombre} · {formatearFechaLocal(c.economic_date)} · {formatoPesos(c.amount_total)}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Monto a asignar
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}
