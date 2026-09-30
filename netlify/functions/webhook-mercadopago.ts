import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";

/** Actions of the configured "Pagos (legacy)" webhook (type "payment") that the legacy handler processes. */
const PAYMENT_ACTIONS = new Set(["payment.created", "payment.updated"]);

type SignatureResult ={ ok: true; dataId: string } | { ok: false; reason: string };

function getHeader(headers: Record<string, string | undefined> | null | undefined, name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? (headers[key] ?? "").trim() : "";
}

/** Mercado Pago signs the `data.id` query parameter of the notification URL. */
export function getSignedDataId(event: { queryStringParameters?: Record<string, string | undefined> | null; rawQuery?: string }): string {
  const fromParams = event.queryStringParameters?.["data.id"];
  if (fromParams) return fromParams.trim();
  return event.rawQuery ? (new URLSearchParams(event.rawQuery).get("data.id") ?? "").trim() : "";
}

/** Alphanumeric data ids are signed in lowercase (Mercado Pago rule); numeric ids are unchanged. */
export function normalizeDataId(id: string): string {
  return /[a-z]/i.test(id) ? id.toLowerCase() : id;
}

/**
 * Mercado Pago webhook signature: x-signature = "ts=<ts>,v1=<hex>",
 * manifest = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;", v1 = HMAC-SHA256(secret, manifest) in hex.
 * Fails closed on any missing or malformed input. Never logs the secret, the header or the digest.
 */
