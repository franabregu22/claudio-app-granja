import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { ATTACHMENT_TYPES, validateAttachments } from '../../target/attachments';
import { defaultNatureOf } from '../../target/expenseCategories';
import { COMPROBANTE_VACIO, cuentaAdmitida, MEDIO_PAGO_LABEL, NATURALEZA_GASTO, rutaGasto, type ComprobanteForm, type EstadoPago, type MedioPago } from '../../target/expenses';
import { cuitOrNull, fiscalInput, TAX_KINDS, type ComponenteForm, type FiscalDocumentType, type FiscalForm, type TaxKind } from '../../target/fiscal';
import { errorMessage } from '../../target/messages';
import { type FreightRow, type PurchaseLineInput, type PurchaseNature, type PurchaseRow } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { campo, etiqueta, Modal } from './Modal';
import { SelectorCategoria } from './SelectorCategoria';
import { useExpenseCategories, useFreight, useSuppliers, useTreasuryMutations } from './useTreasury';
import { useInvoicePaymentStatus } from './useInvoicePayments';
import { useRegisterExpense } from './useExpenses';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { facturaRepetida, posibleDuplicado } from '../../target/expenseHub';

/**
 * Compras y fletes (F27-D; Phase 27 acceptance fixes D-WALK-3/4/5/6). The forms of a purchase and of freight; the list of purchases is
 * Cuentas a pagar → Gastos (Gastos.tsx). A new purchase (the "Nuevo gasto" form, opened from the floating button of Caja) optionally
 * uploads its receipt to the private bucket and then calls register_purchase (ADR-008 / ADR-010: no file → direct call; compensation on
 * failure); rectification is rectify_purchase; freight is register_freight / assign_freight_to_purchase. The supplier debt they create
 * is booked by the backend.
 */
