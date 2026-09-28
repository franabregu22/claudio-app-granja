/**
 * ADR-006 Step 4 — `mp-webhook` Supabase Edge Function (verify_jwt = false).
 *
 * Authority: ADR006_WEBHOOK_WORKER_DESIGN_V1 §1–§2. The request logic lives in
 * ./handler.ts; this file only wires the runtime.
 *
 * Runtime values read here and nowhere else:
 *   MP_WEBHOOK_SECRET, MP_COLLECTOR_ID            — Edge Function secrets
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY        — platform-injected
 *   WORKER_INVOKE_SECRET (optional)                — only for the best-effort kick
 * MP_ACCESS_TOKEN is NOT read: this function never calls Mercado Pago.
 *
 * Persistence is the single RPC mp_register_delivery (ADR006_RPC_CONTRACTS_V1
 * S1). No CORS headers: the endpoint is server-to-server.
 */

import { handleMpWebhook, type RegisterDeliveryParams } from './handler.ts';

/** Header carrying WORKER_INVOKE_SECRET on the kick; mp-worker (Step 8) compares it in constant time. */
export const WORKER_INVOKE_HEADER = 'x-worker-invoke-secret';

const env = (name: string): string | null => {
  const v = Deno.env.get(name);
  return v !== undefined && v !== '' ? v : null;
};

const webhookSecret = env('MP_WEBHOOK_SECRET');
const collectorId = env('MP_COLLECTOR_ID');
const supabaseUrl = env('SUPABASE_URL');
const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
const workerInvokeSecret = env('WORKER_INVOKE_SECRET');

const config =
  webhookSecret !== null && collectorId !== null && supabaseUrl !== null && serviceRoleKey !== null
    ? { webhookSecret, collectorId }
    : null;

async function registerDelivery(params: RegisterDeliveryParams): Promise<void> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/mp_register_delivery`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey as string,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
}

function scheduleKick(): void {
  if (workerInvokeSecret === null || supabaseUrl === null) return; // the cron guarantees progress
  const kick = fetch(`${supabaseUrl}/functions/v1/mp-worker`, {
    method: 'POST',
    headers: { [WORKER_INVOKE_HEADER]: workerInvokeSecret, 'content-type': 'application/json' },
    body: '{}',
  })
    .then((res) => res.body?.cancel())
    .catch(() => undefined);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (typeof runtime?.waitUntil === 'function') runtime.waitUntil(kick);
}

Deno.serve((req) =>
  handleMpWebhook(req, {
    config,
    registerDelivery,
    scheduleKick,
    log: (entry) => console.log(JSON.stringify({ fn: 'mp-webhook', ...entry })),
    now: () => Date.now(),
  })
);
