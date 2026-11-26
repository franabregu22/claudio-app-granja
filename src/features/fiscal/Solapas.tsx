import { Fragment, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/useAuth';
import { zipSync } from 'fflate';
import { supabase } from '../../lib/supabase';
import { descargar, libroXlsx, TIPO_XLSX, type Celda } from '../../lib/xlsx';
import { documentSignedUrl } from '../../target/documents';
import {
  attachFiscalDocumentFile, COLUMNAS_LIBRO, CONSUMIDOR_FINAL, debitosCreditosPorMes, desglosarFacturaB, filaLibro, listArchivosDocumentos, listDocumentosPeriodo,
  listFacturarDia, listFacturarMes, posicionIva, registrarFacturaB, totalesLibro, type FilaLibro,
} from '../../target/fiscalLibro';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useClients } from '../caja/useTreasury';
import { NumeroInput } from '../../components/NumeroInput';
import { getTodayDate } from '../../utils/dateUtils';
import type { FiscalPeriodRow, ObligationRow } from '../../target/fiscal';
import { errorMessage } from '../../target/messages';
import { formatoPesos } from '../pedidos/helpers';
import { useBankTaxPeriods } from '../caja/useTreasury';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const nombreMes = (p: string) => `${MESES[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const ESTADO_OBL: Record<ObligationRow['status'], string> = { PENDING: 'Pendiente', PARTIALLY_PAID: 'Pago parcial', PAID: 'Pagada', CANCELLED: 'Anulada' };
const TH = 'px-3 py-2 text-right font-semibold whitespace-nowrap';
const TD = 'px-3 py-2 text-right whitespace-nowrap';
const caja = 'bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto';

// ── 1. Posición IVA ─────────────────────────────────────────────────────────
/** Owner 2026-11-26: month by month — débito, crédito, saldo, the balance in favour carried, perceptions, what is to pay or in favour. */
export function PosicionIva({ periodos, obligaciones, onVerMes }: { periodos: FiscalPeriodRow[]; obligaciones: ObligationRow[]; onVerMes: (p: string) => void }) {
  const meses = posicionIva(periodos, obligaciones);
  const anios = [...new Set(meses.map((m) => m.period.slice(0, 4)))].sort().reverse();
  const [anio, setAnio] = useState(anios[0] ?? String(new Date().getFullYear()));
  const delAnio = meses.filter((m) => m.period.startsWith(anio));
  if (meses.length === 0) return <p className="text-sm text-[#8A7A5C]">Todavía no hay comprobantes con IVA cargados.</p>;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {anios.map((a) => (
          <button key={a} type="button" onClick={() => setAnio(a)} aria-pressed={a === anio}
            className={`px-3 py-1.5 text-sm rounded ${a === anio ? 'bg-[#A8552E] text-white' : 'bg-white border border-[#D8CDB0] text-[#2C2419]'}`}>{a}</button>
        ))}
      </div>
      <div className={caja}>
        <table className="w-full text-xs md:text-sm">
          <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
            <tr><th className="px-3 py-2 text-left">Mes</th><th className={TH}>IVA débito (ventas)</th><th className={TH}>IVA crédito (compras)</th><th className={TH}>Saldo del mes</th>
              <th className={TH}>A favor del mes anterior</th><th className={TH}>Percepciones IVA</th><th className={TH}>Resultado</th><th className="px-3 py-2 text-left">Obligación</th></tr>
          </thead>
          <tbody>
            {delAnio.map((m) => (
              <tr key={m.period} className="border-b border-amber-100 hover:bg-amber-50/60 cursor-pointer" onClick={() => onVerMes(m.period)} title="Ver las facturas del mes">
                <td className="px-3 py-2 font-medium text-[#2C2419]">{MESES[Number(m.period.slice(5, 7)) - 1]} <span className="text-xs text-gray-500">({m.documentos} comp.)</span></td>
                <td className={TD}>{formatoPesos(m.debito)}</td>
                <td className={TD}>{formatoPesos(m.credito)}</td>
                <td className={`${TD} ${m.saldoMes < 0 ? 'text-green-700' : ''}`}>{formatoPesos(m.saldoMes)}</td>
                <td className={TD}>{m.arrastre > 0 ? `− ${formatoPesos(m.arrastre)}` : '—'}</td>
                <td className={TD}>{m.percepciones > 0 ? `− ${formatoPesos(m.percepciones)}` : '—'}</td>
                <td className={`${TD} font-semibold`}>{m.aPagar > 0 ? <span className="text-red-800">A pagar {formatoPesos(m.aPagar)}</span>
                  : <span className="text-green-700">A favor {formatoPesos(m.aFavor)}</span>}</td>
                <td className="px-3 py-2 text-xs">{m.obligacion ? `${ESTADO_OBL[m.obligacion.status]} · ${formatoPesos(m.obligacion.amount)}`
                  : m.aPagar > 0 ? <span className="text-amber-800">Sin cargar</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">Saldo del mes = IVA débito − IVA crédito (las notas de crédito ya restan). El saldo a favor pasa al mes siguiente y las percepciones de IVA sufridas en las compras restan.
        Es una estimación a partir de lo cargado: la declaración jurada la hace tu contador. Tocá un mes para ver sus facturas.</p>
    </section>
  );
}

// ── 2. Débitos y créditos ───────────────────────────────────────────────────
/** Owner 2026-11-26: the debits / credits tax by month and account; as a PyME, 100 % is computable as pago a cuenta de Ganancias. */
export function DebitosCreditos() {
  const q = useBankTaxPeriods();
  const meses = debitosCreditosPorMes(q.data ?? []);
  const anios = [...new Set(meses.map((m) => m.period.slice(0, 4)))].sort().reverse();
  const [anio, setAnio] = useState<string | null>(null);
  const elegido = anio ?? anios[0] ?? '';
  if (q.isLoading) return <p className="text-sm text-gray-500">Cargando…</p>;
  if (q.error) return <p className="text-sm text-red-700">{errorMessage(q.error)}</p>;
  if (meses.length === 0) return <p className="text-sm text-[#8A7A5C]">Todavía no hay cargos del impuesto a los débitos y créditos.</p>;
  const delAnio = meses.filter((m) => m.period.startsWith(elegido));
  const cuentas = [...new Set(meses.flatMap((m) => m.porCuenta.map((c) => c.cuenta)))].sort();
  const totalAnio = delAnio.reduce((t, m) => t + Math.round(m.total * 100), 0) / 100;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {anios.map((a) => (
          <button key={a} type="button" onClick={() => setAnio(a)} aria-pressed={a === elegido}
            className={`px-3 py-1.5 text-sm rounded ${a === elegido ? 'bg-[#A8552E] text-white' : 'bg-white border border-[#D8CDB0] text-[#2C2419]'}`}>{a}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-white rounded-lg border border-amber-200 p-4">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Pagado en {elegido}</p>
          <p className="text-2xl font-bold text-amber-900 mt-1">{formatoPesos(totalAnio)}</p>
        </div>
        <div className="bg-white rounded-lg border border-green-200 p-4">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Pago a cuenta de Ganancias {elegido}</p>
          <p className="text-2xl font-bold text-green-800 mt-1">{formatoPesos(totalAnio)}</p>
          <p className="text-xs text-gray-500">PyME: se computa el 100 % (confirmalo con tu contador).</p>
        </div>
      </div>
      <div className={caja}>
        <table className="w-full text-xs md:text-sm">
          <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
            <tr><th className="px-3 py-2 text-left">Mes</th>{cuentas.map((c) => <th key={c} className={TH}>{c}</th>)}<th className={TH}>Total</th></tr>
          </thead>
          <tbody>
            {delAnio.map((m) => (
              <tr key={m.period} className="border-b border-amber-100">
                <td className="px-3 py-2 font-medium">{MESES[Number(m.period.slice(5, 7)) - 1]}</td>
                {cuentas.map((c) => { const x = m.porCuenta.find((p) => p.cuenta === c); return <td key={c} className={TD}>{x ? <>{formatoPesos(x.monto)} <span className="text-[11px] text-gray-500">({x.cargos})</span></> : '—'}</td>; })}
                <td className={`${TD} font-semibold`}>{formatoPesos(m.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">Cargos del extracto del banco y de Mercado Pago (entre paréntesis, la cantidad de cargos).</p>
    </section>
  );
}

// ── 3. Libro IVA ────────────────────────────────────────────────────────────
const nombreArchivo = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const filaExcel = (f: FilaLibro): Celda[] => COLUMNAS_LIBRO.map(([k]) => (k === 'fecha' ? f.fecha.split('-').reverse().join('/') : (f[k] as Celda)));

/**
 * Owner 2026-11-26: the Libro IVA Compras / Ventas of a month — one row per document (IVA by rate, perceptions), warnings for what is
 * missing, the Excel of the period (Compras, Ventas and Resumen sheets) and a ZIP with the invoices' files.
 */
export function LibroIva({ periodo, onPeriodo }: { periodo: string; onPeriodo: (p: string) => void }) {
  const [libro, setLibro] = useState<'CREDITO' | 'DEBITO'>('CREDITO');
  const [facturaB, setFacturaB] = useState(false);
  const [zipeando, setZipeando] = useState<string | null>(null);
  const docs = useQuery({ queryKey: ['fiscal', 'libro', periodo], queryFn: () => listDocumentosPeriodo(supabase, periodo) });
  const compras = (docs.data ?? []).filter((d) => d.direction === 'CREDITO').map(filaLibro);
  const ventas = (docs.data ?? []).filter((d) => d.direction === 'DEBITO').map(filaLibro);
  const filas = libro === 'CREDITO' ? compras : ventas;
  const tot = totalesLibro(filas);
  const conAviso = filas.filter((f) => f.avisos.length > 0).length;

  const exportar = () => {
    const cab = COLUMNAS_LIBRO.map(([, t]) => t);
    const totalFila = (fs: FilaLibro[]) => { const t = totalesLibro(fs); return COLUMNAS_LIBRO.map(([k], i) => (i === 0 ? 'TOTAL' : typeof t[k] === 'number' ? t[k] : '')); };
    const anchos = [11, 14, 16, 30, 15, 14, 12, 12, 12, 12, 14, 14, 14, 14];
    const resumen: Celda[][] = [['Concepto', 'Compras (crédito fiscal)', 'Ventas (débito fiscal)'],
      ['Comprobantes', compras.length, ventas.length], ['Neto gravado', totalesLibro(compras).neto ?? 0, totalesLibro(ventas).neto ?? 0],
      ['IVA 21%', totalesLibro(compras).iva21 ?? 0, totalesLibro(ventas).iva21 ?? 0], ['IVA 10,5%', totalesLibro(compras).iva105 ?? 0, totalesLibro(ventas).iva105 ?? 0],
      ['IVA 27%', totalesLibro(compras).iva27 ?? 0, totalesLibro(ventas).iva27 ?? 0], ['Percepción IVA', totalesLibro(compras).percIva ?? 0, totalesLibro(ventas).percIva ?? 0],
      ['Percepción IIBB', totalesLibro(compras).percIibb ?? 0, totalesLibro(ventas).percIibb ?? 0], ['Total', totalesLibro(compras).total ?? 0, totalesLibro(ventas).total ?? 0]];
    const bytes = libroXlsx([
      { nombre: 'Compras', filas: [cab, ...compras.map(filaExcel), ...(compras.length ? [totalFila(compras)] : [])], anchos },
      { nombre: 'Ventas', filas: [cab, ...ventas.map(filaExcel), ...(ventas.length ? [totalFila(ventas)] : [])], anchos },
      { nombre: 'Resumen', filas: resumen, anchos: [22, 24, 24] },
    ]);
    descargar(bytes, `Libro IVA ${periodo.slice(0, 7)}.xlsx`, TIPO_XLSX);
  };

  const zip = async () => {
    const lista = (docs.data ?? []).filter((d) => d.direction === libro);
    setZipeando('Buscando los archivos…');
    try {
      const archivos = await listArchivosDocumentos(supabase, lista.map((d) => d.id));
      const files: Record<string, Uint8Array> = {};
      let n = 0;
      const total = [...archivos.values()].reduce((t, a) => t + a.length, 0);
      for (const d of lista) {
        const f = filaLibro(d);
        for (const [i, a] of (archivos.get(d.id) ?? []).entries()) {
          n += 1; setZipeando(`Descargando ${n} de ${total}…`);
          const url = await documentSignedUrl(supabase, a, 300);
          const r = await fetch(url);
          if (!r.ok) continue;
          const ext = (a.file_name?.match(/\.[A-Za-z0-9]{2,5}$/)?.[0] ?? (a.content_type?.includes('pdf') ? '.pdf' : '.jpg')).toLowerCase();
          let nombre = nombreArchivo(`${f.fecha} ${f.contraparte || 'sin contraparte'} ${f.numero || 'sin numero'}${i > 0 ? ` (${i + 1})` : ''}`) + ext;
          while (files[nombre]) nombre = nombre.replace(ext, `_${ext}`);
          files[nombre] = new Uint8Array(await r.arrayBuffer());
        }
      }
      if (Object.keys(files).length === 0) { setZipeando('No hay archivos adjuntos en las facturas de este período.'); return; }
      descargar(zipSync(files, { level: 0 }), `Facturas ${libro === 'CREDITO' ? 'de compra' : 'de venta'} ${periodo.slice(0, 7)}.zip`, 'application/zip');
      const sin = lista.filter((d) => !(archivos.get(d.id) ?? []).length).length;
      setZipeando(sin > 0 ? `Listo. ${sin} factura${sin === 1 ? '' : 's'} sin archivo adjunto.` : null);
    } catch (e) {
      setZipeando(`No se pudo armar el ZIP: ${errorMessage(e)}`);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-600">Período
          <input type="month" value={periodo.slice(0, 7)} onChange={(e) => e.target.value && onPeriodo(`${e.target.value}-01`)}
            className="block mt-1 border border-[#D8CDB0] rounded px-2 py-1.5 text-sm" />
        </label>
        <div className="flex gap-1" role="group" aria-label="Libro">
          {([['CREDITO', `Compras (${compras.length})`], ['DEBITO', `Ventas (${ventas.length})`]] as const).map(([k, t]) => (
            <button key={k} type="button" onClick={() => setLibro(k)} aria-pressed={libro === k}
              className={`px-3 py-1.5 text-sm rounded ${libro === k ? 'bg-[#A8552E] text-white' : 'bg-white border border-[#D8CDB0] text-[#2C2419]'}`}>{t}</button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {libro === 'DEBITO' && <button type="button" onClick={() => setFacturaB(true)} className="text-sm px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700">Registrar Factura B (consumidor final)</button>}
          <button type="button" disabled={docs.isLoading || (compras.length + ventas.length === 0)} onClick={exportar}
            className="text-sm px-3 py-1.5 rounded bg-green-700 text-white hover:bg-green-800 disabled:opacity-40">Exportar Excel</button>
          <button type="button" disabled={docs.isLoading || filas.length === 0 || (zipeando !== null && zipeando.endsWith('…'))} onClick={() => { void zip(); }}
            className="text-sm px-3 py-1.5 rounded bg-white border border-[#D8CDB0] text-[#2C2419] hover:bg-amber-50 disabled:opacity-40">
            Descargar facturas (ZIP)</button>
        </div>
      </div>
      {zipeando && <p className="text-xs text-[#6B5D45]">{zipeando}</p>}
      <p className="text-sm font-semibold text-[#2C2419]">Libro IVA {libro === 'CREDITO' ? 'Compras' : 'Ventas'} · {nombreMes(periodo)}</p>
      {docs.isLoading ? <p className="text-sm text-gray-500">Cargando…</p> : docs.error ? <p className="text-sm text-red-700">{errorMessage(docs.error)}</p>
        : filas.length === 0 ? <p className="text-sm text-[#8A7A5C]">{libro === 'CREDITO' ? 'No hay facturas de compra en este período.' : 'No hay facturas de venta en este período (se generan al entregar un pedido con «Factura A»).'}</p> : (
          <>
            {conAviso > 0 && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">{conAviso} comprobante{conAviso === 1 ? '' : 's'} con datos faltantes (marcados abajo).
              {libro === 'DEBITO' ? ' El número de una factura de venta se carga en el pedido.' : ''}</p>}
            <div className={caja}>
              <table className="w-full text-xs">
                <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
                  <tr>{COLUMNAS_LIBRO.map(([k, t]) => <th key={k} className={typeof tot[k] === 'number' ? TH : 'px-3 py-2 text-left whitespace-nowrap'}>{t}</th>)}</tr>
                </thead>
                <tbody>
                  {filas.map((f) => (
                    <tr key={f.id} className="border-b border-amber-100">
                      {COLUMNAS_LIBRO.map(([k]) => (typeof f[k] === 'number'
                        ? <td key={k} className={TD}>{f[k] === 0 ? '—' : formatoPesos(f[k] as number)}</td>
                        : <td key={k} className="px-3 py-2 whitespace-nowrap">{k === 'fecha' ? f.fecha.split('-').reverse().join('/') : String(f[k]) || '—'}
                          {k === 'numero' && f.avisos.length > 0 && <span className="ml-1 text-[10px] px-1 rounded bg-amber-100 text-amber-900">{f.avisos.join(' · ')}</span>}
                          {k === 'numero' && libro === 'DEBITO' && <AdjuntarPdf fiscalDocumentId={f.id} />}</td>))}
                    </tr>
                  ))}
                  <tr className="bg-amber-50 font-semibold">
                    {COLUMNAS_LIBRO.map(([k], i) => <td key={k} className={typeof tot[k] === 'number' ? TD : 'px-3 py-2'}>{i === 0 ? 'Total' : typeof tot[k] === 'number' ? formatoPesos(tot[k]) : ''}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      {facturaB && <FacturaBModal fecha={periodo.slice(0, 7) === getTodayDate().slice(0, 7) ? getTodayDate() : finDeMes(periodo)} total={null} onClose={() => setFacturaB(false)} />}
    </section>
  );
}

const finDeMes = (p: string) => { const [a, m] = p.split('-').map(Number); return `${a}-${String(m).padStart(2, '0')}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`; };

/** 0143: the PDF / photo of a sales invoice (as issued in ARCA). */
function AdjuntarPdf({ fiscalDocumentId }: { fiscalDocumentId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const subir = useMutation({
    mutationFn: (file: File) => attachFiscalDocumentFile(supabase, { userId: user!.id, fiscalDocumentId, file }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fiscal'] }),
  });
  return (
    <span className="ml-2">
      <input ref={input} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) subir.mutate(f); e.target.value = ''; }} />
      <button type="button" disabled={subir.isPending} onClick={() => input.current?.click()} className="text-[11px] text-[#A8552E] hover:underline disabled:opacity-50">
        {subir.isPending ? 'Subiendo…' : subir.isSuccess ? 'PDF adjunto ✓' : 'Adjuntar PDF'}</button>
      {subir.error ? <span className="ml-1 text-[11px] text-red-700">{errorMessage(subir.error)}</span> : null}
    </span>
  );
}

/**
 * 0143 (owner 2026-11-26): an issued Factura B to consumidor final — the total with IVA; neto = total ÷ 1,21, IVA = the rest. It enters
 * the Libro IVA Ventas and the Posición IVA, and its IVA leaves the net sales in Resultados. The sales themselves are already recorded.
 */
function FacturaBModal({ fecha: fecha0, total: total0, periodo: periodo0, onClose }: { fecha: string; total: number | null; periodo?: string; onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const clientes = useClients();
  const cf = (clientes.data ?? []).find((c) => c.nombre.trim().toLowerCase() === CONSUMIDOR_FINAL.toLowerCase());
  const [fecha, setFecha] = useState(fecha0);
  const [periodo, setPeriodo] = useState((periodo0 ?? fecha0).slice(0, 7));
  const [pv, setPv] = useState('');
  const [numero, setNumero] = useState('');
  const [total, setTotal] = useState(total0 && total0 > 0 ? String(Math.round(total0 * 100) / 100) : '');
  const [archivo, setArchivo] = useState<File | null>(null);
  const t = Number(total);
  const { neto, iva } = desglosarFacturaB(t > 0 ? t : 0);
  const registrar = useMutation({
    mutationFn: async () => {
      const r = await registrarFacturaB(supabase, { fecha, periodo: `${periodo}-01`, puntoVenta: pv, numero, total: t, clienteId: cf?.id ?? null });
      if (archivo) await attachFiscalDocumentFile(supabase, { userId: user!.id, fiscalDocumentId: r.fiscal_document_id, file: archivo });
      return r;
    },
    onSuccess: () => Promise.all([['fiscal'], ['pnl'], ['master']].map((queryKey) => qc.invalidateQueries({ queryKey }))).then(onClose),
  });
  return (
    <Modal titulo="Registrar Factura B (consumidor final)" onClose={onClose} puedeGuardar={t > 0 && fecha !== '' && numero.trim() !== '' && !clientes.isLoading}
      guardando={registrar.isPending} error={registrar.error ?? clientes.error} textoGuardar="Registrar factura" onSubmit={() => registrar.mutate()}>
      <p className="text-xs text-[#6B5D45]">La factura que emitiste en ARCA. Registra solo el IVA (débito fiscal): las ventas ya están cargadas. El IVA se descuenta de las ventas en Resultados.</p>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Fecha de la factura<input type="date" value={fecha} onChange={(e) => { setFecha(e.target.value); if (e.target.value) setPeriodo(e.target.value.slice(0, 7)); }} className={campo} /></label>
        <label className={etiqueta}>Período fiscal<input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className={campo} /></label>
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <label className={etiqueta}>Punto de venta<input type="text" inputMode="numeric" value={pv} onChange={(e) => setPv(e.target.value)} placeholder="0002" className={campo} /></label>
        <label className={etiqueta}>Número<input type="text" inputMode="numeric" value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="00000123" className={campo} /></label>
      </div>
      <label className={etiqueta}>Total facturado (con IVA)
        <NumeroInput min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} />
      </label>
      {t > 0 && <p className="text-sm text-[#2C2419]">Neto {formatoPesos(neto)} · IVA 21 % {formatoPesos(iva)}</p>}
      <label className={etiqueta}>PDF de la factura (opcional)
        <input type="file" accept="application/pdf,image/*" onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} className={campo} />
      </label>
      <p className="text-xs text-gray-500">Cliente: «{CONSUMIDOR_FINAL}»{cf ? '' : ' (se crea con esta primera factura)'}.</p>
    </Modal>
  );
}

// ── 5. Cobros de Mercado Pago a facturar (0143) ────────────────────────────
/**
 * Owner 2026-11-26: by month (and day) what was collected through Mercado Pago, what was already invoiced with Factura B, what clients with
 * a Factura A paid that month, and what is left to invoice; «Facturar el mes» / «Facturar» open the Factura B with that amount.
 */
export function CobrosMpFacturar() {
  const meses = useQuery({ queryKey: ['fiscal', 'facturar-mes'], queryFn: () => listFacturarMes(supabase) });
  const [abierto, setAbierto] = useState<string | null>(null);
  const [facturar, setFacturar] = useState<{ fecha: string; total: number; periodo: string } | null>(null);
  const dias = useQuery({ queryKey: ['fiscal', 'facturar-dia', abierto], queryFn: () => listFacturarDia(supabase, abierto!), enabled: abierto !== null });
  if (meses.isLoading) return <p className="text-sm text-gray-500">Cargando…</p>;
  if (meses.error) return <p className="text-sm text-red-700">{errorMessage(meses.error)}</p>;
  const filas = meses.data ?? [];
  if (filas.length === 0) return <p className="text-sm text-[#8A7A5C]">Todavía no hay cobros de Mercado Pago.</p>;
  const hoy = getTodayDate();
  return (
    <section className="space-y-3">
      <div className={caja}>
        <table className="w-full text-xs md:text-sm">
          <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
            <tr><th className="px-3 py-2 text-left">Mes</th><th className={TH}>Cobrado por Mercado Pago</th><th className={TH}>Facturado (Factura B)</th>
              <th className={TH}>Cobrado con Factura A</th><th className={TH}>Pendiente de facturar</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {filas.map((m) => (
              <Fragment key={m.period}>
                <tr className="border-b border-amber-100">
                  <td className="px-3 py-2"><button type="button" onClick={() => setAbierto(abierto === m.period ? null : m.period)} className="font-medium text-[#2C2419] hover:underline">
                    {abierto === m.period ? '▾' : '▸'} {nombreMes(m.period)}</button></td>
                  <td className={TD}>{formatoPesos(m.cobrado)} <span className="text-[11px] text-gray-500">({m.cobros})</span></td>
                  <td className={TD}>{formatoPesos(m.facturado_b)}{m.facturas_b > 0 && <span className="text-[11px] text-gray-500"> ({m.facturas_b})</span>}</td>
                  <td className={TD}>{m.cobrado_factura_a > 0 ? formatoPesos(m.cobrado_factura_a) : '—'}</td>
                  <td className={`${TD} font-semibold ${m.pendiente > 0.005 ? 'text-red-800' : 'text-green-700'}`}>{m.pendiente > 0.005 ? formatoPesos(m.pendiente) : 'Facturado'}</td>
                  <td className="px-3 py-2 text-right">{m.pendiente > 0.005 && (
                    <button type="button" onClick={() => setFacturar({ fecha: m.period.slice(0, 7) === hoy.slice(0, 7) ? hoy : finDeMes(m.period), total: m.pendiente, periodo: m.period })}
                      className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 whitespace-nowrap">Facturar el mes</button>)}</td>
                </tr>
                {abierto === m.period && (dias.isLoading ? <tr><td colSpan={6} className="px-6 py-2 text-xs text-gray-500">Cargando…</td></tr>
                  : (dias.data ?? []).map((d) => {
                    const pend = Math.round((d.cobrado - d.facturado_b) * 100) / 100;
                    return (
                      <tr key={d.business_date} className="border-b border-amber-50 bg-[#FCFAF5] text-xs">
                        <td className="pl-8 pr-3 py-1.5">{d.business_date.split('-').reverse().join('/')}</td>
                        <td className={TD}>{formatoPesos(d.cobrado)} <span className="text-[11px] text-gray-500">({d.cobros})</span></td>
                        <td className={TD}>{d.facturado_b > 0 ? formatoPesos(d.facturado_b) : '—'}</td>
                        <td className={TD} />
                        <td className={`${TD} ${pend > 0.005 ? 'text-red-800' : 'text-green-700'}`}>{pend > 0.005 ? formatoPesos(pend) : pend < -0.005 ? `+${formatoPesos(-pend)}` : '✓'}</td>
                        <td className="px-3 py-1.5 text-right">{pend > 0.005 && (
                          <button type="button" onClick={() => setFacturar({ fecha: d.business_date, total: pend, periodo: m.period })} className="text-[11px] text-[#A8552E] hover:underline">Facturar</button>)}</td>
                      </tr>
                    );
                  }))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">Cobrado = todo lo que entró a Mercado Pago (cobros y transferencias recibidas; las devoluciones restan), menos lo marcado como transferencia propia.
        Lo cobrado a clientes con Factura A ese mes se descuenta para no facturarlo dos veces. Por día se compara con las Facturas B de ese día.</p>
      {facturar && <FacturaBModal fecha={facturar.fecha} total={facturar.total} periodo={facturar.periodo} onClose={() => setFacturar(null)} />}
    </section>
  );
}
