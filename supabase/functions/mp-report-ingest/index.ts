/**
 * ADR-018 §9 — `mp-report-ingest` Supabase Edge Function (verify_jwt = true): VALIDATION capture and NORMAL ingestion.
 *
 * The request logic lives in ./handler.ts and the runtime wiring (service key, Storage, MP API) in
 * ../_shared/mp-report-runtime.ts; this file only adds the ADMIN authentication and serves.
 *
 *   identity   GET  /auth/v1/user                  with the caller's JWT  → uid (never from the body)
 *   role       POST /rest/v1/rpc/current_app_role  with the caller's JWT  → ADMIN required (active perfil)
 *   write      fin_capture_mp_release_report (VALIDATION) or fin_ingest_mp_release_report (NORMAL), p_actor = uid
 */
import { ANON_KEY, reportDeps, runtimeConfigured, SUPABASE_URL } from '../_shared/mp-report-runtime.ts';
import { type AuthResult, CORS_HEADERS, handleIngest } from './handler.ts';

async function authorize(authorization: string | null): Promise<AuthResult> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!m) return { ok: false, status: 401, code: 'NOT_AUTHENTICATED' };
  const user = { apikey: ANON_KEY ?? '', authorization: `Bearer ${m[1]}` };
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: user });
  if (!u.ok) { await u.body?.cancel(); return { ok: false, status: 401, code: 'NOT_AUTHENTICATED' }; }
  const uid = (await u.json())?.id;
  if (typeof uid !== 'string') return { ok: false, status: 401, code: 'NOT_AUTHENTICATED' };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/current_app_role`, {
    method: 'POST', headers: { ...user, 'content-type': 'application/json' }, body: '{}',
  });
  if (!r.ok) { await r.body?.cancel(); return { ok: false, status: 403, code: 'USER_NOT_FOUND_OR_INACTIVE' }; }
  return (await r.json()) === 'ADMIN' ? { ok: true, uid } : { ok: false, status: 403, code: 'ADMIN_REQUIRED' };
}

const deps = reportDeps('mp-report-ingest');

Deno.serve((req) => {
  if (!runtimeConfigured()) {
    deps.log({ event: 'refused', status: 503, code: 'NOT_CONFIGURED' });
    return new Response(JSON.stringify({ error: 'NOT_CONFIGURED' }), { status: 503, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
  }
  return handleIngest(req, { authorize, ...deps });
});
