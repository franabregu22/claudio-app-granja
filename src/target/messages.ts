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
};

export function errorMessage(err: unknown): string {
  const e = normalizeDbError(err);
  return MESSAGES[e.code] ?? 'No se pudo completar la operación. Intentá de nuevo.';
}
