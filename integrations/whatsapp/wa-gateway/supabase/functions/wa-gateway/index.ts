// ADR-025 §18 — wa-gateway entrypoint (STAGING: AppGranja only). Deploy with --no-verify-jwt: Meta sends no JWT; the
// webhook is authenticated by the Meta HMAC (verified in the database) and the n8n route by its own HMAC.
import { createHandler } from './handler.ts';

declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined;

Deno.serve(createHandler({
  env: (k) => Deno.env.get(k),
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  log: (entry) => console.log(JSON.stringify({ fn: 'wa-gateway', at: new Date().toISOString(), ...entry })),
  waitUntil: (p) => { const q = p.catch((e) => console.log(JSON.stringify({ fn: 'wa-gateway', evt: 'background_error', error: String(e?.message ?? e).slice(0, 160) })));
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(q); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}));
