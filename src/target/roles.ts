/**
 * Phase 27 (F27-A) — target role model and role-based navigation.
 *
 * The role authority is the database: `current_app_role()` (perfiles.rol_type of the active profile).
 * The frontend only mirrors it for UX. RLS and the in-body RPC checks remain the real authorization.
 * Legacy roles map as decided by the owner (P27-D3): dueño → ADMIN, colaborador → OPERATOR, repartidor → no
 * application access. That mapping lives in the data migration, never in the frontend.
 */

export type AppRole = 'ADMIN' | 'OPERATOR';

export function parseAppRole(value: unknown): AppRole | null {
  return value === 'ADMIN' || value === 'OPERATOR' ? value : null;
}

/** Application modules (sidebar entries). Legacy modules are listed until their slice replaces them. */
export type ModuleId =
  | 'dashboard_produccion'
  | 'produccion'
  | 'clasificacion'
  | 'alimento'
  | 'pedidos'
  | 'cobros'
  | 'caja'
  | 'feria'
  | 'fiscal'
  | 'mercadopago'
  | 'finanzas'
  | 'admin';

const ADMIN_MODULES: readonly ModuleId[] = ['dashboard_produccion', 'produccion', 'clasificacion', 'alimento', 'pedidos', 'cobros', 'caja', 'feria', 'fiscal', 'mercadopago', 'finanzas', 'admin'];
// OPERATOR working set (RLS_IMPLEMENTATION_SPEC_V1 §8, assigned flocks): production, classification and feed.
// Owner decision 2026-10-04 (post-cutover acceptance): no Dashboard for OPERATOR. Feria and fiscal are ADMIN-only
// in V1 (ADR-009; RPC 31 enforces it in the backend).
const OPERATOR_MODULES: readonly ModuleId[] = ['produccion', 'clasificacion', 'alimento'];

/** Modules visible to a role. No role (no active profile, or a former repartidor) → no business module. */
export function modulesFor(role: AppRole | null): ModuleId[] {
  if (role === 'ADMIN') return [...ADMIN_MODULES];
  if (role === 'OPERATOR') return [...OPERATOR_MODULES];
  return [];
}

export function canSeeModule(role: AppRole | null, module: ModuleId): boolean {
  return modulesFor(role).includes(module);
}

/**
 * The module actually rendered for a requested one: the request when the role may see it, otherwise the role's first
 * module (null when the role has none). Every render goes through this, so a module outside the role's set (e.g. a
 * stale or forced Dashboard request by an OPERATOR) is never mounted.
 */
export function resolveModule(role: AppRole | null, requested: ModuleId): ModuleId | null {
  const allowed = modulesFor(role);
  return allowed.includes(requested) ? requested : (allowed[0] ?? null);
}

export const ROLE_LABEL: Record<AppRole, string> = { ADMIN: 'Administrador', OPERATOR: 'Operador' };
