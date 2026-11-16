import { useState } from 'react';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { ahora, costoFinalKg, fechaCorta, kgTxt, pesos, r2, repartirFlete, saldoFlete, type Compra, type Estado } from './datos';
import { botonPrimario, Ficticio, Tabla, Titulo, td, tdR, thL, thR } from './ui';

type Set = (f: (e: Estado) => Estado) => void;

/** Compras de materias primas (simuladas) y vinculación de fletes: proporcional por kg, manual o flete $0. */
export function Compras({ e, set, quien }: { e: Estado; set: Set; quien: string }) {
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [vinculando, setVinculando] = useState(false);
  const nombre = (id: string) => e.ingredientes.find((i) => i.id === id)?.nombre ?? id;
  const lista = [...e.compras].filter((c) => !soloPendientes || c.flete === null).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const pendientes = e.compras.filter((c) => c.flete === null).length;
  const alternar = (id: string) => setElegidas((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const aplicar = (partes: Record<string, number>, texto: string, fleteId?: string) => {
    set((s) => ({
      ...s, compras: s.compras.map((c) => (c.id in partes ? { ...c, flete: partes[c.id], fleteId, vinculoSimulado: true } : c)),
      auditoria: [{ cuando: ahora(), quien, que: texto }, ...s.auditoria],
    }));
    setElegidas([]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-2">
          <button onClick={() => setSoloPendientes(false)} className={`text-sm px-3 py-1.5 rounded-lg ${!soloPendientes ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'}`}>Todas</button>
          <button onClick={() => setSoloPendientes(true)} className={`text-sm px-3 py-1.5 rounded-lg ${soloPendientes ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'}`}>Flete pendiente ({pendientes})</button>
        </div>
        <button className={botonPrimario} disabled={elegidas.length === 0} onClick={() => setVinculando(true)}>Vincular flete a {elegidas.length || ''} compra{elegidas.length === 1 ? '' : 's'}</button>
      </div>
      <Titulo info={<p>Costo final/kg = (precio/kg × kg + flete) ÷ kg. Con flete pendiente el costo es provisorio y el costo de las recetas del mes figura como estimado.</p>}>Compras de materias primas</Titulo>
      <Tabla cabecera={<><th className={thL} /><th className={thL}>Fecha</th><th className={thL}>Insumo</th><th className={thR}>Kg</th><th className={`${thL} hidden md:table-cell`}>Proveedor</th>
        <th className={thR}>Precio/kg</th><th className={thR}>Flete</th><th className={thR}>Costo final/kg</th><th className={thL}>Estado</th><th className={thR} /></>}>
        {lista.map((c) => (
          <tr key={c.id}>
            <td className={td}>{c.flete === null && <input type="checkbox" aria-label="Elegir para el flete" checked={elegidas.includes(c.id)} onChange={() => alternar(c.id)} />}</td>
            <td className={td}>{c.fecha}</td><td className={td}>{nombre(c.ingredienteId)}</td><td className={tdR}>{kgTxt(c.kg)}</td>
            <td className={`${td} hidden md:table-cell`}>{c.proveedor}</td><td className={tdR}>{pesos(c.precioKg)}</td>
            <td className={tdR}>{c.flete === null ? '—' : pesos(c.flete)}</td><td className={tdR}>{pesos(costoFinalKg(c))}</td>
            <td className={td}>{c.flete === null
              ? <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">Flete pendiente</span>
              : <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800">{c.flete === 0 ? 'Sin flete' : 'Completa'}</span>}{c.vinculoSimulado && <Ficticio />}
              {c.fleteId && <span className="block text-[11px] text-gray-500">{e.fletes.find((f) => f.id === c.fleteId)?.comprobante}</span>}</td>
            <td className={tdR}>{c.flete === null && <button className="text-xs text-[#A8552E] hover:underline whitespace-nowrap"
              onClick={() => aplicar({ [c.id]: 0 }, `Flete $0 confirmado: ${nombre(c.ingredienteId)} ${c.fecha}`)}>Confirmar flete $0</button>}</td>
          </tr>
        ))}
      </Tabla>
      {vinculando && <FleteModal e={e} compras={e.compras.filter((c) => elegidas.includes(c.id))} nombre={nombre} onClose={() => setVinculando(false)}
        onGuardar={(partes, fleteId, total) => {
          const f = e.fletes.find((x) => x.id === fleteId)!;
          aplicar(partes, `Flete ${f.comprobante} (${f.transportista}): ${pesos(total)} asignado a ${Object.keys(partes).length} compra(s)`, fleteId);
          setVinculando(false);
        }} />}
    </div>
  );
}

/**
 * Vincular un flete REGISTRADO EN CAJA (pagado o pendiente de pago) a una o varias compras: se reparte su saldo sin
 * asignar, por kg o a mano. Lo que no se asigna queda como saldo del flete para otras compras.
 */
function FleteModal({ e, compras, nombre, onClose, onGuardar }: {
  e: Estado; compras: Compra[]; nombre: (id: string) => string; onClose: () => void; onGuardar: (p: Record<string, number>, fleteId: string, total: number) => void;
}) {
  const disponibles = e.fletes.map((f) => ({ f, saldo: saldoFlete(f, e.compras) })).filter((x) => x.saldo > 0).sort((a, b) => b.f.fecha.localeCompare(a.f.fecha));
  const [fleteId, setFleteId] = useState(disponibles[0]?.f.id ?? '');
  const elegido = disponibles.find((x) => x.f.id === fleteId);
  const [monto, setMonto] = useState<string | null>(null);   // null = todo el saldo
  const [modo, setModo] = useState<'KG' | 'MANUAL'>('KG');
  const [manual, setManual] = useState<Record<string, string>>({});
  const saldo = elegido?.saldo ?? 0;
  const t = modo === 'KG' ? (monto === null ? saldo : Number(monto)) : r2(compras.reduce((s, c) => s + (Number(manual[c.id]) || 0), 0));
  const partes = repartirFlete(t, compras, modo, Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, Number(v)])));
  const suma = r2(Object.values(partes).reduce((a, b) => a + b, 0));
  const valido = !!elegido && t > 0 && suma === r2(t) && t <= saldo + 0.001;
  return (
    <Modal titulo="Vincular flete de Caja" onClose={onClose} guardando={false} puedeGuardar={valido} textoGuardar="Vincular (simulado)" onSubmit={() => onGuardar(partes, fleteId, t)}>
      <p className="text-xs text-purple-800 bg-purple-50 rounded px-2 py-1">Simulación: fletes ficticios; no se guarda nada en la base.<Ficticio /></p>
      {disponibles.length === 0 ? <p className="text-sm text-amber-800">No hay fletes con saldo sin asignar. Registralo primero en Caja como gasto de flete.</p> : (
        <label className={etiqueta}>Flete registrado en Caja
          <select value={fleteId} onChange={(ev) => { setFleteId(ev.target.value); setMonto(null); }} className={campo}>
            {disponibles.map(({ f, saldo: s }) => (
              <option key={f.id} value={f.id}>{fechaCorta(f.fecha)} · {f.transportista} · {f.comprobante} · {pesos(f.monto)} · {f.pagado ? 'pagado' : 'pendiente de pago'}{s < f.monto ? ` · saldo ${pesos(s)}` : ''}</option>
            ))}
          </select>
        </label>
      )}
      {elegido && <p className="text-xs text-gray-600">Saldo sin asignar: <b>{pesos(saldo)}</b>{elegido.f.pagado ? '' : ' · el pago se registra en Caja → Cuentas a pagar'}</p>}
      {modo === 'KG' && elegido && (
        <label className={etiqueta}>Monto a repartir ($)
          <input type="number" min="0" max={saldo} step="0.01" value={monto ?? String(saldo)} onChange={(ev) => setMonto(ev.target.value)} className={campo} />
        </label>
      )}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="radio" checked={modo === 'KG'} onChange={() => setModo('KG')} /> Proporcional por kg</label>
        <label className="flex items-center gap-1"><input type="radio" checked={modo === 'MANUAL'} onChange={() => setModo('MANUAL')} /> Manual</label>
      </div>
      <div className="space-y-1 text-sm">
        {compras.map((c) => (
          <div key={c.id} className="grid grid-cols-[1fr_8rem] gap-2 items-center">
            <span>{nombre(c.ingredienteId)} · {c.fecha} · {kgTxt(c.kg)}</span>
            {modo === 'KG' ? <span className="text-right">{pesos(partes[c.id])}</span> : (
              <input type="number" min="0" step="0.01" aria-label={`Flete ${nombre(c.ingredienteId)}`} value={manual[c.id] ?? ''}
                onChange={(ev) => setManual((m) => ({ ...m, [c.id]: ev.target.value }))} className="border border-gray-300 rounded px-2 py-1 text-right" />
            )}
          </div>
        ))}
      </div>
      <p className={`text-xs ${valido || t === 0 ? 'text-gray-600' : 'text-red-700'}`}>
        Asignado {pesos(suma)} · queda {pesos(r2(saldo - suma))} del flete para otras compras{t > saldo + 0.001 ? ' — supera el saldo del flete' : ''}
      </p>
    </Modal>
  );
}
