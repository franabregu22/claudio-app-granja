import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

interface MappedPayment {
  id: string;
  transaction_amount: number;
  currency_id: string;
  status: string;
  status_detail: string;
  date_created: string;
  date_approved: string | null;
  money_release_date: string | null;
  payer_id: string;
  payer_email: string | null;
  payer_identification: string | null;
  collector_id: number;
  payment_method: string;
  payment_type_id: string;
  description: string;
  net_received_amount: number;
  total_paid_amount: number;
  operation_type: string;
  issuer_id: string | null;
  authorization_code: string | null;
  statement_descriptor: string | null;
  captured: boolean;
  installments: number;
  raw_data: Record<string, unknown>;
}

function mapPayment(payment: Record<string, unknown>): MappedPayment {
  const transactionDetails = payment.transaction_details as Record<string, unknown> || {};
  const payer = payment.payer as Record<string, unknown> || {};
  const payerIdentification = payer.identification as Record<string, unknown> || {};
  const paymentMethod = payment.payment_method as Record<string, unknown> || {};

  return {
    id: String(payment.id),
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
    raw_data: payment,
  };
}

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }), headers };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    if (!authHeader || !authHeader.trim()) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }), headers };
    }

    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    console.log("Getting MercadoPago token...");
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${process.env.MERCADOPAGO_CLIENT_ID}&client_secret=${process.env.MERCADOPAGO_CLIENT_SECRET}`,
    });

    const tokenData = await tokenRes.json();
    const mpToken = tokenData.access_token;

    if (!mpToken) {
      return { statusCode: 400, body: JSON.stringify({ error: "No token" }), headers };
    }

    console.log("Fetching first 100 payments...");
    const res = await fetch(`https://api.mercadopago.com/v1/payments/search?limit=100&offset=0`, {
      headers: { Authorization: `Bearer ${mpToken}` },
    });

    const data = await res.json();
    const payments = (data.results || []) as Record<string, unknown>[];

    console.log(`Got ${payments.length} payments`);

    const toInsert = payments.map(p => {
      const m = mapPayment(p);
      return {
        id: m.id,
        data: m.raw_data,
        transaction_amount: m.transaction_amount,
        currency_id: m.currency_id,
        status: m.status,
        status_detail: m.status_detail,
        date_created: m.date_created,
        date_approved: m.date_approved,
        money_release_date: m.money_release_date,
        payer_id: m.payer_id,
        payer_email: m.payer_email,
        payer_identification: m.payer_identification,
        collector_id: m.collector_id,
        payment_method: m.payment_method,
        payment_type_id: m.payment_type_id,
        description: m.description,
        net_received_amount: m.net_received_amount,
        total_paid_amount: m.total_paid_amount,
        operation_type: m.operation_type,
        issuer_id: m.issuer_id,
        authorization_code: m.authorization_code,
        statement_descriptor: m.statement_descriptor,
        captured: m.captured,
        installments: m.installments,
        processed: false,
      };
    });

    console.log(`Upserting ${toInsert.length} records...`);
    const { error } = await supabase.from("mercadopago_raw").upsert(toInsert, { onConflict: "id" });

    if (error) {
      console.error("Upsert error:", error.message);
      return { statusCode: 400, body: JSON.stringify({ error: error.message }), headers };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, upserted: toInsert.length, timestamp: new Date().toISOString() }),
      headers,
    };
  } catch (error) {
    console.error("Fatal:", error);
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
