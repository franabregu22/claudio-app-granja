/**
 * Owner 2026-11-24 — the instalments of a tax obligation (IVA plan): the total split into equal parts to the cent (the cents left over
 * go to the last instalment, so the parts always add up to the total exactly), or the instalments added up into the total.
 */
export function repartirEnCuotas(total: number, n: number): number[] {
  if (n <= 0 || !Number.isFinite(total) || total <= 0) return Array.from({ length: Math.max(n, 0) }, () => 0);
  const centavos = Math.round(total * 100);
  const parte = Math.floor(centavos / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? centavos - parte * (n - 1) : parte) / 100);
}

/** The sum of the instalments, to the cent (no floating-point remainder). */
export function sumarCuotas(montos: number[]): number {
  return montos.reduce((t, m) => t + Math.round((Number.isFinite(m) ? m : 0) * 100), 0) / 100;
}
