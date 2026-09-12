export const MP_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export function argentinaDate(value = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('La fecha no es válida.');
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function argentinaPeriod(start: string, end: string) {
  shiftDate(start, 0);
  const nextDay = shiftDate(end, 1);
  if (start > end) throw new Error('La fecha inicial debe ser anterior o igual a la final.');
  // Explicit local midnight and exclusive next midnight include all fractional seconds.
  return { start: `${start}T00:00:00-03:00`, endExclusive: `${nextDay}T00:00:00-03:00` };
}

export function moneyCents(value: number | string): number {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('Se encontró un importe inválido o con más de dos decimales.');
  const result = (Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1 : 1);
  if (!Number.isSafeInteger(result)) throw new Error('El importe excede la precisión admitida.');
  return result;
}

export function summarizeLedger(entries: { balance_impact: number | string; category: string }[]) {
  let net = 0, incoming = 0, outgoing = 0, yields = 0;
  for (const entry of entries) {
    const amount = moneyCents(entry.balance_impact);
    net += amount;
    if (entry.category === 'interest_income') yields += amount;
    else if (amount > 0) incoming += amount;
    else outgoing -= amount;
  }
  return { balance: net / 100, ingresos: incoming / 100, egresos: outgoing / 100, rendimientos: yields / 100, total_movimientos: entries.length };
}

export async function collectPages<T extends { id: number | string }>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count: number | null }>) {
  const result: T[] = [];
  const ids = new Set<number | string>();
  let expected: number | undefined;
  for (;;) {
    const { data, error, count } = await fetchPage(result.length, result.length + 499);
    if (error) throw new Error(error.message);
    if (count === null || (expected !== undefined && expected !== count)) {
      throw new Error('Los movimientos cambiaron durante la consulta. Volvé a cargar el período.');
    }
    expected = count;
    for (const row of data || []) {
      if (ids.has(row.id)) throw new Error('Los movimientos cambiaron durante la consulta. Volvé a cargar el período.');
      ids.add(row.id);
      result.push(row);
    }
    if (result.length === expected) return result;
    if (!data?.length || result.length > expected) throw new Error('No se pudieron cargar todos los movimientos.');
  }
}
