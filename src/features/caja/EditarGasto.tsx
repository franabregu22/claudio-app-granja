import { Lock } from 'lucide-react';
import { useState } from 'react';
import {
  ACCION_AUDITORIA, cambiosAuditoria, COMPROBANTE_VACIO, fiscalJson, NATURALEZA_GASTO_LABEL, reglasDeCompra, type ComprobanteForm, type VinculosGasto,
} from '../../target/expenses';
import { errorMessage } from '../../target/messages';
import { cuitOrNull, fiscalDeGasto } from '../../target/fiscal';
import type { PurchaseNature, PurchaseRow } from '../../target/treasury';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { BloqueComprobante, SelectorNaturaleza } from './Compras';
import { campo, etiqueta, Modal } from './Modal';
import { SelectorCategoria } from './SelectorCategoria';
import { useAnnulExpense, useExpenseAudit, useRectifyExpense } from './useExpenses';
import { useAssignPayableToSupplier } from './usePaymentCalendar';
import { useAllExpenseSubcategories, useSuppliers } from './useTreasury';
import { useProfileEmails } from './useUnclassified';
import { NumeroInput } from '../../components/NumeroInput';


/**
 * Editar / Rectificar (0117): ONE audited rectification (rectify_purchase_details) — a new version of the expense, the old one kept;
 * who, when, why and every field before / after go to the audit. Fields its links lock are shown read-only with the reason. The
 * payment state is not edited here: a payment is registered from the expense (or the supplier) and a recorded one is never undone.
 */