export function Fletes() {
  const fletes = useFreight();
  const [nuevoFlete, setNuevoFlete] = useState(false);
  return (
    <details className="bg-white rounded-lg border border-[#E4DCC8] p-3">
      <summary className="cursor-pointer text-sm font-semibold text-[#8A6A2E]">Fletes registrados{fletes.data ? ` (${fletes.data.length})` : ''}</summary>
      <div className="mt-2 space-y-2">
        <div className="flex justify-end">
          <button type="button" onClick={() => setNuevoFlete(true)} className="text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200">Registrar flete</button>
        </div>
        {fletes.isLoading ? <p className="text-sm text-gray-500">Cargando fletes...</p>
          : fletes.error ? <p className="text-sm text-red-700">{errorMessage(fletes.error)}</p>
            : (fletes.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay fletes registrados.</p>
              : (fletes.data ?? []).map((f) => (
                <div key={f.id} className="rounded border border-[#E4DCC8] p-2 flex items-center justify-between gap-2 text-sm">
                  <span>{formatearFechaLocal(f.economic_date)} · {f.supplier_nombre ?? 'Sin proveedor'}{f.document_ref ? ` · ${f.document_ref}` : ''}</span>
                  <span className="font-bold">{formatoPesos(f.amount)}</span>
                </div>
              ))}
      </div>
      {nuevoFlete && <FleteModal onClose={() => setNuevoFlete(false)} />}
    </details>
  );
}

const LINEA_VACIA: PurchaseLineInput = { producto_id: null, feed_ingredient_id: null, descripcion: '', cantidad: 1, unit_type: 'UNIT', precio_unitario: 0 };

/**
 * Nuevo gasto (Caja's floating button), in the owner's order: concept, supplier (or "Sin proveedor"), amount and date, category,
 * nature, payment state, receipt / invoice (optional). Each combination goes to the existing RPC of src/target/expenses.ts — the
 * same the WhatsApp bot uses, so the same duplicate controls (invoice number per supplier, fiscal document per issuer). "Pendiente de
 * pago" moves no money; "Pagado" records ONE payment on its account and real date, and a Mercado Pago payment waits for its movement
 * (never a second one). One idempotency key per opened form.
 */
export function NuevaCompraModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const facturas = useInvoicePaymentStatus(false, 500);   // the same list as Cuentas a pagar → Gastos (shared cache)
  const registrar = useRegisterExpense();
  const proveedores = useSuppliers();
  const categorias = useExpenseCategories();
  const cuentas = useFinancialAccounts();
  const [concepto, setConcepto] = useState('');
  const [proveedorId, setProveedorId] = useState('');   // '' = Sin proveedor
  const [total, setTotal] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [categoriaId, setCategoriaId] = useState('');
  const [naturaleza, setNaturaleza] = useState<PurchaseNature>('OPERATING');
  const [estado, setEstado] = useState<EstadoPago>('PENDIENTE');
  const [medio, setMedio] = useState<MedioPago>('TRANSFER');
  const [cuentaId, setCuentaId] = useState('');
  const [fechaPago, setFechaPago] = useState(getTodayDate());
  const [comprobante, setComprobante] = useState<ComprobanteForm>(COMPROBANTE_VACIO);
  const [clave] = useState(() => `GASTO-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const conProveedor = proveedorId !== '';
  const fiscalDatos = fiscalInput(comprobante.fiscal, fecha);
  const cuitEmisor = cuitOrNull(comprobante.cuitEmisor);
  const cuentasMedio = (cuentas.data ?? []).filter((a) => cuentaAdmitida(medio, a.account_type));
  const cuentaElegida = estado === 'PAGADO' ? (medio === 'MERCADOPAGO' ? cuentasMedio[0]?.id ?? '' : cuentaId) : '';
  const ruta = rutaGasto({ supplierId: proveedorId || null, estado, medio: estado === 'PAGADO' ? medio : null, fecha, fechaPago });
  const repetida = conProveedor && facturaRepetida(facturas.data ?? [], proveedorId, comprobante.numero);
  const parecido = !repetida && posibleDuplicado(facturas.data ?? [], proveedorId, fecha, Number(total));
  const fiscalOk = comprobante.fiscal.tipo === '' || (fiscalDatos !== null && (conProveedor || cuitEmisor !== null));
  const pagoOk = estado === 'PENDIENTE'
    || (ruta !== 'PROVEEDOR_MP_NO_PERMITIDO' && cuentaElegida !== '' && (medio === 'MERCADOPAGO' || (fechaPago !== '' && fechaPago >= fecha)));
  const puede = !!user && concepto.trim() !== '' && concepto.trim().length <= 100 && Number(total) > 0 && fecha !== '' && categoriaId !== ''
    && !comprobante.errorArchivo && fiscalOk && pagoOk && !repetida;
  const elegirSub = (id: string) => { setCategoriaId(id); if (id) setNaturaleza(defaultNatureOf(categorias.data ?? [], id)); };

  return (
    <Modal titulo="Nuevo gasto" onClose={onClose} puedeGuardar={puede} guardando={registrar.isPending}
      error={comprobante.errorArchivo ?? registrar.error ?? proveedores.error ?? categorias.error ?? cuentas.error} textoGuardar="Registrar gasto"
      onSubmit={() => registrar.mutate({
        userId: user!.id, files: comprobante.archivos, concept: concepto, supplierId: proveedorId || null, amountTotal: Number(total), fecha,
        categoryId: categoriaId, nature: naturaleza, estado, medio: estado === 'PAGADO' ? medio : null, accountId: cuentaElegida || null,
        fechaPago: medio === 'MERCADOPAGO' ? fecha : fechaPago, invoiceNumber: comprobante.numero.trim() || null, fiscal: fiscalDatos,
        cuitEmisor: conProveedor ? null : cuitEmisor, nombreEmisor: conProveedor ? null : comprobante.nombreEmisor, idempotencyKey: clave,
      }, { onSuccess: onClose })}>
      <label className={etiqueta}>Concepto del gasto
        <input type="text" value={concepto} onChange={(e) => setConcepto(e.target.value)} maxLength={100} placeholder="Ej.: maíz, gasoil, reparación de la bomba"
          className={`${campo} text-base`} autoFocus />
      </label>
      <label className={etiqueta}>Proveedor
        <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={campo}>
          <option value="">Sin proveedor</option>
          {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </label>
      {!conProveedor && <p className="text-xs text-[#8A7A5C]">Sin proveedor: para pagarlo después con cheque o eCheq habrá que vincularlo a un proveedor.</p>}
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Importe total
          <input type="number" min="0" step="0.01" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} />
        </label>
        <label className={etiqueta}>Fecha
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
        </label>
      </div>
      {parecido && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">Ya hay un gasto de ese proveedor con la misma fecha y el mismo total. Revisá que no esté cargado (por ejemplo, desde WhatsApp).</p>}
      <SelectorCategoria subcategoriaId={categoriaId} onSubcategoria={elegirSub} campo={campo} etiqueta={etiqueta} />
      <SelectorNaturaleza value={naturaleza} onChange={setNaturaleza} />
      <fieldset className="space-y-2">
        <legend className={etiqueta}>Estado del pago</legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Estado del pago">
          {(['PENDIENTE', 'PAGADO'] as const).map((e) => (
            <button key={e} type="button" role="radio" aria-checked={estado === e} onClick={() => setEstado(e)}
              className={`py-2 rounded-lg text-sm font-medium border ${estado === e ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-gray-700 border-gray-300'}`}>
              {e === 'PENDIENTE' ? 'Pendiente de pago' : 'Pagado'}
            </button>
          ))}
        </div>
        {estado === 'PENDIENTE' ? (
          <p className="text-xs text-[#6B5D45]">No mueve dinero. Queda en Cuentas a pagar → Gastos → Pendientes de pago.</p>
        ) : (
          <div className="space-y-2 border border-[#E4DCC8] rounded-lg p-2">
            <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Medio de pago">
              {(['CASH', 'TRANSFER', 'MERCADOPAGO'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={medio === m} onClick={() => { setMedio(m); setCuentaId(''); }}
                  className={`py-1.5 rounded text-xs font-medium ${medio === m ? 'bg-amber-600 text-white' : 'bg-stone-100 text-gray-700'}`}>{MEDIO_PAGO_LABEL[m]}</button>
              ))}
            </div>
            {ruta === 'PROVEEDOR_MP_NO_PERMITIDO' ? (
              <p className="text-xs text-red-700" role="alert">Un pago a proveedor con Mercado Pago se registra al clasificar su movimiento (Movimientos → Por resolver), para no duplicarlo. Elegí «Pendiente de pago».</p>
            ) : medio === 'MERCADOPAGO' ? (
              <p className="text-xs text-[#6B5D45]">Queda registrado como pagado con Mercado Pago y se vincula a su movimiento cuando llegue: no se crea otro movimiento.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className={etiqueta}>Cuenta
                  <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
                    <option value="">Elegir…</option>
                    {cuentasMedio.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                  </select>
                </label>
                <label className={etiqueta}>Fecha real del pago
                  <input type="date" value={fechaPago} min={fecha} onChange={(e) => setFechaPago(e.target.value)} className={campo} />
                </label>
              </div>
            )}
            {medio !== 'MERCADOPAGO' && fechaPago !== '' && fechaPago < fecha && <p className="text-xs text-red-700">El pago no puede ser anterior a la fecha del gasto.</p>}
          </div>
        )}
      </fieldset>
      <BloqueComprobante value={comprobante} onChange={setComprobante} conProveedor={conProveedor} conArchivos />
      {repetida && <p className="text-xs text-red-700" role="alert">Ese proveedor ya tiene una factura con ese número: buscala en Cuentas a pagar → Gastos en lugar de cargarla de nuevo.</p>}
    </Modal>
  );
}

