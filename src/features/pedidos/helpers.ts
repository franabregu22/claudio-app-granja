/** Currency formatting for display (presentation only; amounts always come from the target views / RPCs). */
export function formatoPesos(n: number | null | undefined): string {
  const num = Number(n) || 0;
  if (isNaN(num)) return '$0';
  return num.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  });
}
