import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { agregarDiasAFecha } from '../../utils/dateUtils';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DIAS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (a: number, m: number, d: number) => `${a}-${pad(m)}-${pad(d)}`;   // m 1–12
const mesSiguiente = (a: number, m: number): [number, number] => (m === 12 ? [a + 1, 1] : [a, m + 1]);
const mesAnterior = (a: number, m: number): [number, number] => (m === 1 ? [a - 1, 12] : [a, m - 1]);
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const corta = (f: string) => `${Number(f.slice(8, 10))} ${MESES_CORTOS[Number(f.slice(5, 7)) - 1]}`;

/** The days of a month laid out Monday-first (null = an empty cell before the 1st / after the last day). */
function celdas(a: number, m: number): (string | null)[] {
  const primero = new Date(a, m - 1, 1).getDay();   // 0 = Sunday
  const vacias = (primero + 6) % 7;
  const total = new Date(a, m, 0).getDate();
  const out: (string | null)[] = Array.from({ length: vacias }, () => null);
  for (let d = 1; d <= total; d += 1) out.push(iso(a, m, d));
  while (out.length % 7 !== 0) out.push(null);
  return out;
}

/**
 * Dashboard → Período personalizado (owner 2026-11-26): two months side by side; the first click is the start, the second the end (a
 * hover previews the range); only closed days (≤ max = yesterday) can be chosen. Quick picks: the last 7 / 15 / 30 closed days.
 */
export function CalendarioRango({ desde, hasta, max, onAplicar }: { desde: string; hasta: string; max: string; onAplicar: (desde: string, hasta: string) => void }) {
  const [ini, setIni] = useState<string | null>(desde);
  const [fin, setFin] = useState<string | null>(hasta);
  const [sobre, setSobre] = useState<string | null>(null);
  const [vista, setVista] = useState<[number, number]>(() => mesAnterior(Number(hasta.slice(0, 4)), Number(hasta.slice(5, 7))));
  const segundo = mesSiguiente(...vista);
  const maxMes = `${max.slice(0, 7)}`;
  const puedeAvanzar = iso(...segundo, 1).slice(0, 7) < maxMes;

  const elegir = (f: string) => {
    if (ini === null || fin !== null) { setIni(f); setFin(null); return; }
    if (f < ini) { setFin(ini); setIni(f); } else setFin(f);
  };
  const finVista = fin ?? (ini !== null && sobre !== null ? sobre : null);
  const [r0, r1] = ini !== null && finVista !== null ? (ini <= finVista ? [ini, finVista] : [finVista, ini]) : [ini, ini];
  const atajo = (n: number) => { const d = agregarDiasAFecha(max, -(n - 1)); setIni(d); setFin(max); setVista(mesAnterior(Number(max.slice(0, 4)), Number(max.slice(5, 7)))); };

  const mes = (a: number, m: number) => (
    <div className="w-full">
      <p className="text-center text-sm font-semibold text-[#2C2419] mb-2">{MESES[m - 1]} {a}</p>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[11px] text-[#8A7A5C] mb-1">{DIAS.map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="grid grid-cols-7 gap-y-1">
        {celdas(a, m).map((f, i) => {
          if (f === null) return <span key={i} />;
          const deshabilitado = f > max;
          const extremo = f === r0 || f === r1;
          const enRango = r0 !== null && r1 !== null && f > r0 && f < r1;
          return (
            <button key={f} type="button" disabled={deshabilitado} onClick={() => elegir(f)} onMouseEnter={() => setSobre(f)}
              aria-pressed={extremo || enRango} aria-label={f}
              className={`h-9 text-sm transition ${deshabilitado ? 'text-gray-300 cursor-not-allowed'
                : extremo ? 'bg-[#A8552E] text-white font-semibold rounded-lg'
                  : enRango ? 'bg-[#F3E3D6] text-[#2C2419]' : 'text-[#2C2419] hover:bg-amber-100 rounded-lg'}`}>
              {Number(f.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="bg-white rounded-xl border border-[#D8CDB0] p-4 shadow-sm space-y-3 max-w-2xl" onMouseLeave={() => setSobre(null)}>
      <div className="flex flex-wrap gap-2">
        {[7, 15, 30].map((n) => (
          <button key={n} type="button" onClick={() => atajo(n)} className="px-2.5 py-1 text-xs rounded border border-[#D8CDB0] bg-white hover:bg-amber-50 text-[#2C2419]">Últimos {n} días</button>
        ))}
      </div>
      <div className="flex items-start gap-2">
        <button type="button" aria-label="Meses anteriores" onClick={() => setVista(mesAnterior(...vista))} className="mt-0.5 p-1 rounded hover:bg-amber-100 text-[#A8552E]"><ChevronLeft className="w-5 h-5" /></button>
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-6">
          {mes(...vista)}
          <div className="hidden sm:block">{mes(...segundo)}</div>
        </div>
        <button type="button" aria-label="Meses siguientes" disabled={!puedeAvanzar} onClick={() => setVista(mesSiguiente(...vista))}
          className="mt-0.5 p-1 rounded hover:bg-amber-100 text-[#A8552E] disabled:invisible"><ChevronRight className="w-5 h-5" /></button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#EFE8D6] pt-3">
        <p className="text-sm text-[#2C2419]">
          {ini === null ? 'Elegí el día de inicio.' : fin === null ? <>Desde <b>{corta(ini)}</b> — elegí el día final.</> : <>Del <b>{corta(ini)}</b> al <b>{corta(fin)}</b></>}
        </p>
        <button type="button" disabled={ini === null || fin === null} onClick={() => { if (ini && fin) onAplicar(ini, fin); }}
          className="px-4 py-2 text-sm font-medium rounded bg-[#A8552E] text-white disabled:opacity-40">Aplicar</button>
      </div>
      <p className="text-xs text-gray-500">Solo días cerrados (hasta ayer). Se compara con la misma cantidad de días inmediatamente anteriores.</p>
    </div>
  );
}