export function verifyMercadoPagoSignature(input: {
  secret: string | undefined;
  signatureHeader: string;
  requestId: string;
  dataId: string;
}): SignatureResult {
  if (!input.secret) return { ok: false, reason: "WEBHOOK_SECRET_NOT_CONFIGURED" };
  if (!input.signatureHeader) return { ok: false, reason: "MISSING_SIGNATURE" };
  if (!input.requestId) return { ok: false, reason: "MISSING_REQUEST_ID" };
  if (!input.dataId) return { ok: false, reason: "MISSING_DATA_ID" };

  const parts: Record<string, string> = {};
  for (const part of input.signatureHeader.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) return { ok: false, reason: "MALFORMED_SIGNATURE" };
    const k = part.slice(0, i).trim();
    if (k in parts) return { ok: false, reason: "MALFORMED_SIGNATURE" };
    parts[k] = part.slice(i + 1).trim();
  }
  const ts = parts.ts ?? "";
  const v1 = parts.v1 ?? "";
  if (!/^\d{1,20}$/.test(ts)) return { ok: false, reason: "MALFORMED_SIGNATURE_TS" };
  if (!/^[0-9a-fA-F]{64}$/.test(v1)) return { ok: false, reason: "MALFORMED_SIGNATURE_V1" };

  const dataId = normalizeDataId(input.dataId);
  const manifest = `id:${dataId};request-id:${input.requestId};ts:${ts};`;
  const expected = createHmac("sha256", input.secret).update(manifest).digest();
  const received = Buffer.from(v1, "hex");
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }
  return { ok: true, dataId };
}

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }), headers };
  }

  try {
    console.log("Webhook received. Validating...");

    // Authenticate before parsing, logging or any side effect
    const requestId = getHeader(event.headers, "x-request-id");
    const auth = verifyMercadoPagoSignature({
      secret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
      signatureHeader: getHeader(event.headers, "x-signature"),
      requestId,
      dataId: getSignedDataId(event),
    });
    if (!auth.ok) {
      console.warn(`Webhook rejected: ${auth.reason}`);
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }), headers };
    }

    // Parse webhook
    let body: any;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }), headers };
    }
    if (!body || typeof body !== "object") {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid webhook" }), headers };
    }

    // The body is not signed: its resource id must match the signed data.id
    const bodyDataId = body.data?.id;
    if (bodyDataId !== undefined && normalizeDataId(String(bodyDataId)) !== auth.dataId) {
      console.warn("Webhook rejected: BODY_DATA_ID_MISMATCH");
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }), headers };
    }

    console.log(`Event type: ${body.type}, ID: ${body.id}, Request: ${requestId}`);

    if (!body.type || !body.id) {
      console.log("Invalid webhook structure");
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid webhook" }), headers };
    }

    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    // Handle different event types
    const eventType = body.type;
    const eventId = body.id;
    const resource = body.resource;
    const data = body.data || {};

    console.log(`Processing event: ${eventType}`);

    // Store webhook event for audit (best effort: the table might not exist yet)
    const { error: auditError } = await supabase.from("webhook_events").insert({
      event_type: eventType,
      event_id: eventId,
      request_id: requestId,
      resource_type: resource,
      data: body,
      processed: false,
      created_at: new Date().toISOString(),
    });
    if (auditError) {
      console.warn(`webhook_events audit insert failed: ${auditError.message}`);
    }

    // Get token once for all API calls
    const clientId = process.env.MERCADOPAGO_CLIENT_ID;
    const clientSecret = process.env.MERCADOPAGO_CLIENT_SECRET;

    let mpToken: string | null = null;

    const getToken = async () => {
      if (mpToken) return mpToken;
      const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
      });
      if (!tokenRes.ok) return null;
      const tokenData = await tokenRes.json();
      mpToken = tokenData.access_token || null;
      return mpToken;
    };

    // Process based on event type.
    // The configured production webhook is "Pagos (legacy)": type "payment", action payment.created / payment.updated,
    // resource id = the signed data.id. The commission / yield / refund / chargeback branches below are not part of
    // the configured production webhook and are left unchanged.
    if (eventType === "payment") {
      if (!PAYMENT_ACTIONS.has(body.action)) {
        console.log(`Ignoring payment notification with unsupported action`);
        return { statusCode: 200, body: JSON.stringify({ success: true, ignored: "UNSUPPORTED_ACTION" }), headers };
      }
      const paymentId = auth.dataId;
      console.log(`Processing payment: ${paymentId}`);

      // Fetch full payment details from MercadoPago
      const token = await getToken();
      if (!token) {
        console.error("MercadoPago token request failed");
        return { statusCode: 502, body: JSON.stringify({ error: "MP_TOKEN_FAILED" }), headers };
      }

      const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!paymentRes.ok) {
        console.error(`MercadoPago payment fetch failed: ${paymentRes.status}`);
        return { statusCode: 502, body: JSON.stringify({ error: "MP_PAYMENT_FETCH_FAILED" }), headers };
      }

      const payment = await paymentRes.json();
      if (!payment || normalizeDataId(String(payment.id)) !== paymentId) {
        console.error("MercadoPago payment response does not match the signed payment id");
        return { statusCode: 502, body: JSON.stringify({ error: "MP_PAYMENT_ID_MISMATCH" }), headers };
      }

      // Map payment fields (same as sync-mercadopago.ts)
      const transactionDetails = payment.transaction_details as Record<string, unknown> || {};
      const payer = payment.payer as Record<string, unknown> || {};
      const payerIdentification = payer.identification as Record<string, unknown> || {};
      const paymentMethod = payment.payment_method as Record<string, unknown> || {};

      const record = {
        id: String(payment.id),
        data: payment,
        transaction_amount: payment.transaction_amount as number || 0,
        currency_id: payment.currency_id as string || "ARS",
        status: payment.status as string || "",
        status_detail: payment.status_detail as string || "",
        date_created: payment.date_created as string || new Date().toISOString(),
        date_approved: payment.date_approved as string || null,
        money_release_date: payment.money_release_date as string || null,
        payer_id: String(payer.id || ""),
        payer_email: payer.email as string || null,
        payer_identification: payerIdentification.number as string || null,
        collector_id: payment.collector_id as number || 0,
        payment_method: paymentMethod.id as string || "",
        payment_type_id: payment.payment_type_id as string || "",
        description: payment.description as string || "",
        net_received_amount: transactionDetails.net_received_amount as number || 0,
        total_paid_amount: transactionDetails.total_paid_amount as number || 0,
        operation_type: payment.operation_type as string || "",
        issuer_id: payment.issuer_id as string | null || null,
        authorization_code: payment.authorization_code as string | null || null,
        statement_descriptor: payment.statement_descriptor as string | null || null,
        captured: payment.captured as boolean || false,
        installments: payment.installments as number || 1,
        processed: false,
      };

      const { error } = await supabase.from("mercadopago_raw").upsert([record], { onConflict: "id" });

      if (error) {
        console.error("Insert error:", error.message);
        return { statusCode: 500, body: JSON.stringify({ error: "PAYMENT_WRITE_FAILED" }), headers };
      }
      console.log(`Saved payment ${paymentId}`);
    } else if (eventType === "commission.created" || eventType === "commission.updated") {
      console.log(`Processing commission: ${data.id}`);

      const token = await getToken();
      if (token) {
        const commission = {
          id: String(data.id),
          type: "commission",
          amount: data.amount || data.transaction_amount || 0,
          currency_id: data.currency_id || "ARS",
          date_created: data.date_created || new Date().toISOString(),
          status: data.status || "pending",
          description: `Commission - ${data.reason || "MercadoPago fee"}`,
          raw_data: data,
        };

        const { error } = await supabase.from("mercadopago_movements").upsert([commission], { onConflict: "id" }).catch(() => ({ error: null }));

        if (!error) {
          console.log(`Saved commission ${data.id}`);
        }
      }
    } else if (eventType === "investment_yield.created" || eventType === "yield.created") {
      console.log(`Processing investment yield: ${data.id}`);

      const yield_record = {
        id: String(data.id),
        type: "investment_yield",
        amount: data.amount || data.net_amount || 0,
        currency_id: data.currency_id || "ARS",
        date_created: data.date_created || new Date().toISOString(),
        status: "completed",
        description: `Investment Yield - ${data.fund_name || "Interest"}`,
        raw_data: data,
      };

      const { error } = await supabase.from("mercadopago_movements").upsert([yield_record], { onConflict: "id" }).catch(() => ({ error: null }));

      if (!error) {
        console.log(`Saved yield ${data.id}`);
      }
    } else if (eventType === "refund.created" || eventType === "chargeback.created") {
      console.log(`Processing ${eventType}: ${data.id}`);

      // These are negative movements
      const refund = {
        id: String(data.id),
        type: eventType === "refund.created" ? "refund" : "chargeback",
        amount: -(data.amount || data.transaction_amount || 0), // Negative
        currency_id: data.currency_id || "ARS",
        date_created: data.date_created || new Date().toISOString(),
        status: data.status || "pending",
        description: `${eventType === "refund.created" ? "Refund" : "Chargeback"} - ${data.reason || "N/A"}`,
        raw_data: data,
      };

      const { error } = await supabase.from("mercadopago_movements").upsert([refund], { onConflict: "id" }).catch(() => ({ error: null }));

      if (!error) {
        console.log(`Saved ${eventType} ${data.id}`);
      }
    }

    // Acknowledge webhook
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, event_id: eventId }),
      headers,
    };
  } catch (error) {
    console.error("Webhook error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

export { handler };
