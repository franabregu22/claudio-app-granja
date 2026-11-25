import { useState } from 'react';
import { splitByKg, type FeedPurchase, type FeedPurchaseExtra } from '../../../target/alimento';
import type { ExpenseCategoryRow } from '../../../target/masters';
import { useMasterList } from '../../admin/useMasters';
import { Comprobantes } from '../../caja/Comprobantes';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { fechaCorta, fechaDMA, kgTxt, pesos } from './format';
import { botonPrimario, Tabla, Titulo, td, tdR, thL, thR } from './ui';
import { useAlimentoMutations, useFeedFreights, useFeedPurchaseExtras, useFeedPurchases } from './useAlimento';
import { NumeroInput } from '../../../components/NumeroInput';

type Filtro = 'TODAS' | 'SIN_KG' | 'FLETE';

/** 0138: the rows of one purchase (several when its invoice brings several ingredients, one per ingredient). */
const esPrimera = (c: FeedPurchase) => c.part_position === null || c.part_position === 1;
const clave = (c: FeedPurchase) => `${c.purchase_root_id}:${c.part_position ?? 0}`;
const cent = (v: number | string) => Math.round(Number(v) * 100);

/**
 * Compras e insumos (ADMIN): the purchases of the categories marked as an ingredient (Administración → Categorías de
 * gasto), their kg, and the split of a feed-freight expense over one or several purchases. Every amount and cost per
 * kg is the backend's (report_feed_purchase): Factura A without VAT, any other at its total. An invoice with several
 * ingredients (0138) is one row per ingredient — its amount, kg and freight shared by the backend, nothing duplicated.
 */
