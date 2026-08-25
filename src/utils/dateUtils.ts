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
