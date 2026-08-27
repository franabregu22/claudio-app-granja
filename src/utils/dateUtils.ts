// Get today's date in YYYY-MM-DD format using local browser timezone
export function getTodayDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse a date string (YYYY-MM-DD) to formatted string without timezone conversion
// Avoids issues with Date object timezone interpretation
export function formatearFechaLocal(fechaString: string): string {
  if (!fechaString) return '—';

  // Extract just the date part (handle both ISO strings and plain dates)
  const partes = fechaString.split('T')[0].split('-');
  if (partes.length !== 3) return '—';

  const [año, mes, día] = partes;
  return `${día}/${mes}/${año}`;
}

// Add days to a date string (YYYY-MM-DD format)
export function agregarDiasAFecha(fechaString: string, dias: number): string {
  const [año, mes, día] = fechaString.split('-').map(Number);
  const fecha = new Date(año, mes - 1, día);
  fecha.setDate(fecha.getDate() + dias);

  const nuevoAño = fecha.getFullYear();
  const nuevoMes = String(fecha.getMonth() + 1).padStart(2, '0');
  const nuevoDía = String(fecha.getDate()).padStart(2, '0');
  return `${nuevoAño}-${nuevoMes}-${nuevoDía}`;
}

// ============================================================================
// ZONA HORARIA BUENOS AIRES (ART - UTC-3)
// ============================================================================

const BUENOS_AIRES_TZ = 'America/Argentina/Buenos_Aires';

/**
 * Obtiene la fecha actual en zona horaria de Buenos Aires (YYYY-MM-DD)
 */
export function obtenerHoyBA(): string {
  const ahora = new Date();
  const formatter = new Intl.DateTimeFormat('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: BUENOS_AIRES_TZ,
  });

  const parts = formatter.formatToParts(ahora);
  const año = parts.find(p => p.type === 'year')?.value;
  const mes = parts.find(p => p.type === 'month')?.value;
  const día = parts.find(p => p.type === 'day')?.value;

  return `${año}-${mes}-${día}`;
}

/**
 * Convierte una fecha ISO con hora a solo la fecha en zona horaria Buenos Aires
 */
export function isoAFechaBA(isoString: string): string {
  const fecha = new Date(isoString);
  const formatter = new Intl.DateTimeFormat('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: BUENOS_AIRES_TZ,
  });

  const parts = formatter.formatToParts(fecha);
  const año = parts.find(p => p.type === 'year')?.value;
  const mes = parts.find(p => p.type === 'month')?.value;
  const día = parts.find(p => p.type === 'day')?.value;

  return `${año}-${mes}-${día}`;
}

/**
 * Calcula días entre dos fechas en zona horaria Buenos Aires
 * Ambas fechas deben ser strings en formato YYYY-MM-DD
 */
export function calcularDíasDesdeBA(fechaStr: string): number {
  const hoy = obtenerHoyBA();
  const [añoH, mesH, díaH] = hoy.split('-').map(Number);
  const [añoF, mesF, díaF] = fechaStr.split('-').map(Number);

  const fechaHoy = new Date(añoH, mesH - 1, díaH);
  const fechaAntigua = new Date(añoF, mesF - 1, díaF);

  return Math.floor((fechaHoy.getTime() - fechaAntigua.getTime()) / (1000 * 60 * 60 * 24));
}
