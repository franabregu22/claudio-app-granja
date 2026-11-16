import { useState } from 'react';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { ahora, etiquetaMes, HOY, kgTxt, MESES, tablaStock, type Estado } from './datos';
import { botonPrimario, Ficticio, Tabla, Titulo, td, tdR, thL, thR } from './ui';

type Set = (f: (e: Estado) => Estado) => void;

/** Cierres mensuales (simulados): stock final por tipo; el consumo sale de inicial + producción − final. */
export function Stock({ e, set, quien, esAdmin }: { e: Estado; set: Set; quien: string; esAdmin: boolean }) {
  const [cerrando, setCerrando] = useState(false);
  const recetas = e.recetas.filter((r) => r.activa || tablaStock(e, r.id).some((f) => f.produccion > 0));
  const abierto = MESES.find((m) => !e.cierres.some((c) => c.mes === m && c.estado === 'CERRADO'));
  const reabrir = (mes: string) => set((s) => ({
    ...s, cierres: s.cierres.map((c) => (c.mes === mes ? { ...c, estado: 'ABIERTO' } : c)),
    auditoria: [{ cuando: ahora(), quien, que: `Reapertura del cierre de ${etiquetaMes(mes)}` }, ...s.auditoria],
  }));

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <Titulo>Cierres mensuales</Titulo>
          {abierto && <button className={botonPrimario} onClick={() => setCerrando(true)}>Cerrar {etiquetaMes(abierto)}</button>}
        </div>
        <Tabla cabecera={<><th className={thL}>Mes</th><th className={thL}>Estado</th><th className={thL}>Responsable</th><th className={thL}>Fecha</th><th className={thL}>Comentario</th><th className={thR} /></>}>
          {MESES.map((m) => {
            const c = e.cierres.find((x) => x.mes === m);
            const cerrado = c?.estado === 'CERRADO';
            return (
              <tr key={m}>
                <td className={td}>{etiquetaMes(m)}</td>
                <td className={td}><span className={`text-xs px-2 py-0.5 rounded ${cerrado ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>{cerrado ? 'Cerrado' : c ? 'Reabierto' : 'Abierto'}</span></td>
                <td className={td}>{c?.responsable ?? '—'}</td><td className={td}>{c?.fecha ?? '—'}</td><td className={td}>{c?.comentario || '—'}</td>
                <td className={tdR}>{cerrado && esAdmin && <button className="text-xs text-[#A8552E] hover:underline" onClick={() => reabrir(m)}>Reabrir</button>}</td>
              </tr>
            );
          })}
        </Tabla>
        {!esAdmin && <p className="text-xs text-gray-500 mt-1">Solo un administrador puede reabrir un cierre.</p>}
      </section>

      {recetas.map((r) => (
        <section key={r.id}>
          <Titulo>{r.nombre}</Titulo>
          <Tabla cabecera={<><th className={thL}>Mes</th><th className={thR}>Stock inicial</th><th className={thR}>Producción</th><th className={thR}>Stock final</th><th className={`${thR} bg-amber-100`}>Consumo</th></>}>
            {tablaStock(e, r.id).map((f) => (
              <tr key={f.mes}>
                <td className={td}>{etiquetaMes(f.mes)}</td><td className={tdR}>{kgTxt(f.inicial)}</td><td className={tdR}>{kgTxt(f.produccion)}</td>
                <td className={tdR}>{f.final === null ? <span className="text-gray-500">sin cierre</span> : kgTxt(f.final)}</td>
                <td className={`${tdR} font-semibold bg-amber-100`}>{kgTxt(f.consumo)}</td>
              </tr>
            ))}
          </Tabla>
        </section>
      ))}

      {cerrando && abierto && <CierreModal e={e} mes={abierto} recetas={recetas.map((r) => ({ id: r.id, nombre: r.nombre }))} quien={quien}
        onClose={() => setCerrando(false)} onGuardar={(finales, comentario) => {
          set((s) => ({
            ...s, cierres: [...s.cierres.filter((c) => c.mes !== abierto), { mes: abierto, finales, comentario, responsable: quien, fecha: HOY, estado: 'CERRADO' }],
            auditoria: [{ cuando: ahora(), quien, que: `Cierre de ${etiquetaMes(abierto)}: ${recetas.map((r) => `${r.nombre} ${finales[r.id]} kg`).join(', ')}` }, ...s.auditoria],
          }));
          setCerrando(false);
        }} />}
    </div>
  );
}

function CierreModal({ e, mes, recetas, quien, onClose, onGuardar }: {
  e: Estado; mes: string; recetas: { id: string; nombre: string }[]; quien: string; onClose: () => void; onGuardar: (f: Record<string, number>, c: string) => void;
}) {
  const previo = e.cierres.find((c) => c.mes === mes);
  const [finales, setFinales] = useState<Record<string, string>>(() => Object.fromEntries(recetas.map((r) => [r.id, previo ? String(previo.finales[r.id] ?? '') : ''])));
  const [comentario, setComentario] = useState(previo?.comentario ?? '');
  const completo = recetas.every((r) => finales[r.id] !== '' && Number(finales[r.id]) >= 0);
  return (
    <Modal titulo={`Cierre de ${etiquetaMes(mes)}`} onClose={onClose} guardando={false} puedeGuardar={completo} textoGuardar="Cerrar mes (simulado)"
      onSubmit={() => onGuardar(Object.fromEntries(recetas.map((r) => [r.id, Number(finales[r.id])])), comentario)}>
      <p className="text-xs text-purple-800 bg-purple-50 rounded px-2 py-1">Simulación: no se guarda nada en la base.<Ficticio /></p>
      {recetas.map((r) => (
        <label key={r.id} className={etiqueta}>Stock final {r.nombre} (kg)
          <input type="number" min="0" step="0.1" value={finales[r.id]} onChange={(ev) => setFinales((f) => ({ ...f, [r.id]: ev.target.value }))} className={campo} />
        </label>
      ))}
      <label className={etiqueta}>Comentario (opcional)<input type="text" value={comentario} onChange={(ev) => setComentario(ev.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-600">Responsable: {quien} · fecha {HOY}</p>
    </Modal>
  );
}
