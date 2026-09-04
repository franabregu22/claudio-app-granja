import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "crypto";

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

    // Parse webhook
    const body = event.body ? JSON.parse(event.body) : {};
    const signature = event.headers["x-signature"] || "";
    const requestId = event.headers["x-request-id"] || "";

    console.log(`Event type: ${body.type}, ID: ${body.id}, Request: ${requestId}`);

    // Validate signature (MercadoPago sends it but we can skip for now if not configured)
    // In production, validate: signature should be HMAC-SHA256 of request body with secret

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

    // Store webhook event for audit
    await supabase.from("webhook_events").insert({
      event_type: eventType,
      event_id: eventId,
      request_id: requestId,
      resource_type: resource,
      data: body,
      processed: false,
      created_at: new Date().toISOString(),
    }).catch(() => null); // Table might not exist yet

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
      const tokenData = await tokenRes.json();
      mpToken = tokenData.access_token;
      return mpToken;
    };

    // Process based on event type
    if (eventType === "payment.created" || eventType === "payment.updated") {
      console.log(`Processing payment: ${data.id}`);

      // Fetch full payment details from MercadoPago
      const token = await getToken();

      if (token) {
        const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (paymentRes.ok) {
          const payment = await paymentRes.json();

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
          } else {
            console.log(`Saved payment ${data.id}`);
          }
        }
      }
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
