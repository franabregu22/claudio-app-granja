import { useState } from 'react';
import {
  ACCION_AUDITORIA, cambiosAuditoria, COMPROBANTE_VACIO, fiscalJson, NATURALEZA_GASTO_LABEL, reglasDeCompra, type ComprobanteForm, type VinculosGasto,
} from '../../target/expenses';
import { errorMessage } from '../../target/messages';
import { cuitOrNull, fiscalInput } from '../../target/fiscal';
import type { PurchaseNature, PurchaseRow } from '../../target/treasury';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { BloqueComprobante, SelectorNaturaleza } from './Compras';
import { campo, etiqueta, Modal } from './Modal';
import { SelectorCategoria } from './SelectorCategoria';
import { useExpenseAudit, useRectifyExpense } from './useExpenses';
import { useAllExpenseSubcategories, useSuppliers } from './useTreasury';
import { useProfileEmails } from './useUnclassified';


/**
 * Editar / Rectificar (0117): ONE audited rectification (rectify_purchase_details) — a new version of the expense, the old one kept;
 * who, when, why and every field before / after go to the audit. Fields its links lock are shown read-only with the reason. The
 * payment state is not edited here: a payment is registered from the expense (or the supplier) and a recorded one is never undone.
 */
export function EditarGastoModal({ compra, vinculos, onClose }: { compra: PurchaseRow; vinculos: VinculosGasto; onClose: () => void }) {
  const reglas = reglasDeCompra(compra, vinculos);
  const proveedores = useSuppliers();
  const rectificar = useRectifyExpense();
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
  const fiscal = fiscalInput(comprobante.fiscal, fecha);
  const cuit = cuitOrNull(comprobante.cuitEmisor);
  const conFiscalNuevo = comprobante.fiscal.tipo !== '';
  const importe = Number(total);
  const neto = fiscal ? fiscal.netAmount : importe === compra.amount_total ? compra.amount_net : importe;
  const cambio = concepto.trim() !== (compra.subcategory ?? '') || proveedorId !== (compra.supplier_id ?? '') || fecha !== compra.economic_date
    || importe !== compra.amount_total || categoriaId !== compra.expense_category_id || naturaleza !== compra.nature
    || numero.trim() !== (compra.supplier_invoice_number ?? '') || conFiscalNuevo;
  const fiscalOk = !conFiscalNuevo || (fiscal !== null && (conProveedor || cuit !== null));
  const puede = cambio && motivo.trim() !== '' && concepto.trim() !== '' && concepto.trim().length <= 100 && importe > 0 && fecha !== '' && categoriaId !== ''
    && fiscalOk && (!conProveedor || proveedorId !== '');
  const bloqueado = (activo: boolean) => (activo ? campo : `${campo} bg-stone-100 text-gray-500`);

  return (
    <Modal titulo={`Editar / Rectificar — ${compra.subcategory ?? compra.supplier_nombre}`} onClose={onClose} puedeGuardar={puede} guardando={rectificar.isPending}
      error={rectificar.error ?? proveedores.error} textoGuardar="Guardar rectificación"
      onSubmit={() => rectificar.mutate({
        purchaseId: compra.id, concept: concepto, categoryId: categoriaId, nature: naturaleza, fecha, supplierId: conProveedor ? proveedorId : null,
        invoiceNumber: conProveedor ? numero : compra.supplier_invoice_number, amountTotal: importe, amountNet: neto, reason: motivo,
        fiscal: fiscal ? fiscalJson(fiscal, { fecha, numero: conProveedor ? numero : comprobante.numero, cuitEmisor: conProveedor ? null : cuit,
          nombreEmisor: conProveedor ? null : comprobante.nombreEmisor }) : null,
      }, { onSuccess: onClose })}>
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
        ) : <input value={`Sin proveedor${compra.counterparty_name ? ` (${compra.counterparty_name})` : ''}`} disabled className={bloqueado(false)} />}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Importe total
          <input type="number" min="0" step="0.01" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} disabled={!reglas.importe} className={bloqueado(reglas.importe)} />
        </label>
        <label className={etiqueta}>Fecha
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} disabled={!reglas.fecha} className={bloqueado(reglas.fecha)} />
        </label>
      </div>
      {vinculos.asignado > 0 && <p className="text-xs text-[#8A7A5C]">Asignado en pagos y cheques: {formatoPesos(vinculos.asignado)} (el importe no puede quedar por debajo).</p>}
      <SelectorCategoria subcategoriaId={categoriaId} onSubcategoria={setCategoriaId} campo={campo} etiqueta={etiqueta} />
      <SelectorNaturaleza value={naturaleza} onChange={setNaturaleza} />
      <div className="text-sm border border-[#E4DCC8] rounded-lg p-2">
        <p className="font-medium text-gray-700">Estado del pago: {vinculos.estadoPago}</p>
        <p className="text-xs text-[#6B5D45]">{vinculos.comoPagar}</p>
      </div>
      {conProveedor && (
        <label className={etiqueta}>Nº de factura
          <input type="text" value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={100} disabled={!reglas.numero} className={bloqueado(reglas.numero)} />
        </label>
      )}
      {reglas.agregarFactura
        ? <BloqueComprobante value={comprobante} onChange={setComprobante} conProveedor={conProveedor} conArchivos={false} conNumero={!conProveedor} />
        : <p className="text-xs text-blue-800">Tiene comprobante fiscal registrado (en Fiscal).</p>}
      {reglas.motivos.length > 0 && (
        <ul className="text-xs text-[#8A7A5C] list-disc pl-4 space-y-0.5">{reglas.motivos.map((m) => <li key={m}>{m}</li>)}</ul>
      )}
      <label className={etiqueta}>Motivo de la corrección
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} placeholder="Ej.: el bot leyó mal el importe" className={campo} />
      </label>
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
