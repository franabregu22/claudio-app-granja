import { useState } from 'react';
import { splitByKg, type FeedPurchase } from '../../../target/alimento';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { fechaCorta, fechaDMA, kgTxt, pesos } from './format';
import { botonPrimario, Tabla, Titulo, td, tdR, thL, thR } from './ui';
import { useAlimentoMutations, useFeedFreights, useFeedPurchases } from './useAlimento';
import { NumeroInput } from '../../../components/NumeroInput';

type Filtro = 'TODAS' | 'SIN_KG' | 'FLETE';

/**
 * Compras e insumos (ADMIN): the purchases of the categories marked as an ingredient (Administración → Categorías de
 * gasto), their kg, and the split of a feed-freight expense over one or several purchases. Every amount and cost per
 * kg is the backend's (report_feed_purchase): Factura A without VAT, any other at its total.
 */
export function Compras() {
  const compras = useFeedPurchases();
  const fletes = useFeedFreights();
  const m = useAlimentoMutations();
  const [filtro, setFiltro] = useState<Filtro>('TODAS');
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [kgDe, setKgDe] = useState<FeedPurchase | null>(null);
  const [vinculando, setVinculando] = useState(false);
  const todas = compras.data ?? [];
  const sinKg = todas.filter((c) => c.quantity_kg === null);
  const pendFlete = todas.filter((c) => c.quantity_kg !== null && c.freight_status === 'PENDIENTE');
  const lista = filtro === 'SIN_KG' ? sinKg : filtro === 'FLETE' ? pendFlete : todas;
  const elegible = (c: FeedPurchase) => c.quantity_kg !== null && !c.no_freight;
  const alternar = (id: string) => setElegidas((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const tab = (id: Filtro, label: string) => (
    <button onClick={() => setFiltro(id)} className={`text-sm px-3 py-1.5 rounded-lg ${filtro === id ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'}`}>{label}</button>
  );

  if (compras.isLoading) return <p className="text-sm text-gray-500">Cargando compras…</p>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-2 flex-wrap">{tab('TODAS', 'Todas')}{tab('SIN_KG', `Sin kilos (${sinKg.length})`)}{tab('FLETE', `Flete pendiente (${pendFlete.length})`)}</div>
        <button className={botonPrimario} disabled={elegidas.length === 0} onClick={() => setVinculando(true)}>Vincular flete a {elegidas.length || ''} compra{elegidas.length === 1 ? '' : 's'}</button>
      </div>
      <Titulo info={<><p>Costo final/kg = (importe + flete) ÷ kg. Con Factura A se toma el importe sin IVA (también el del flete); el resto, el total.</p>
        <p>Las compras salen de las categorías marcadas como insumo en Administración → Categorías de gasto. Desde noviembre 2026 no van al estado de resultados: va el alimento consumido.</p></>}>
        Compras de materias primas
      </Titulo>
      {todas.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay compras de insumos. Marcá las categorías de insumo en Administración → Categorías de gasto.</p> : (
        <Tabla cabecera={<><th className={thL} /><th className={thL}>Fecha</th><th className={thL}>Insumo</th><th className={thR}>Kg</th><th className={`${thL} hidden md:table-cell`}>Proveedor</th>
          <th className={thR}>Precio/kg</th><th className={thR}>Flete</th><th className={thR}>Costo final/kg</th><th className={thL}>Estado</th></>}>
          {lista.map((c) => (
            <tr key={c.purchase_root_id}>
              <td className={td}>{elegible(c) && <input type="checkbox" aria-label="Elegir para el flete" checked={elegidas.includes(c.purchase_root_id)} onChange={() => alternar(c.purchase_root_id)} />}</td>
              <td className={td}>{fechaDMA(c.economic_date)}</td>
              <td className={td}>{c.ingredient_nombre}{c.invoice_a && <span className="ml-1 text-[10px] bg-gray-100 text-gray-700 px-1 rounded">Fact. A</span>}</td>
              <td className={tdR}><button className="text-[#A8552E] hover:underline" onClick={() => setKgDe(c)}>{c.quantity_kg === null ? 'cargar' : kgTxt(c.quantity_kg)}</button></td>
              <td className={`${td} hidden md:table-cell`}>{c.supplier_name ?? '—'}</td>
              <td className={tdR}>{pesos(c.price_per_kg)}</td>
              <td className={tdR}>{c.freight_amount > 0 ? pesos(c.freight_cost) : '—'}</td>
              <td className={tdR}>{pesos(c.cost_per_kg)}</td>
              <td className={td}>{c.quantity_kg === null ? <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">Faltan kilos</span>
                : c.freight_status === 'PENDIENTE' ? <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">Flete pendiente</span>
                  : <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800">{c.freight_status === 'SIN_FLETE' ? 'Sin flete' : 'Completa'}</span>}</td>
            </tr>
          ))}
        </Tabla>
      )}
      {kgDe && <KgModal compra={kgDe} onClose={() => setKgDe(null)} />}
      {vinculando && <FleteModal compras={todas.filter((c) => elegidas.includes(c.purchase_root_id))} fletes={(fletes.data ?? []).filter((f) => f.remaining > 0)}
        onClose={() => setVinculando(false)} onListo={() => { setVinculando(false); setElegidas([]); }} guardando={m.freight.isPending} error={m.freight.error}
        onGuardar={(freightPurchaseId, allocations, listo) => m.freight.mutate({ freightPurchaseId, allocations }, { onSuccess: listo })} />}
    </div>
  );
}

function KgModal({ compra, onClose }: { compra: FeedPurchase; onClose: () => void }) {
  const m = useAlimentoMutations();
  const [kg, setKg] = useState(compra.quantity_kg === null ? '' : String(compra.quantity_kg));
  const [sinFlete, setSinFlete] = useState(compra.no_freight);
  const n = Number(kg);
  return (
    <Modal titulo={`Kilos — ${compra.ingredient_nombre} ${fechaDMA(compra.economic_date)}`} onClose={onClose} guardando={m.kg.isPending} error={m.kg.error}
      puedeGuardar={n > 0 && (n !== compra.quantity_kg || sinFlete !== compra.no_freight)}
      onSubmit={() => m.kg.mutate({ purchaseId: compra.purchase_id, kg: n, noFreight: sinFlete }, { onSuccess: onClose })}>
      <p className="text-sm text-gray-700">{compra.supplier_name ?? '—'} · {pesos(compra.cost_amount)}{compra.invoice_a ? ' sin IVA (Factura A)' : ''}</p>
      <label className={etiqueta}>Kilos comprados<NumeroInput min="0" step="0.001" value={kg} onChange={(e) => setKg(e.target.value)} className={campo} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sinFlete} disabled={compra.freight_amount > 0} onChange={(e) => setSinFlete(e.target.checked)} />
        Confirmar flete $0 (vino sin flete o el flete está incluido en el precio)</label>
      {n > 0 && <p className="text-xs text-gray-600">Precio/kg: {pesos(compra.cost_amount / n)}</p>}
    </Modal>
  );
}

function FleteModal({ compras, fletes, guardando, error, onClose, onListo, onGuardar }: {
  compras: FeedPurchase[]; fletes: { purchase_id: string; economic_date: string; supplier_name: string | null; supplier_invoice_number: string | null; amount_total: number; remaining: number }[];
  guardando: boolean; error: unknown; onClose: () => void; onListo: () => void;
  onGuardar: (freightPurchaseId: string, allocations: { purchaseId: string; amount: number }[], listo: () => void) => void;
}) {
  const [fleteId, setFleteId] = useState(fletes[0]?.purchase_id ?? '');
  const elegido = fletes.find((f) => f.purchase_id === fleteId);
  const [monto, setMonto] = useState<string | null>(null);
  const [modo, setModo] = useState<'KG' | 'MANUAL'>('KG');
  const [manual, setManual] = useState<Record<string, string>>({});
  const saldo = elegido?.remaining ?? 0;
  const total = modo === 'KG' ? (monto === null ? saldo : Number(monto)) : compras.reduce((s, c) => s + (Number(manual[c.purchase_root_id]) || 0), 0);
  const partes = modo === 'KG' ? splitByKg(total, compras.map((c) => ({ id: c.purchase_root_id, kg: c.quantity_kg ?? 0 })))
    : Object.fromEntries(compras.map((c) => [c.purchase_root_id, Number(manual[c.purchase_root_id]) || 0]));
  const valido = !!elegido && total > 0 && total <= saldo + 0.001 && compras.every((c) => (partes[c.purchase_root_id] ?? 0) > 0);
  return (
    <Modal titulo="Vincular flete" onClose={onClose} guardando={guardando} error={error} puedeGuardar={valido} textoGuardar="Vincular"
      onSubmit={() => onGuardar(fleteId, compras.map((c) => ({ purchaseId: c.purchase_id, amount: Math.round(partes[c.purchase_root_id] * 100) / 100 })), onListo)}>
      {fletes.length === 0 ? <p className="text-sm text-amber-800">No hay fletes con saldo. Cargá el flete en Caja como gasto en una categoría marcada como «flete de insumos».</p> : (
        <label className={etiqueta}>Flete (gasto de Caja)
          <select value={fleteId} onChange={(e) => { setFleteId(e.target.value); setMonto(null); }} className={campo}>
            {fletes.map((f) => <option key={f.purchase_id} value={f.purchase_id}>{fechaCorta(f.economic_date)} · {f.supplier_name ?? '—'}{f.supplier_invoice_number ? ` · ${f.supplier_invoice_number}` : ''} · {pesos(f.amount_total)}{f.remaining < f.amount_total ? ` · saldo ${pesos(f.remaining)}` : ''}</option>)}
          </select>
        </label>
      )}
      {elegido && <p className="text-xs text-gray-600">Saldo sin asignar: <b>{pesos(saldo)}</b></p>}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="radio" checked={modo === 'KG'} onChange={() => setModo('KG')} /> Proporcional por kg</label>
        <label className="flex items-center gap-1"><input type="radio" checked={modo === 'MANUAL'} onChange={() => setModo('MANUAL')} /> Manual</label>
      </div>
      {modo === 'KG' && elegido && <label className={etiqueta}>Monto a repartir ($)<NumeroInput min="0" max={saldo} step="0.01" value={monto ?? String(saldo)} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>}
      <div className="space-y-1 text-sm">
        {compras.map((c) => (
          <div key={c.purchase_root_id} className="grid grid-cols-[1fr_8rem] gap-2 items-center">
            <span>{c.ingredient_nombre} · {fechaCorta(c.economic_date)} · {kgTxt(c.quantity_kg)}</span>
            {modo === 'KG' ? <span className="text-right">{pesos(partes[c.purchase_root_id] ?? 0)}</span> : (
              <NumeroInput min="0" step="0.01" aria-label={`Flete ${c.ingredient_nombre}`} value={manual[c.purchase_root_id] ?? ''}
                onChange={(e) => setManual((x) => ({ ...x, [c.purchase_root_id]: e.target.value }))} className="border border-gray-300 rounded px-2 py-1 text-right" />
            )}
          </div>
        ))}
      </div>
      <p className={`text-xs ${total <= saldo + 0.001 ? 'text-gray-600' : 'text-red-700'}`}>Asignado {pesos(total)} · queda {pesos(Math.round((saldo - total) * 100) / 100)} del flete{total > saldo + 0.001 ? ' — supera el saldo' : ''}</p>
    </Modal>
  );
}