/** The three natures, on the existing internal values. */
export function SelectorNaturaleza({ value, onChange }: { value: PurchaseNature; onChange: (n: PurchaseNature) => void }) {
  return (
    <label className={etiqueta}>Naturaleza
      <select value={value} onChange={(e) => onChange(e.target.value as PurchaseNature)} className={campo}>
        {NATURALEZA_GASTO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}


/**
 * Factura o comprobante (optional, folded): the file, the invoice number and — only when a document type is chosen — the fiscal
 * data as printed (nothing derived). Without supplier the invoice identifies its issuer by CUIT (the backend's rule).
 */
export function BloqueComprobante({ value, onChange, conProveedor, conArchivos, conNumero = true }: {
  value: ComprobanteForm; onChange: (v: ComprobanteForm) => void; conProveedor: boolean; conArchivos: boolean; conNumero?: boolean;
}) {
  const set = (p: Partial<ComprobanteForm>) => onChange({ ...value, ...p });
  function elegirArchivos(lista: FileList | null) {
    const files = Array.from(lista ?? []);
    let error: unknown = null;
    try { validateAttachments(files); } catch (e) { error = files.length ? e : null; }
    set({ archivos: files, errorArchivo: error });
  }
  return (
    <details className="border border-[#E4DCC8] rounded-lg p-2" open={value.fiscal.tipo !== '' || value.numero !== '' || value.archivos.length > 0}>
      <summary className="text-sm text-[#8A6A2E] cursor-pointer">Factura o comprobante (opcional)</summary>
      <div className="space-y-2 mt-2">
        {conArchivos && (
          <label className={etiqueta}>Foto o PDF
            <input type="file" multiple accept={Object.keys(ATTACHMENT_TYPES).join(',')} onChange={(e) => elegirArchivos(e.target.files)} className={campo} />
            <span className="block text-xs text-gray-500">PDF, JPG, PNG o WebP; hasta 10 MB.</span>
          </label>
        )}
        {conNumero && (
          <label className={etiqueta}>Nº de factura
            <input type="text" value={value.numero} onChange={(e) => set({ numero: e.target.value })} maxLength={100} placeholder="0001-00001234" className={campo} />
          </label>
        )}
        <DatosFiscales value={value.fiscal} onChange={(fiscal) => set({ fiscal })} />
        {!conProveedor && value.fiscal.tipo !== '' && (
          <div className="grid grid-cols-2 gap-2">
            <label className={etiqueta}>CUIT del emisor
              <input type="text" inputMode="numeric" value={value.cuitEmisor} onChange={(e) => set({ cuitEmisor: e.target.value })} placeholder="30-12345678-9" className={campo} />
            </label>
            <label className={etiqueta}>Razón social (opcional)
              <input type="text" value={value.nombreEmisor} onChange={(e) => set({ nombreEmisor: e.target.value })} maxLength={120} className={campo} />
            </label>
            {value.cuitEmisor !== '' && cuitOrNull(value.cuitEmisor) === null && <p className="col-span-2 text-xs text-red-700">El CUIT tiene 11 dígitos.</p>}
          </div>
        )}
      </div>
    </details>
  );
}

export function RectificarCompraModal({ compra, onClose }: { compra: PurchaseRow; onClose: () => void }) {
  const { rectifyPurchase } = useTreasuryMutations();
  const [neto, setNeto] = useState(compra.amount_net === compra.amount_total ? '' : String(compra.amount_net));   // empty = same as total
  const [total, setTotal] = useState(String(compra.amount_total));
  const sinLineas = compra.lineas.length === 0;
  const [lineas, setLineas] = useState<PurchaseLineInput[]>(compra.lineas.map((l) => ({
    producto_id: l.producto_id, feed_ingredient_id: l.feed_ingredient_id, descripcion: l.descripcion, cantidad: l.cantidad,
    unit_type: l.unit_type, precio_unitario: l.precio_unitario,
  })));
  const [motivo, setMotivo] = useState('');
  const set = (i: number, k: 'cantidad' | 'precio_unitario', v: string) =>
    setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: Number(v) } : l)));
  const puede = Number(total) > 0 && motivo.trim() !== '' && (sinLineas || lineas.length > 0);
  // D-WALK-4: rectify_purchase needs lines; a purchase recorded without items is rectified with one default line
  const lineasEnvio = (): PurchaseLineInput[] => (sinLineas ? [{ ...LINEA_VACIA, descripcion: 'Compra', cantidad: 1, precio_unitario: Number(total) }] : lineas);

  return (
    <Modal titulo={`Rectificar compra — ${compra.supplier_nombre}`} onClose={onClose} puedeGuardar={puede} guardando={rectifyPurchase.isPending}
      error={rectifyPurchase.error} textoGuardar="Rectificar"
      onSubmit={() => rectifyPurchase.mutate({ purchaseId: compra.id, amountNet: neto === '' ? Number(total) : Number(neto), amountTotal: Number(total), lines: lineasEnvio(), reason: motivo },
        { onSuccess: onClose })}>
      <label className={etiqueta}>Total
        <input type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} />
      </label>
      <details className="border border-[#E4DCC8] rounded-lg p-2">
        <summary className="text-sm text-[#8A6A2E] cursor-pointer">Más datos</summary>
        <label className={etiqueta}>Neto (si es distinto del total)
          <input type="number" min="0" step="0.01" value={neto} placeholder={total} onChange={(e) => setNeto(e.target.value)} className={campo} />
        </label>
      </details>
      {sinLineas && <p className="text-xs text-gray-500">La compra no tiene ítems: se registra como un único ítem "Compra" por el total.</p>}
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

