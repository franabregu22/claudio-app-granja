import { useState } from 'react';
import { campo, etiqueta, Modal } from './Modal';
import { AVISO_DEMO, btnPrimario, btnSecundario, type DemoProps } from './CuentasAPagarDemo';
import { ddmm, depositar, endosar, esCheque, etiquetaVto, pendiente, pesos } from './pagarDemo';

/**
 * Caja → Cartera de cheques (caja-mejoras-v2): FRONTEND PROTOTYPE over the same in-memory fictitious data as Cuentas a pagar. Client
 * cheques you hold (they come in from Cuentas corrientes when a client pays with a cheque): deposit them, or endorse one to a supplier
 * against one of its due items — that item's debt goes down; what exceeds it stays in the supplier's favour.
 */
export function CarteraChequesDemo({ s, setS, autor, hoy }: DemoProps) {
  const [endosando, setEndosando] = useState<string | null>(null);
  const [depositando, setDepositando] = useState<string | null>(null);
  const [vtoId, setVtoId] = useState('');
  const [cuenta, setCuenta] = useState('BNA');
  const [aviso, setAviso] = useState<string | null>(null);
  const enCartera = s.cartera.filter((c) => c.estado === 'EN_CARTERA').sort((a, b) => a.fechaCobro.localeCompare(b.fechaCobro));
  const usados = s.cartera.filter((c) => c.estado !== 'EN_CARTERA');
  const c = s.cartera.find((x) => x.id === endosando);
  const opciones = s.vtos.filter((v) => !esCheque(v) && pendiente(v) > 0 && s.gastos.find((g) => g.id === v.gastoId)?.proveedorId)
    .map((v) => { const g = s.gastos.find((x) => x.id === v.gastoId)!; return { v, g, prov: s.proveedores.find((p) => p.id === g.proveedorId)!.nombre }; })
    .sort((a, b) => a.prov.localeCompare(b.prov) || (a.v.fecha ?? '9999').localeCompare(b.v.fecha ?? '9999'));

  return (
    <div className="space-y-4">
      {AVISO_DEMO}
      {aviso && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-2 text-sm text-green-900 flex gap-2" role="status">
          <span>{aviso}</span><button type="button" className="ml-auto text-xs hover:underline" onClick={() => setAviso(null)}>Cerrar</button>
        </div>
      )}
      <div className="bg-white rounded-lg border border-[#E4DCC8] px-3 py-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-[#6B5D45]">Cheques de clientes en tu poder. Entran desde <b>Cuentas corrientes</b>, cuando registrás un cobro con cheque.</p>
        <p className="text-sm">En cartera: <b>{pesos(enCartera.reduce((t, x) => t + x.importe, 0))}</b> · {enCartera.length} cheque{enCartera.length === 1 ? '' : 's'}</p>
      </div>
      {enCartera.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cheques en cartera.</p> : (
        <ul className="bg-white rounded-lg border border-[#E4DCC8] divide-y divide-[#F0EADC]">
          {enCartera.map((x) => (
            <li key={x.id} className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[#2C2419]">{x.librador}</p>
                <p className="text-xs text-[#8A7A5C]">{x.banco} · N° {x.numero} · {x.fechaCobro <= hoy ? 'ya se puede cobrar' : `se cobra desde el ${ddmm(x.fechaCobro)}`}</p>
              </div>
              <span className="font-semibold tabular-nums">{pesos(x.importe)}</span>
              <button type="button" onClick={() => setDepositando(x.id)} className={btnSecundario}>Depositar</button>
              <button type="button" onClick={() => { setEndosando(x.id); setVtoId(''); }} className={btnPrimario}>Endosar a proveedor</button>
            </li>
          ))}
        </ul>
      )}
      {usados.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E] mb-1">Depositados y endosados</h3>
          <ul className="text-xs text-[#6B5D45] space-y-1">
            {usados.map((x) => <li key={x.id}>{x.librador} · N° {x.numero} · {pesos(x.importe)} · {x.estado === 'DEPOSITADO' ? `Depositado en ${x.destino}` : `Endosado a ${x.destino}`}</li>)}
          </ul>
        </div>
      )}
      {depositando && (
        <Modal titulo="Depositar cheque" onClose={() => setDepositando(null)} guardando={false} puedeGuardar textoGuardar="Depositar"
          onSubmit={() => { setS(depositar(s, depositando, cuenta)); setDepositando(null); setAviso(`Cheque depositado en ${cuenta}.`); }}>
          {AVISO_DEMO}
          <label className={etiqueta}>Cuenta<select value={cuenta} onChange={(e) => setCuenta(e.target.value)} className={campo}><option>BNA</option><option>Banco Provincia</option></select></label>
        </Modal>
      )}
      {c && (
        <Modal titulo={`Endosar cheque ${c.numero}`} onClose={() => setEndosando(null)} puedeGuardar={vtoId !== ''} guardando={false} textoGuardar="Endosar"
          onSubmit={() => {
            const r = endosar(s, c.id, vtoId, autor());
            setS(r.s); setEndosando(null);
            setAviso(`Cheque ${c.numero} endosado: bajó la deuda del vencimiento elegido${r.aFavor > 0 ? `; ${pesos(r.aFavor)} quedan a favor del proveedor` : ''}.`);
          }}>
          {AVISO_DEMO}
          <p className="text-sm">{c.librador} · <b>{pesos(c.importe)}</b></p>
          <label className={etiqueta}>¿Qué deuda paga?
            <select value={vtoId} onChange={(e) => setVtoId(e.target.value)} className={campo}>
              <option value="">Elegí proveedor y vencimiento</option>
              {opciones.map(({ v, g, prov }) => <option key={v.id} value={v.id}>{prov} · {g.concepto} · {etiquetaVto(s, v)} · {v.fecha ? ddmm(v.fecha) : 'sin fecha'} · {pesos(pendiente(v))}</option>)}
            </select>
          </label>
          {vtoId && (() => { const v = s.vtos.find((x) => x.id === vtoId)!; const dif = c.importe - pendiente(v);
            return <p className="text-xs text-[#8A7A5C]">{dif > 0 ? `Cancela el vencimiento y quedan ${pesos(dif)} a favor del proveedor.` : dif < 0 ? `Pago parcial: en ese vencimiento quedan ${pesos(-dif)}.` : 'Cancela exactamente el vencimiento.'}</p>; })()}
        </Modal>
      )}
    </div>
  );
}
