import { useState } from 'react';
import { getTodayDate } from '../../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../../caja/Modal';
import { useProfileNames } from '../useProduction';
import { etiquetaMes, fechaDMA, finDeMes, kgTxt, mesDe, meses } from './format';
import { botonPrimario, Tabla, Titulo, td, tdR, thL, thR } from './ui';
import { useAlimentoMutations, useAllFeedTypes, useFeedMonths, useStockPeriods } from './useAlimento';

/** The stock is counted from November 2026 (owner 2026-11-16: stock at 31/10 = 0). */
export const PRIMER_MES = '2026-11-01';

/**
 * Stock (ADMIN): monthly closes in order (close_feed_month), reopen the latest one with a reason (reopen_feed_month),
 * and per recipe: opening, manufactured, closing and consumption — as report_feed_month computes them.
 */
export function Stock() {
  const hoy = getTodayDate();
  const periodos = useStockPeriods();
  const filas = useFeedMonths();
  const tipos = useAllFeedTypes();
  const perfiles = useProfileNames();
  const m = useAlimentoMutations();
  const [cerrando, setCerrando] = useState<string | null>(null);
  const [reabriendo, setReabriendo] = useState<string | null>(null);
  const ps = periodos.data ?? [];
  const lista = meses(PRIMER_MES, hoy);
  const cerrado = (p: string) => ps.some((x) => x.period === p && x.status === 'CLOSED');
  const proximo = lista.find((p) => !cerrado(p));
  const ultimoCerrado = [...ps].filter((x) => x.status === 'CLOSED').sort((a, b) => b.period.localeCompare(a.period))[0]?.period;
  const puedeCerrar = proximo !== undefined && finDeMes(proximo) <= hoy;
  const nombre = (id: string | null) => (id && perfiles.data?.get(id)) || '—';
  const conDatos = (tipos.data ?? []).filter((t) => t.activo || (filas.data ?? []).some((f) => f.feed_type_id === t.id));

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <Titulo>Cierres mensuales</Titulo>
          {proximo && <button className={botonPrimario} disabled={!puedeCerrar} title={puedeCerrar ? '' : `${etiquetaMes(proximo)} termina el ${fechaDMA(finDeMes(proximo))}`}
            onClick={() => setCerrando(proximo)}>Cerrar {etiquetaMes(proximo)}</button>}
        </div>
        <Tabla cabecera={<><th className={thL}>Mes</th><th className={thL}>Estado</th><th className={thL}>Responsable</th><th className={thL}>Fecha</th><th className={thL}>Comentario</th><th className={thR} /></>}>
          {lista.map((p) => {
            const x = ps.find((y) => y.period === p);
            const c = x?.status === 'CLOSED';
            return (
              <tr key={p}>
                <td className={td}>{etiquetaMes(p)}</td>
                <td className={td}><span className={`text-xs px-2 py-0.5 rounded ${c ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>{c ? 'Cerrado' : x ? 'Reabierto' : 'Abierto'}</span></td>
                <td className={td}>{nombre(x?.closed_by ?? null)}</td>
                <td className={td}>{x?.closed_at ? new Date(x.closed_at).toLocaleDateString('es-AR') : '—'}</td>
                <td className={td}>{x?.status === 'REOPENED' ? `Reabierto: ${x.reopen_reason}` : x?.comment || '—'}</td>
                <td className={tdR}>{c && p === ultimoCerrado && <button className="text-xs text-[#A8552E] hover:underline" onClick={() => setReabriendo(p)}>Reabrir</button>}</td>
              </tr>
            );
          })}
        </Tabla>
        <p className="text-xs text-gray-500 mt-1">El stock se cuenta desde noviembre 2026 (stock al 31/10 = 0). Los meses se cierran en orden; solo se reabre el último cerrado.</p>
      </section>

      {conDatos.map((t) => {
        const del = (filas.data ?? []).filter((f) => f.feed_type_id === t.id);
        return (
          <section key={t.id}>
            <Titulo>{t.nombre}</Titulo>
            {del.length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin meses cerrados.</p> : (
              <Tabla cabecera={<><th className={thL}>Mes</th><th className={thR}>Stock inicial</th><th className={thR}>Producción</th><th className={thR}>Stock final</th><th className={`${thR} bg-amber-100`}>Consumo</th></>}>
                {del.map((f) => (
                  <tr key={f.period}>
                    <td className={td}>{etiquetaMes(f.period)}</td><td className={tdR}>{kgTxt(f.opening_kg)}</td><td className={tdR}>{kgTxt(f.manufactured_kg)}</td>
                    <td className={tdR}>{kgTxt(f.closing_kg)}</td><td className={`${tdR} font-semibold bg-amber-100`}>{kgTxt(f.internal_consumption_kg)}</td>
                  </tr>
                ))}
              </Tabla>
            )}
          </section>
        );
      })}

      {cerrando && <CierreModal periodo={cerrando} tipos={(tipos.data ?? []).filter((t) => t.activo)} onClose={() => setCerrando(null)} />}
      {reabriendo && (
        <ReabrirModal periodo={reabriendo} guardando={m.reopen.isPending} error={m.reopen.error} onClose={() => setReabriendo(null)}
          onGuardar={(reason) => m.reopen.mutate({ period: reabriendo, reason }, { onSuccess: () => setReabriendo(null) })} />
      )}
    </div>
  );
}

function CierreModal({ periodo, tipos, onClose }: { periodo: string; tipos: { id: string; nombre: string }[]; onClose: () => void }) {
  const m = useAlimentoMutations();
  const [finales, setFinales] = useState<Record<string, string>>({});
  const [comentario, setComentario] = useState('');
  const completo = tipos.length > 0 && tipos.every((t) => finales[t.id] !== undefined && finales[t.id] !== '' && Number(finales[t.id]) >= 0);
  return (
    <Modal titulo={`Cierre de ${etiquetaMes(periodo)}`} onClose={onClose} guardando={m.close.isPending} error={m.close.error} puedeGuardar={completo} textoGuardar="Cerrar mes"
      onSubmit={() => m.close.mutate({ period: periodo, counts: tipos.map((t) => ({ feedTypeId: t.id, quantityKg: Number(finales[t.id]) })), comment: comentario },
        { onSuccess: onClose })}>
      <p className="text-sm text-gray-700">Stock físico al {fechaDMA(finDeMes(periodo))}. Al cerrar, no se pueden registrar ni editar fabricaciones de {etiquetaMes(periodo)}.</p>
      {tipos.map((t) => (
        <label key={t.id} className={etiqueta}>Stock final {t.nombre} (kg)
          <input type="number" min="0" step="0.1" value={finales[t.id] ?? ''} onChange={(e) => setFinales((f) => ({ ...f, [t.id]: e.target.value }))} className={campo} />
        </label>
      ))}
      <label className={etiqueta}>Comentario (opcional)<input type="text" value={comentario} onChange={(e) => setComentario(e.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-500">Mes: {etiquetaMes(mesDe(periodo))}</p>
    </Modal>
  );
}

function ReabrirModal({ periodo, guardando, error, onClose, onGuardar }: {
  periodo: string; guardando: boolean; error: unknown; onClose: () => void; onGuardar: (reason: string) => void;
}) {
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={`Reabrir ${etiquetaMes(periodo)}`} onClose={onClose} guardando={guardando} error={error} puedeGuardar={motivo.trim() !== ''} textoGuardar="Reabrir"
      onSubmit={() => onGuardar(motivo.trim())}>
      <p className="text-sm text-gray-700">Mientras esté reabierto, el mes no figura en el consumo ni en el estado de resultados. Al volver a cerrarlo se reemplazan los conteos.</p>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}
