import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";

const validateWebhookSignature = (
  signature: string,
  requestId: string,
  dataId: string,
  secret: string
): boolean => {
  if (!signature || !secret) {
    console.log("Missing signature or secret");
    return false;
  }

  const parts = signature.split(",");
  let timestamp = "";
  let v1 = "";

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "ts") timestamp = value;
    if (key === "v1") v1 = value;
  }

  if (!timestamp || !v1) {
    console.log("Invalid signature format: missing ts or v1");
    return false;
  }

  // Build manifest exactly per MercadoPago docs: id:{id};request-id:{request-id};ts:{ts};
  // Omit id or request-id if not present
  let manifest = "";
  if (dataId) {
    manifest += `id:${dataId.toLowerCase()};`;
  }
  if (requestId) {
    manifest += `request-id:${requestId};`;
  }
  manifest += `ts:${timestamp};`;

  console.log(`Manifest for HMAC: ${manifest}`);

  const expectedSignature = createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  console.log(`Calculated HMAC: ${expectedSignature.substring(0, 8)}...`);
  console.log(`Provided v1: ${v1.substring(0, 8)}...`);

  try {
    return timingSafeEqual(Buffer.from(v1), Buffer.from(expectedSignature));
  } catch {
    console.log("HMAC comparison failed");
    return false;
  }
};

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
    const bodyString = event.body || "";
    const body = bodyString ? JSON.parse(bodyString) : {};
    const signature = event.headers["x-signature"] || "";
    const requestId = event.headers["x-request-id"] || "";

    // Get data.id from query params or body
    const dataId = event.queryStringParameters?.id || body.data?.id || "";

    console.log(`Event type: ${body.type}, Data ID: ${dataId}, Request: ${requestId}`);

    // Validate signature
    const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("MERCADOPAGO_WEBHOOK_SECRET not configured");
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Webhook secret not configured" }),
        headers,
      };
    }

    const isValidSignature = validateWebhookSignature(
      signature,
      requestId,
      dataId,
      webhookSecret
    );

    if (!isValidSignature) {
      console.log("Invalid webhook signature");
      return { statusCode: 401, body: JSON.stringify({ error: "Invalid signature" }), headers };
    }

    if (!body.type || !dataId) {
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
    try {
      await supabase.from("webhook_events").insert({
        event_type: eventType,
        event_id: eventId,
        request_id: requestId,
        resource_type: resource,
        data: body,
        processed: false,
        created_at: new Date().toISOString(),
      });
    } catch (auditErr) {
      console.warn("Could not store webhook event:", auditErr instanceof Error ? auditErr.message : String(auditErr));
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
      const tokenData = await tokenRes.json();
      mpToken = tokenData.access_token;
      return mpToken;
    };

    // Process based on event type
    if (eventType === "payment.created" || eventType === "payment.updated") {
      console.log(`Processing payment: ${data.id}`);

      const token = await getToken();
      if (token) {
        const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (paymentRes.ok) {
          const payment = await paymentRes.json();
          const transactionDetails = payment.transaction_details as Record<string, unknown> || {};
          const payer = payment.payer as Record<string, unknown> || {};
          const payerIdentification = payer.identification as Record<string, unknown> || {};
          const paymentMethod = payment.payment_method as Record<string, unknown> || {};

          const paymentId = String(payment.id);
          const transactionAmount = payment.transaction_amount as number || 0;
          const netReceivedAmount = transactionDetails.net_received_amount as number || transactionAmount;
          const paymentStatus = payment.status as string || "";

          // Save to mercadopago_raw
          const record = {
            id: paymentId,
            data: payment,
            transaction_amount: transactionAmount,
            currency_id: payment.currency_id as string || "ARS",
            status: paymentStatus,
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
            net_received_amount: netReceivedAmount,
            total_paid_amount: transactionDetails.total_paid_amount as number || 0,
            operation_type: payment.operation_type as string || "",
            issuer_id: payment.issuer_id as string | null || null,
            authorization_code: payment.authorization_code as string | null || null,
            statement_descriptor: payment.statement_descriptor as string | null || null,
            captured: payment.captured as boolean || false,
            installments: payment.installments as number || 1,
            processed: false,
          };

          await supabase.from("mercadopago_raw").upsert([record], { onConflict: "id" });

          // Check if financial movement already exists for this payment
          let existingFM = null;
          try {
            const result = await supabase
              .from("mp_financial_movement")
              .select("id")
              .eq("external_reference", paymentId)
              .single();
            existingFM = result.data;
          } catch (checkErr) {
            console.log(`No existing FM for payment ${paymentId}`);
          }

          if (!existingFM && paymentStatus === "approved") {
            try {
              // Create mp_source_record
              const { data: sourceRecord } = await supabase
                .from("mp_source_record")
                .insert({
                  account_id: 1054315166,
                  source_type: "webhook",
                  source_external_id: paymentId,
                  observed_at: new Date().toISOString(),
                  raw_data: record,
                })
                .select("id")
                .single();

              if (sourceRecord) {
                // Determine movement class
                const movementClass = transactionAmount >= 0 ? "payment_in" : "payment_out";

                // Create mp_financial_movement
                const { data: fm } = await supabase
                  .from("mp_financial_movement")
                  .insert({
                    account_id: 1054315166,
                    movement_class: movementClass,
                    transaction_amount: transactionAmount,
                    settlement_amount: netReceivedAmount,
                    external_reference: paymentId,
                    transaction_date: payment.date_created as string || new Date().toISOString(),
                    payer_name: payer.name as string || null,
                    payer_id_number: payerIdentification.number as string || null,
                    payment_method: paymentMethod.id as string || null,
                    needs_review: paymentStatus !== "approved",
                  })
                  .select("id")
                  .single();

                if (fm) {
                  // Link source to financial movement
                  await supabase.from("mp_movement_source_link").insert({
                    financial_movement_id: fm.id,
                    source_record_id: sourceRecord.id,
                    is_primary: true,
                  });

                  // Create ledger entry
                  const category = movementClass === "payment_in" ? "income" : "expense";
                  await supabase.from("ledger_entry").insert({
                    account_id: 1054315166,
                    financial_movement_id: fm.id,
                    balance_impact: netReceivedAmount,
                    category,
                    source_reference: `payment.id=${paymentId}`,
                    occurred_at: payment.date_created as string || new Date().toISOString(),
                  });

                  console.log(`Created financial movement for payment ${paymentId}`);
                }
              }
            } catch (err) {
              console.error(`Error creating financial movement for ${paymentId}:`, err instanceof Error ? err.message : String(err));
            }
          }

          if (existingFM) {
            console.log(`Payment ${paymentId} already has financial movement`);
          }
        }
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
