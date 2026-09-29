/**
 * Phase 27 (F27-A) — resolve the signed-in user's target role from the database.
 * `current_app_role()` raises NOT_AUTHENTICATED / USER_NOT_FOUND_OR_INACTIVE for a user without an active
 * profile (including former repartidor users): that means no application access (null).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, TargetDbError } from './db';
import { parseAppRole, type AppRole } from './roles';

const NO_ACCESS = new Set(['NOT_AUTHENTICATED', 'USER_NOT_FOUND_OR_INACTIVE']);

export async function resolveTargetRole(client: SupabaseClient): Promise<AppRole | null> {
  try {
    return parseAppRole(await callRpc<string>(client, 'current_app_role'));
  } catch (err) {
    if (err instanceof TargetDbError && NO_ACCESS.has(err.code)) return null;
    throw err;
  }
}