export function EditarGastoModal({ compra, vinculos, onClose }: { compra: PurchaseRow; vinculos: VinculosGasto; onClose: () => void }) {
  const reglas = reglasDeCompra(compra, vinculos);
  const proveedores = useSuppliers();
  const rectificar = useRectifyExpense();
  const asignar = useAssignPayableToSupplier();   // 0124: a pending expense without supplier gets it right here
  const [claveAsignar] = useState(() => `VINC-${crypto.randomUUID()}`);
  const [proveedorNuevo, setProveedorNuevo] = useState('');
  const conProveedor = !!compra.supplier_id;
  const [concepto, setConcepto] = useState(compra.subcategory ?? '');
  const [proveedorId, setProveedorId] = useState(compra.supplier_id ?? '');
  const [fecha, setFecha] = useState(compra.economic_date);
  const [total, setTotal] = useState(String(compra.amount_total));
  const [categoriaId, setCategoriaId] = useState(compra.expense_category_id);
  const [naturaleza, setNaturaleza] = useState<PurchaseNature>(compra.nature);
  const [numero, setNumero] = useState(compra.supplier_invoice_number ?? '');
  const [comprobante, setComprobante] = useState<ComprobanteForm>(COMPROBANTE_VACIO);
  const [motivo, setMotivo] = useState('');
  const fiscal = fiscalDeGasto(comprobante.fiscal, Number(total), fecha);
  const cuit = cuitOrNull(comprobante.cuitEmisor);
  const conFiscalNuevo = comprobante.fiscal.tipo !== '';
  const importe = Number(total);
  const neto = fiscal ? fiscal.netAmount : importe === compra.amount_total ? compra.amount_net : importe;
  const cambioDatos = concepto.trim() !== (compra.subcategory ?? '') || proveedorId !== (compra.supplier_id ?? '') || fecha !== compra.economic_date
    || importe !== compra.amount_total || categoriaId !== compra.expense_category_id || naturaleza !== compra.nature
    || (conProveedor && numero.trim() !== (compra.supplier_invoice_number ?? '')) || conFiscalNuevo;
  const cambio = cambioDatos || proveedorNuevo !== '';
  const fiscalOk = !conFiscalNuevo || (fiscal !== null && (conProveedor || cuit !== null));
  const puede = cambio && motivo.trim() !== '' && concepto.trim() !== '' && concepto.trim().length <= 100 && importe > 0 && fecha !== '' && categoriaId !== ''
    && fiscalOk && (!conProveedor || proveedorId !== '');
  // 0124: one save = the supplier link (if chosen) and then the rectification of the new version (only if other data changed)
  const guardar = async () => {
    let purchaseId = compra.id;
    if (proveedorNuevo && vinculos.payableId) {
      const r = await asignar.mutateAsync({ payableId: vinculos.payableId, supplierId: proveedorNuevo, reason: motivo, idempotencyKey: claveAsignar, invoiceNumber: numero });
      purchaseId = r.purchase_id;
    }
    if (cambioDatos) {
      const sup = proveedorNuevo || (conProveedor ? proveedorId : null);
      await rectificar.mutateAsync({
        purchaseId, concept: concepto, categoryId: categoriaId, nature: naturaleza, fecha, supplierId: sup,
        invoiceNumber: sup ? numero : compra.supplier_invoice_number, amountTotal: importe, amountNet: neto, reason: motivo,
        fiscal: fiscal ? fiscalJson(fiscal, { fecha, numero: sup ? numero : comprobante.numero, cuitEmisor: sup ? null : cuit, nombreEmisor: sup ? null : comprobante.nombreEmisor }) : null,
      });
    }
    onClose();
  };
  const bloqueado = (activo: boolean) => (activo ? campo : `${campo} bg-stone-100 text-gray-500`);
  // caja-mejoras-v2: a lock and its reason under each locked field (the backend enforces the same rules)
  const candado = (activo: boolean, k: keyof typeof reglas.porque) => (!activo && reglas.porque[k]
    ? <span className="mt-0.5 flex items-start gap-1 text-[11px] font-normal text-[#8A7A5C]"><Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />{reglas.porque[k]}</span> : null);

  return (
    <Modal titulo={`Editar gasto — ${compra.subcategory ?? compra.supplier_nombre}`} onClose={onClose} puedeGuardar={puede} guardando={rectificar.isPending || asignar.isPending}
      error={asignar.error ?? rectificar.error ?? proveedores.error} textoGuardar="Guardar cambios"
      onSubmit={() => { guardar().catch(() => {}); }}>
      <p className="text-xs text-[#6B5D45] bg-amber-50 border border-amber-200 rounded px-2 py-1">
        Se guarda como una nueva versión del gasto; la anterior y el motivo quedan en el historial. No se duplica el gasto, la factura ni el pago.
      </p>
      <label className={etiqueta}>Concepto del gasto
        <input type="text" value={concepto} onChange={(e) => setConcepto(e.target.value)} maxLength={100} className={campo} />
      </label>
      <label className={etiqueta}>Proveedor
        {conProveedor ? (
          <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} disabled={!reglas.proveedor} className={bloqueado(reglas.proveedor)}>
            {(proveedores.data ?? []).some((p) => p.id === compra.supplier_id) ? null : <option value={compra.supplier_id!}>{compra.supplier_nombre}</option>}
            {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        ) : vinculos.pendienteSinProveedor ? (
          <select value={proveedorNuevo} onChange={(e) => setProveedorNuevo(e.target.value)} className={campo}>
            <option value="">{`Sin proveedor${compra.counterparty_name ? ` (${compra.counterparty_name})` : ''}`}</option>
            {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        ) : <input value={`Sin proveedor${compra.counterparty_name ? ` (${compra.counterparty_name})` : ''}`} disabled className={bloqueado(false)} />}
        {proveedorNuevo && <span className="mt-0.5 block text-[11px] font-normal text-[#6B5D45]">Queda como factura de ese proveedor (su deuda); los pagos ya hechos se le imputan. No se puede deshacer.</span>}
        {candado(conProveedor && reglas.proveedor, 'proveedor')}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Importe total
          <NumeroInput min="0" step="0.01" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} disabled={!reglas.importe} className={bloqueado(reglas.importe)} />
          {candado(reglas.importe, 'importe')}
        </label>
        <label className={etiqueta}>Fecha
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} disabled={!reglas.fecha} className={bloqueado(reglas.fecha)} />
          {candado(reglas.fecha, 'fecha')}
        </label>
      </div>
      {vinculos.asignado > 0 && <p className="text-xs text-[#8A7A5C]">Asignado en pagos y cheques: {formatoPesos(vinculos.asignado)} (el importe no puede quedar por debajo).</p>}
      <SelectorCategoria subcategoriaId={categoriaId} onSubcategoria={setCategoriaId} campo={campo} etiqueta={etiqueta} />
      <SelectorNaturaleza value={naturaleza} onChange={setNaturaleza} />
      <div className="text-sm border border-[#E4DCC8] rounded-lg p-2">
        <p className="font-medium text-gray-700">Estado del pago: {vinculos.estadoPago}</p>
        <p className="text-xs text-[#6B5D45]">{vinculos.comoPagar}</p>
      </div>
      {(conProveedor || proveedorNuevo !== '') && (
        <label className={etiqueta}>Nº de factura
          <input type="text" value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={100} disabled={!reglas.numero} className={bloqueado(reglas.numero)} />
          {candado(reglas.numero, 'numero')}
        </label>
      )}
      {reglas.agregarFactura
        ? <BloqueComprobante value={comprobante} onChange={setComprobante} conProveedor={conProveedor} conArchivos={false} conNumero={!conProveedor} total={total} />
        : <p className="text-xs text-blue-800">Tiene comprobante fiscal registrado (en Fiscal).</p>}
      {reglas.motivos.length > 0 && (
        <ul className="text-xs text-[#8A7A5C] list-disc pl-4 space-y-0.5">{reglas.motivos.map((m) => <li key={m}>{m}</li>)}</ul>
      )}
      <label className={etiqueta}>Motivo del cambio
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} placeholder="Ej.: el bot leyó mal el importe" className={campo} />
      </label>
    </Modal>
  );
}

