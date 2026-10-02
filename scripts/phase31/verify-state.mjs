/**
 * Phase 31 provision-target verify — Auth / emptiness state contract (pure, offline-testable).
 *
 * The expected Auth state is explicit per provisioning phase (--auth-phase), never defaulted:
 *   PRE_RESTORE  freshly provisioned target, before the Step 3 Auth restore: no Auth data at all.
 *   RESTORED     post Step 3 (Auth migration COMPLETE, runbook §S5) up to the cutover load: exactly the restored V1
 *                Auth set — 5 users, 5 identities, every identity provider 'email', 0 sessions, 0 refresh tokens.
 * In both phases the target holds no business fact and no mp_cutover_boundary (ADR-017: only the cutover runner writes it).
 */
export const AUTH_PHASES = ['PRE_RESTORE', 'RESTORED'];
export const RESTORED_AUTH = { users: 5, identities: 5, providers: ['email'], sessions: 0, refresh_tokens: 0 };

export function stateFailures(s, authPhase) {
  const f = [];
  if (!AUTH_PHASES.includes(authPhase)) return [`auth phase ${authPhase} is not one of ${AUTH_PHASES.join(' | ')}`];
  const exp = authPhase === 'PRE_RESTORE'
    ? { users: 0, identities: 0, providers: [], sessions: 0, refresh_tokens: 0 }
    : RESTORED_AUTH;
  const ctx = authPhase === 'PRE_RESTORE' ? 'no Auth data before the restore' : 'exactly the restored V1 Auth set';
  if (s.auth_users !== exp.users) f.push(`auth_users=${s.auth_users} (expected ${exp.users}: ${ctx})`);
  if (s.auth_identities !== exp.identities) f.push(`auth_identities=${s.auth_identities} (expected ${exp.identities}: ${ctx})`);
  if (JSON.stringify(s.auth_providers) !== JSON.stringify(exp.providers)) f.push(`auth_providers=${JSON.stringify(s.auth_providers)} (expected ${JSON.stringify(exp.providers)})`);
  if (s.auth_sessions !== exp.sessions) f.push(`auth_sessions=${s.auth_sessions} (expected ${exp.sessions})`);
  if (s.auth_refresh_tokens !== exp.refresh_tokens) f.push(`auth_refresh_tokens=${s.auth_refresh_tokens} (expected ${exp.refresh_tokens})`);
  if (s.business_facts !== 0) f.push(`business_facts=${s.business_facts} (the target must stay empty)`);
  if (s.mp_boundary !== 0) f.push('mp_cutover_boundary is set before the cutover (ADR-017: only the cutover runner writes it)');
  return f;
}