export function Compras() {
  const compras = useFeedPurchases();
  const fletes = useFeedFreights();
  const m = useAlimentoMutations();
  const [filtro, setFiltro] = useState<Filtro>('TODAS');
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [kgDe, setKgDe] = useState<string | null>(null);   // purchase_root_id
  const [vinculando, setVinculando] = useState(false);
  const todas = compras.data ?? [];
  const extras = useFeedPurchaseExtras(todas.filter(esPrimera));
  const filasDe = (root: string) => todas.filter((c) => c.purchase_root_id === root).sort((a, b) => (a.part_position ?? 0) - (b.part_position ?? 0));
  const partes = (c: FeedPurchase) => (c.part_position === null ? 0 : todas.filter((x) => x.purchase_root_id === c.purchase_root_id).length);
  const sinKg = todas.filter((c) => c.quantity_kg === null);
  const pendFlete = todas.filter((c) => c.quantity_kg !== null && c.freight_status === 'PENDIENTE');
  const lista = filtro === 'SIN_KG' ? sinKg : filtro === 'FLETE' ? pendFlete : todas;
  const elegible = (c: FeedPurchase) => esPrimera(c) && c.quantity_kg !== null && !c.no_freight;
  const alternar = (id: string) => setElegidas((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  // the freight goes to the PURCHASE (shared by kg over its ingredients by the backend): one entry per purchase, its total kg
  const paraFlete = elegidas.map(filasDe).filter((filas) => filas.length > 0).map((filas) => {
    return { ...filas[0], ingredient_nombre: filas.map((f) => f.ingredient_nombre).join(' + '), quantity_kg: filas[0].purchase_quantity_kg ?? filas[0].quantity_kg };
  });
  const tab = (id: Filtro, label: string) => (
    <button onClick={() => setFiltro(id)} className={`text-sm px-3 py-1.5 rounded-lg ${filtro === id ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'}`}>{label}</button>
  );

  if (compras.isLoading) return <p className="text-sm text-gray-500">Cargando compras…</p>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-2 flex-wrap">{tab('TODAS', 'Todas')}{tab('SIN_KG', `Sin kilos (${sinKg.length})`)}{tab('FLETE', `Flete pendiente (${pendFlete.filter(esPrimera).length})`)}</div>
        <button className={botonPrimario} disabled={elegidas.length === 0} onClick={() => setVinculando(true)}>Vincular flete a {elegidas.length || ''} compra{elegidas.length === 1 ? '' : 's'}</button>
      </div>
      <Titulo info={<><p>Costo final/kg = (importe + flete) ÷ kg. Con Factura A se toma el importe sin IVA (también el del flete); el resto, el total.</p>
        <p>Si una factura trae varios insumos, cargalos desde los kilos («Esta factura trae varios insumos»): cada insumo queda en su fila con su precio por kg. El gasto, el pago y el IVA siguen siendo uno solo; el flete se reparte por kg.</p>
        <p>Las compras salen de las categorías marcadas como insumo en Administración → Categorías de gasto. Desde noviembre 2026 no van al estado de resultados: va el alimento consumido.</p></>}>
        Compras de materias primas
      </Titulo>
      {todas.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay compras de insumos. Marcá las categorías de insumo en Administración → Categorías de gasto.</p> : (
        <Tabla cabecera={<><th className={thL} /><th className={thL}>Fecha</th><th className={thL}>Insumo</th><th className={thR}>Kg</th><th className={`${thL} hidden md:table-cell`}>Proveedor</th>
          <th className={thR}>Precio/kg</th><th className={thR}>Flete</th><th className={thR}>Costo final/kg</th><th className={thL}>Estado</th></>}>
          {lista.map((c) => {
            const extra = extras.data?.get(c.purchase_root_id);
            const n = partes(c);
            return (
              <tr key={clave(c)} className={c.part_position !== null && c.part_position > 1 ? 'border-t-0' : undefined}>
                <td className={td}>{elegible(c) && <input type="checkbox" aria-label="Elegir para el flete" checked={elegidas.includes(c.purchase_root_id)} onChange={() => alternar(c.purchase_root_id)} />}</td>
                <td className={td}>{fechaDMA(c.economic_date)}</td>
                <td className={td}>{c.ingredient_nombre}{c.invoice_a && <span className="ml-1 text-[10px] bg-gray-100 text-gray-700 px-1 rounded">Fact. A</span>}
                  {n > 0 && <span className="ml-1 text-[10px] bg-amber-100 text-amber-900 px-1 rounded" title={`Una sola factura con ${n} insumos: el importe y el flete se reparten, no se duplican`}>{c.part_position}/{n} de la factura</span>}
                  {esPrimera(c) && extra?.concepto && <span className="block text-xs text-gray-600">«{extra.concepto}»</span>}
                  {esPrimera(c) && <Comprobantes docs={extra?.docs} compacto />}</td>
                <td className={tdR}><button className="text-[#A8552E] hover:underline" onClick={() => setKgDe(c.purchase_root_id)}>{c.quantity_kg === null ? 'cargar' : kgTxt(c.quantity_kg)}</button></td>
                <td className={`${td} hidden md:table-cell`}>{c.supplier_name ?? '—'}</td>
                <td className={tdR}>{pesos(c.price_per_kg)}</td>
                <td className={tdR}>{c.freight_amount > 0 ? pesos(c.freight_cost) : '—'}</td>
                <td className={tdR}>{pesos(c.cost_per_kg)}</td>
                <td className={td}>{c.quantity_kg === null ? <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">Faltan kilos</span>
                  : c.freight_status === 'PENDIENTE' ? <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">Flete pendiente</span>
                    : <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800">{c.freight_status === 'SIN_FLETE' ? 'Sin flete' : 'Completa'}</span>}</td>
              </tr>
            );
          })}
        </Tabla>
      )}
      {kgDe && filasDe(kgDe).length > 0 && <KgModal filas={filasDe(kgDe)} extra={extras.data?.get(kgDe)} onClose={() => setKgDe(null)} />}
      {vinculando && <FleteModal compras={paraFlete} fletes={(fletes.data ?? []).filter((f) => f.remaining > 0)}
        onClose={() => setVinculando(false)} onListo={() => { setVinculando(false); setElegidas([]); }} guardando={m.freight.isPending} error={m.freight.error}
        onGuardar={(freightPurchaseId, allocations, listo) => m.freight.mutate({ freightPurchaseId, allocations }, { onSuccess: listo })} />}
    </div>
  );
}

type ParteForm = { cat: string; kg: string; monto: string };

/**
 * The kg of a purchase and, when its invoice brings several ingredients (0138), each one: its ingredient category, kg and amount
 * on the invoice (the neto with Factura A, otherwise the total). The amounts must add up exactly to the purchase amount — the
 * expense, its payment and its IVA stay one; the backend refuses anything else.
 */
function KgModal({ filas, extra, onClose }: { filas: FeedPurchase[]; extra?: FeedPurchaseExtra; onClose: () => void }) {
  const m = useAlimentoMutations();
  const categorias = useMasterList<ExpenseCategoryRow>('expense_category');
  const insumos = (categorias.data ?? []).filter((c) => c.feed_ingredient_id && (c.activo || filas.some((f) => f.expense_category_id === c.id)));
  const compra = filas[0];
  const teniaPartes = compra.part_position !== null;
  const base = filas.reduce((t, f) => t + cent(f.cost_amount), 0) / 100;   // the purchase amount the costing uses (neto with Factura A)
  const kgCompra = compra.purchase_quantity_kg ?? compra.quantity_kg;
  const [varios, setVarios] = useState(teniaPartes);
  const [kg, setKg] = useState(kgCompra === null ? '' : String(kgCompra));
  const [sinFlete, setSinFlete] = useState(compra.no_freight);
  const [partes, setPartes] = useState<ParteForm[]>(teniaPartes
    ? filas.map((f) => ({ cat: f.expense_category_id, kg: String(f.quantity_kg ?? ''), monto: String(f.cost_amount) }))
    : [{ cat: compra.expense_category_id, kg: kgCompra === null ? '' : String(kgCompra), monto: '' }, { cat: '', kg: '', monto: '' }]);
  const setParte = (i: number, p: Partial<ParteForm>) => setPartes((ps) => ps.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const n = Number(kg);
  const asignado = partes.reduce((t, p) => t + (p.monto === '' ? 0 : cent(p.monto)), 0);
  const resta = cent(base) - asignado;
  const cats = partes.map((p) => p.cat);
  const partesOk = partes.length >= 2 && partes.every((p) => p.cat !== '' && Number(p.kg) > 0 && p.monto !== '' && Number(p.monto) >= 0)
    && new Set(cats).size === cats.length && resta === 0;
  const flete = compra.freight_amount > 0 || filas.some((f) => f.freight_amount > 0);
  const guardando = m.kg.isPending || m.parts.isPending;
  const puede = varios ? partesOk : n > 0 && (teniaPartes || n !== kgCompra || sinFlete !== compra.no_freight);
  async function guardar() {
    if (varios) {
      await m.parts.mutateAsync({ purchaseId: compra.purchase_id, parts: partes.map((p) => ({ categoryId: p.cat, kg: Number(p.kg), amount: Number(p.monto) })), noFreight: sinFlete });
    } else {
      if (teniaPartes) await m.parts.mutateAsync({ purchaseId: compra.purchase_id, parts: [] });
      await m.kg.mutateAsync({ purchaseId: compra.purchase_id, kg: n, noFreight: sinFlete });
    }
    onClose();
  }
  return (
    <Modal titulo={`Kilos — ${filas.map((f) => f.ingredient_nombre).join(' + ')} ${fechaDMA(compra.economic_date)}`} onClose={onClose} guardando={guardando}
      error={m.parts.error ?? m.kg.error ?? categorias.error} puedeGuardar={puede} onSubmit={() => { guardar().catch(() => {}); }}>
      <p className="text-sm text-gray-700">{compra.supplier_name ?? '—'} · {pesos(base)}{compra.invoice_a ? ' sin IVA (Factura A)' : ''}</p>
      {extra?.concepto && <p className="text-sm text-gray-700">Concepto del gasto: <i>«{extra.concepto}»</i></p>}
      {extra && (extra.numero || extra.docs.length > 0) && <p className="flex items-center gap-2 text-sm text-gray-700">Factura{extra.numero ? ` ${extra.numero}` : ''}{extra.docs.length > 0 && <>: <Comprobantes docs={extra.docs} /></>}</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={varios} onChange={(e) => setVarios(e.target.checked)} />
        Esta factura trae varios insumos</label>
      {!varios ? (
        <>
          <label className={etiqueta}>Kilos comprados<NumeroInput min="0" step="0.001" value={kg} onChange={(e) => setKg(e.target.value)} className={campo} /></label>
          {n > 0 && <p className="text-xs text-gray-600">Precio/kg: {pesos(base / n)}</p>}
          {teniaPartes && <p className="text-xs text-amber-800">Al guardar se quita el detalle por insumo: la compra vuelve a ser de un solo insumo.</p>}
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-600">Cargá cada insumo con sus kilos y su importe en la factura{compra.invoice_a ? ' (neto, sin IVA)' : ''}. Los importes tienen que sumar {pesos(base)}: el gasto, el pago y el IVA siguen siendo uno solo.</p>
          {partes.map((p, i) => (
            <div key={i} className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2 items-end">
              <label className="text-xs text-gray-600">Insumo
                <select value={p.cat} onChange={(e) => setParte(i, { cat: e.target.value })} className={campo}>
                  <option value="">Elegir…</option>
                  {insumos.map((c) => <option key={c.id} value={c.id} disabled={c.id !== p.cat && cats.includes(c.id)}>{c.nombre}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-600">Kilos<NumeroInput min="0" step="0.001" value={p.kg} onChange={(e) => setParte(i, { kg: e.target.value })} className={campo} /></label>
              <label className="text-xs text-gray-600">Importe<NumeroInput min="0" step="0.01" value={p.monto} onChange={(e) => setParte(i, { monto: e.target.value })} className={campo} /></label>
              <button type="button" aria-label="Quitar insumo" disabled={partes.length <= 2} onClick={() => setPartes((ps) => ps.filter((_, j) => j !== i))}
                className="mb-1 text-xs text-[#A8552E] hover:underline disabled:invisible">Quitar</button>
              {Number(p.kg) > 0 && p.monto !== '' && <p className="col-span-4 -mt-1 text-[11px] text-gray-500">Precio/kg: {pesos(Number(p.monto) / Number(p.kg))}</p>}
            </div>
          ))}
          <button type="button" onClick={() => setPartes((ps) => [...ps, { cat: '', kg: '', monto: '' }])} className="text-xs text-[#A8552E] hover:underline">+ Otro insumo</button>
          <p className={`text-xs ${resta === 0 ? 'text-green-700' : 'text-red-700'}`}>
            {resta === 0 ? `Los importes suman ${pesos(base)}.` : `${resta > 0 ? 'Faltan' : 'Sobran'} ${pesos(Math.abs(resta) / 100)} para llegar a ${pesos(base)}.`}
          </p>
          {new Set(cats.filter(Boolean)).size !== cats.filter(Boolean).length && <p className="text-xs text-red-700">Cada insumo va una sola vez.</p>}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sinFlete} disabled={flete} onChange={(e) => setSinFlete(e.target.checked)} />
        Confirmar flete $0 (vino sin flete o el flete está incluido en el precio)</label>
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