/**
 * Anular (0124): an expense with nothing paid, allocated, issued or linked is annulled — it leaves the pending list, the P&L and (when its
 * period is not declared) the IVA; a supplier's debt goes back. Nothing is deleted: it stays struck through with who, when and why.
 */
export function AnularGastoModal({ compra, onClose }: { compra: PurchaseRow; onClose: () => void }) {
  const anular = useAnnulExpense();
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `ANULAR-${crypto.randomUUID()}`);
  return (
    <Modal titulo={`Anular gasto — ${compra.subcategory ?? compra.supplier_nombre ?? ''}`} onClose={onClose} puedeGuardar={motivo.trim() !== ''} guardando={anular.isPending}
      error={anular.error} textoGuardar="Anular gasto"
      onSubmit={() => anular.mutate({ purchaseId: compra.id, reason: motivo, idempotencyKey: clave }, { onSuccess: onClose })}>
      <p className="text-sm text-[#6B5D45]">{formatoPesos(compra.amount_total)} · {formatearFechaLocal(compra.economic_date)}{compra.supplier_nombre ? ` · ${compra.supplier_nombre}` : ''}</p>
      <p className="text-xs text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1">
        Sale de Cuentas a pagar, del estado de resultados y, si tiene factura, del IVA del período (si ese período no está declarado).
        Si es de un proveedor, se le descuenta la deuda. No se borra: queda tachado, con tu usuario y el motivo.
      </p>
      <label className={etiqueta}>Motivo<input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} className={campo} placeholder="Ej.: carga de prueba / duplicado" /></label>
    </Modal>
  );
}

/** Historial de cambios: every audit row of the expense (all its versions), oldest first, with who, when, why and what changed. */
export function HistorialGasto({ purchaseId, rootId }: { purchaseId: string | null; rootId: string | null }) {
  const hist = useExpenseAudit(purchaseId, rootId);
  const emails = useProfileEmails();
  const categorias = useAllExpenseSubcategories();
  const proveedores = useSuppliers();
  if (hist.isLoading) return <p className="text-xs text-gray-500">Cargando historial...</p>;
  if (hist.error) return <p className="text-xs text-red-700">{errorMessage(hist.error)}</p>;
  const filas = hist.data ?? [];
  const valor = (clave: string, v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (clave === 'amount_total' || clave === 'amount_net') return formatoPesos(Number(v));
    if (clave === 'economic_date') return formatearFechaLocal(String(v));
    if (clave === 'nature') return NATURALEZA_GASTO_LABEL[v as PurchaseNature] ?? String(v);
    if (clave === 'expense_category_id') return categorias.data?.find((c) => c.id === v)?.nombre ?? String(v);
    if (clave === 'supplier_id') return proveedores.data?.find((p) => p.id === v)?.nombre ?? String(v);
    if (clave === 'fiscal_document_id') return 'registrado';
    return String(v);
  };
  if (filas.length === 0) return <p className="text-xs text-[#8A7A5C]">Sin cambios registrados.</p>;
  return (
    <ol className="space-y-2" aria-label="Historial de cambios">
      {filas.map((r) => {
        const cambios = cambiosAuditoria(r);
        return (
          <li key={r.audit_id} className="bg-white border border-[#E4DCC8] rounded px-2 py-1.5 text-xs">
            <p className="flex flex-wrap gap-x-2">
              <span className="font-semibold">{ACCION_AUDITORIA[r.action] ?? r.action}</span>
              <span className="text-[#8A7A5C]">{new Date(r.performed_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}</span>
              <span className="text-[#8A7A5C]">{r.performed_by ? emails.data?.get(r.performed_by) ?? 'usuario' : 'sistema'}</span>
            </p>
            {r.reason && <p className="text-[#6B5D45]">Motivo: {r.reason}</p>}
            {cambios.length > 0 && (
              <ul className="mt-0.5 space-y-0.5">
                {cambios.map((c) => <li key={c.clave}>{c.campo}: <span className="line-through text-[#8A7A5C]">{valor(c.clave, c.antes)}</span> → <b>{valor(c.clave, c.despues)}</b></li>)}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
