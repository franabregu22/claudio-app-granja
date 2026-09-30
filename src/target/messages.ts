/**
 * Phase 27 — user-facing text for normalized target errors (presentation only; the backend decides).
 */
import { normalizeDbError } from './db';

const MESSAGES: Record<string, string> = {
  FORBIDDEN: 'Solo un administrador puede realizar esta acción.',
  PERMISSION_DENIED: 'No tenés permiso para realizar esta acción.',
  RLS_DENIED: 'No tenés permiso para realizar esta acción.',
  NOT_UPDATED: 'No se guardó el cambio: no tenés permiso o el registro ya no existe.',
  USER_NOT_FOUND_OR_INACTIVE: 'Tu usuario no tiene un perfil activo.',
  NOT_AUTHENTICATED: 'Tu sesión expiró. Volvé a ingresar.',
  DUPLICATE: 'Ya existe un registro con esos datos.',
  CHECK_VIOLATION: 'Hay un valor inválido (revisá importes, cantidades y fechas).',
  FK_VIOLATION: 'El registro está referenciado por otros datos.',
  MISSING_VALUE: 'Falta completar un dato obligatorio.',
  DIRECT_WRITE_NOT_ALLOWED: 'Operación no permitida.',
  PERIOD_CLOSED: 'El período está cerrado.',
  PERIOD_NOT_FOUND: 'No existe un período de gestión para esa fecha.',
  INVALID_DATE: 'La fecha no es válida (no puede ser futura ni anterior a la entrada del lote).',
  INVALID_QUANTITY: 'La cantidad no es válida.',
  SHED_NOT_FOUND: 'El galpón no existe.',
  SHED_INACTIVE: 'El galpón está inactivo.',
  SHED_OCCUPIED: 'El galpón ya tiene un lote activo.',
  SUPPLIER_NOT_FOUND: 'El proveedor no existe.',
  PURCHASE_NOT_FOUND: 'La compra no existe.',
  FLOCK_NOT_FOUND: 'El lote no existe.',
  FLOCK_NOT_ACTIVE: 'El lote no está activo.',
  EXIT_BEFORE_RECORDED_ACTIVITY: 'Hay producción, mortandad o asignaciones de alimento posteriores a esa fecha de salida.',
  ACTIVITY_AFTER_FLOCK_EXIT: 'La fecha es posterior a la salida del lote.',
};

export function errorMessage(err: unknown): string {
  const e = normalizeDbError(err);
  return MESSAGES[e.code] ?? 'No se pudo completar la operación. Intentá de nuevo.';
}
