import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { errorMessage } from '../../target/messages';
import {
  canReprocess, canSubmitImport, rejectCode, rejectMessage, RUN_STATUS_LABEL, validateStatementFile,
  type ImportResult, type ImportRun, type ImportRunStatus,
} from '../../target/bankStatements';
import { campo, etiqueta, Modal } from './Modal';
import { useBankStatementMutations, useImportRuns, useStatementAccounts } from './useBankStatements';

const ESTADO_CLASE: Record<ImportRunStatus, string> = {
  PARSED: 'bg-green-100 text-green-800', REJECTED: 'bg-red-100 text-red-800', VALIDATED: 'bg-blue-100 text-blue-800',
};
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const megas = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB`;

/** Result shown after an import / reprocess: the Edge response, completed with the run row once the history reloads. */
interface Resultado { result: ImportResult; cuenta: string; archivo: string; reprocesado: boolean }

/**
 * Extractos bancarios (ADR-018, ADMIN): upload one PDF statement per operation through the Edge Function
 * fin-statement-import, and the recent bank import runs read from fin_import_run (RLS: ADMIN). Only the account id and
 * the file are sent; format, identifiers, parser version, hash and storage path are derived server-side.
 * Line reconciliation and the statement cut are not part of this screen.
 */
export function ExtractosBancarios() {
  const runs = useImportRuns();
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [detalle, setDetalle] = useState<ImportRun | null>(null);
  const [aReprocesar, setAReprocesar] = useState<ImportRun | null>(null);
  const historial = runs.data ?? [];
  const filaDe = (id: string) => historial.find((r) => r.id === id);

  return (
    <div className="space-y-6">
      <FormularioImportacion onResultado={setResultado} />
      {resultado && <TarjetaResultado r={resultado} run={filaDe(resultado.result.run_id)} onReprocesar={setAReprocesar} historial={historial} />}

      <section>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Historial de importaciones</p>
        {runs.isLoading ? <p className="text-sm text-gray-500">Cargando importaciones...</p>
          : runs.error ? <p className="text-sm text-red-700">{errorMessage(runs.error)}</p>
            : historial.length === 0 ? <p className="text-sm text-[#8A7A5C]">Todavía no se importó ningún extracto.</p>
              : <TablaHistorial runs={historial} onDetalle={setDetalle} onReprocesar={setAReprocesar} />}
        {historial.length > 0 && <p className="text-xs text-[#8A7A5C] mt-2">Se muestran las {historial.length} importaciones más recientes.</p>}
      </section>

      {detalle && <DetalleCorrida run={detalle} onClose={() => setDetalle(null)} />}
      {aReprocesar && (
        <ReprocesarModal run={aReprocesar} onClose={() => setAReprocesar(null)}
          onResultado={(result) => { setResultado({ result, cuenta: aReprocesar.cuenta, archivo: aReprocesar.file_name, reprocesado: true }); setAReprocesar(null); }} />
      )}
    </div>
  );
}

function FormularioImportacion({ onResultado }: { onResultado: (r: Resultado) => void }) {
  const cuentas = useStatementAccounts();
  const { importStatement } = useBankStatementMutations();
  const [cuentaId, setCuentaId] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  let archivoError: unknown = null;
  if (archivo) { try { validateStatementFile(archivo); } catch (e) { archivoError = e; } }
  const importando = importStatement.isPending;
  const puede = canSubmitImport({ accountId: cuentaId, file: archivo, pending: importando });
  const nombreCuenta = (cuentas.data ?? []).find((c) => c.id === cuentaId)?.nombre ?? '';

  const importar = () => {
    if (!puede || !archivo) return;
    importStatement.mutate({ accountId: cuentaId, file: archivo }, {
      onSuccess: (result) => {
        onResultado({ result, cuenta: nombreCuenta, archivo: archivo.name, reprocesado: false });
        setArchivo(null);
        setInputKey((k) => k + 1);
      },
    });
  };

  return (
    <section className="bg-white rounded-lg border border-[#E4DCC8] p-4">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">Importar extracto</p>
      <form onSubmit={(e) => { e.preventDefault(); importar(); }} className="space-y-3 max-w-xl">
        <label className={etiqueta}>Cuenta bancaria
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo} disabled={importando} aria-label="Cuenta bancaria">
            <option value="">{cuentas.isLoading ? 'Cargando cuentas…' : 'Elegir cuenta…'}</option>
            {(cuentas.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        {cuentas.data && cuentas.data.length === 0 && <p className="text-xs text-[#8A7A5C]">No hay cuentas bancarias configuradas para importar extractos.</p>}
        <label className={etiqueta}>Archivo PDF (hasta 10 MB)
          <input key={inputKey} type="file" accept="application/pdf,.pdf" disabled={importando} aria-label="Archivo PDF"
            onChange={(e) => { setArchivo(e.target.files?.[0] ?? null); importStatement.reset(); }} className={campo} />
        </label>
        {archivo && !archivoError && <p className="text-xs text-[#8A7A5C]">{archivo.name} · {megas(archivo.size)}</p>}
        {archivoError ? <p className="text-sm text-red-700">{errorMessage(archivoError)}</p> : null}
        {importStatement.error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(importStatement.error)}</div> : null}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={!puede}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">
            {importando ? 'Importando...' : 'Importar extracto'}
          </button>
          {importando && <span className="flex items-center gap-2 text-sm text-[#8A7A5C]">
            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#A8552E]" aria-hidden="true" />Procesando el extracto…
          </span>}
        </div>
        {cuentas.error ? <p className="text-sm text-red-700">{errorMessage(cuentas.error)}</p> : null}
      </form>
      <p className="text-xs text-gray-500 mt-3">Un archivo por importación. El sistema verifica que el extracto corresponda a la cuenta elegida; si ya fue importado, no se duplica.</p>
    </section>
  );
}

function Contadores({ c }: { c: Pick<ImportRun, 'lines_new' | 'lines_known' | 'rows_ignored' | 'rows_total'> }) {
  const item = (label: string, v: number) => (
    <div className="bg-stone-50 rounded px-3 py-2"><p className="text-xs text-[#8A7A5C]">{label}</p><p className="font-bold text-[#2C2419]">{v}</p></div>
  );
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
      {item('Líneas nuevas', c.lines_new)}{item('Ya conocidas', c.lines_known)}{item('Filas ignoradas', c.rows_ignored)}{item('Total de filas', c.rows_total)}
    </div>
  );
}

function TarjetaResultado({ r, run, historial, onReprocesar }: {
  r: Resultado; run: ImportRun | undefined; historial: ImportRun[]; onReprocesar: (run: ImportRun) => void;
}) {
  const { result } = r;
  const rechazado = result.status === 'REJECTED';
  return (
    <section className={`rounded-lg border p-4 ${rechazado ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`} aria-live="polite">
      <p className="font-bold text-[#2C2419]">
        Estado: <span className={`text-sm px-2 py-0.5 rounded ${ESTADO_CLASE[result.status]}`}>{RUN_STATUS_LABEL[result.status]}</span>
      </p>
      <p className="text-sm text-[#4A4338] mt-1">
        {r.cuenta} · {run?.file_name ?? r.archivo}{run ? ` · ${fechaHora(run.created_at)}` : ''}
      </p>
      {result.replayed && (
        <p className="text-sm text-[#4A4338] mt-2">
          {r.reprocesado
            ? 'Este archivo ya había sido procesado con la versión actual del lector: se muestra ese resultado y no se generó una importación nueva.'
            : 'Este archivo ya había sido importado: se muestra la importación existente y no se duplicó ninguna línea.'}
        </p>
      )}
      {rechazado ? (
        <>
          <p className="text-sm text-red-800 mt-2">{rejectMessage(result.reject_reason)}</p>
          {rejectCode(result.reject_reason) && <p className="text-xs text-red-700/70 mt-1">Código: {rejectCode(result.reject_reason)}</p>}
          {run && canReprocess(run, historial) && (
            <button onClick={() => onReprocesar(run)} className="mt-3 text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200">Reprocesar</button>
          )}
        </>
      ) : <Contadores c={result.counters} />}
    </section>
  );
}

function TablaHistorial({ runs, onDetalle, onReprocesar }: {
  runs: ImportRun[]; onDetalle: (r: ImportRun) => void; onReprocesar: (r: ImportRun) => void;
}) {
  return (
    <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
      <table className="w-full text-sm" aria-label="Historial de importaciones">
        <thead>
          <tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
            <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Cuenta</th><th className="px-3 py-2">Archivo</th><th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2 text-right">Nuevas</th><th className="px-3 py-2 text-right">Conocidas</th><th className="px-3 py-2 text-right">Ignoradas</th>
            <th className="px-3 py-2">Versión</th><th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-stone-100 last:border-0">
              <td className="px-3 py-2 whitespace-nowrap">{fechaHora(r.created_at)}</td>
              <td className="px-3 py-2 whitespace-nowrap">{r.cuenta}</td>
              <td className="px-3 py-2 max-w-[14rem] truncate" title={r.file_name}>{r.file_name}</td>
              <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded ${ESTADO_CLASE[r.status]}`}>{RUN_STATUS_LABEL[r.status]}</span></td>
              <td className="px-3 py-2 text-right">{r.lines_new}</td>
              <td className="px-3 py-2 text-right">{r.lines_known}</td>
              <td className="px-3 py-2 text-right">{r.rows_ignored}</td>
              <td className="px-3 py-2 text-xs text-[#8A7A5C] whitespace-nowrap">{r.parser_version}</td>
              <td className="px-3 py-2 whitespace-nowrap text-right space-x-2">
                <button onClick={() => onDetalle(r)} className="text-xs px-2 py-1 rounded bg-stone-100 text-gray-700 hover:bg-stone-200">Detalle</button>
                {canReprocess(r, runs) && (
                  <button onClick={() => onReprocesar(r)} className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Reprocesar</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetalleCorrida({ run, onClose }: { run: ImportRun; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const cerrar = () => { ref.current?.close(); onClose(); };
  const dato = (label: string, valor: string) => (
    <div className="flex justify-between gap-3 py-1 border-b border-stone-100 last:border-0">
      <span className="text-[#8A7A5C]">{label}</span><span className="text-right text-[#2C2419] break-all">{valor}</span>
    </div>
  );
  return (
    <dialog ref={ref} onClose={cerrar} className="w-full max-w-md p-6 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-amber-900">Detalle de la importación</h2>
        <button type="button" onClick={cerrar} className="text-gray-400 hover:text-gray-600" aria-label="Cerrar"><X size={22} /></button>
      </div>
      <div className="text-sm">
        {dato('Cuenta', run.cuenta)}
        {dato('Archivo', run.file_name)}
        {dato('Fecha', fechaHora(run.created_at))}
        {dato('Estado', RUN_STATUS_LABEL[run.status])}
        {dato('Versión del lector', run.parser_version)}
        {run.previous_run_id && dato('Reproceso de', 'una importación anterior del mismo archivo')}
      </div>
      {run.status === 'REJECTED'
        ? <div className="mt-3 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <p className="text-red-800">{rejectMessage(run.reject_reason)}</p>
            {rejectCode(run.reject_reason) && <p className="text-xs text-red-700/70 mt-1">Código: {rejectCode(run.reject_reason)}</p>}
          </div>
        : <Contadores c={run} />}
      <button type="button" onClick={cerrar} className="w-full mt-4 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cerrar</button>
    </dialog>
  );
}

function ReprocesarModal({ run, onClose, onResultado }: { run: ImportRun; onClose: () => void; onResultado: (r: ImportResult) => void }) {
  const { reprocess } = useBankStatementMutations();
  return (
    <Modal titulo="Reprocesar extracto" onClose={onClose} puedeGuardar guardando={reprocess.isPending} error={reprocess.error} textoGuardar="Reprocesar"
      onSubmit={() => reprocess.mutate(run.id, { onSuccess: onResultado })}>
      <p className="text-sm text-[#4A4338]">Se volverá a procesar el mismo archivo con la versión actual del parser.</p>
      <p className="text-sm text-[#8A7A5C]">{run.cuenta} · {run.file_name} · {fechaHora(run.created_at)}</p>
      <p className="text-xs text-gray-500">La importación rechazada se conserva en el historial.</p>
    </Modal>
  );
}