export function FleteModal({ onClose }: { onClose: () => void }) {
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
      <SelectorCategoria subcategoriaId={categoriaId} onSubcategoria={setCategoriaId} campo={campo} etiqueta={etiqueta} />
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

export function AsignarFleteModal({ purchaseId, fletes, onClose }: { purchaseId: string; fletes: FreightRow[]; onClose: () => void }) {
  const { assignFreight } = useTreasuryMutations();
  const [fleteId, setFleteId] = useState('');
  const [monto, setMonto] = useState('');
  const puede = fleteId !== '' && Number(monto) > 0;

  return (
    <Modal titulo="Asignar flete a la compra" onClose={onClose} puedeGuardar={puede} guardando={assignFreight.isPending} error={assignFreight.error}
      textoGuardar="Asignar"
      onSubmit={() => assignFreight.mutate({ freightId: fleteId, purchaseId, amount: Number(monto) }, { onSuccess: onClose })}>
      {fletes.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay fletes registrados. Usá "Registrar flete" primero.</p>}
      <label className={etiqueta}>Flete
        <select value={fleteId} onChange={(e) => setFleteId(e.target.value)} className={campo}>
          <option value="">Elegir flete…</option>
          {fletes.map((f) => <option key={f.id} value={f.id}>{formatearFechaLocal(f.economic_date)} · {f.supplier_nombre ?? 'Sin proveedor'} · {formatoPesos(f.amount)}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Monto a asignar
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}

// ── D-FISCAL-4 / D-FISCAL-5: optional fiscal data of a purchase (ADR-015) ──────────────────────────
const TIPO_COMPROBANTE: [FiscalDocumentType, string][] = [['INVOICE_A', 'Factura A'], ['INVOICE_B', 'Factura B'], ['INVOICE_C', 'Factura C'], ['RECEIPT', 'Recibo'], ['OTHER', 'Otro']];
const IMPUESTO: Record<TaxKind, string> = { IVA: 'IVA', IIBB: 'IIBB', GANANCIAS: 'Ganancias', RETENTION: 'Retención', PERCEPTION: 'Percepción', OTHER: 'Otro' };
function DatosFiscales({ value, onChange }: { value: FiscalForm; onChange: (v: FiscalForm) => void }) {
  const set = (patch: Partial<FiscalForm>) => onChange({ ...value, ...patch });
  const setComp = (i: number, patch: Partial<ComponenteForm>) => set({ componentes: value.componentes.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <details className="border border-[#E4DCC8] rounded-lg p-2">
      <summary className="text-sm text-[#8A6A2E] cursor-pointer">Datos fiscales (opcional)</summary>
      <div className="space-y-2 mt-2">
        <div className="grid grid-cols-2 gap-2">
          <label className={etiqueta}>Tipo de comprobante
            <select value={value.tipo} onChange={(e) => set({ tipo: e.target.value as FiscalDocumentType | '' })} className={campo}>
              <option value="">Sin datos fiscales</option>
              {TIPO_COMPROBANTE.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
            </select>
          </label>
          <label className={etiqueta}>Período fiscal
            <input type="month" value={value.periodo} onChange={(e) => set({ periodo: e.target.value })} className={campo} />
          </label>
        </div>
        {value.tipo !== '' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className={etiqueta}>Neto del comprobante<input type="number" min="0" step="0.01" value={value.neto} onChange={(e) => set({ neto: e.target.value })} className={campo} /></label>
              <label className={etiqueta}>Total del comprobante<input type="number" min="0" step="0.01" value={value.total} onChange={(e) => set({ total: e.target.value })} className={campo} /></label>
            </div>
            {value.componentes.map((c, i) => (
              <div key={i} className="grid grid-cols-4 gap-2 items-end">
                <label className="text-xs text-gray-600">Impuesto
                  <select value={c.tax_kind} onChange={(e) => setComp(i, { tax_kind: e.target.value as TaxKind })} className={campo}>
                    {TAX_KINDS.map((k) => <option key={k} value={k}>{IMPUESTO[k]}</option>)}
                  </select>
                </label>
                <label className="text-xs text-gray-600">Base<input type="number" min="0" step="0.01" value={c.base} onChange={(e) => setComp(i, { base: e.target.value })} className={campo} /></label>
                <label className="text-xs text-gray-600">Alícuota %<input type="number" min="0" step="0.01" value={c.alicuota} onChange={(e) => setComp(i, { alicuota: e.target.value })} className={campo} /></label>
                <label className="text-xs text-gray-600">Importe<input type="number" min="0" step="0.01" value={c.importe} onChange={(e) => setComp(i, { importe: e.target.value })} className={campo} /></label>
              </div>
            ))}
            <button type="button" onClick={() => set({ componentes: [...value.componentes, { tax_kind: 'PERCEPTION', base: '', alicuota: '', importe: '' }] })}
              className="text-xs text-[#A8552E] hover:underline">+ Otro impuesto (percepción, IIBB…)</button>
            <p className="text-xs text-gray-500">Cargá los importes tal como figuran en el comprobante; no se calculan. El Nº de comprobante es el de arriba. La compra y su comprobante se guardan juntos.</p>
          </>
        )}
      </div>
    </details>
  );
}
