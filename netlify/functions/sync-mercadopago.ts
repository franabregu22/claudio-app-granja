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
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }), headers };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || "";

    // Simple auth: just verify header exists and is not empty
    if (!authHeader || !authHeader.trim()) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized - no auth header" }),
        headers,
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    const clientId = process.env.MERCADOPAGO_CLIENT_ID;
    const clientSecret = process.env.MERCADOPAGO_CLIENT_SECRET;

    if (!supabaseUrl || !supabaseKey || !clientId || !clientSecret) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing configuration" }),
        headers,
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log("Getting MercadoPago token...");
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
    });

    const tokenData = await tokenRes.json();
    const mpToken = tokenData.access_token;

    if (!mpToken) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Failed to get MercadoPago token" }),
        headers,
      };
    }

    console.log("Fetching ALL payments from MercadoPago (complete history)...");

    let allPayments: Record<string, unknown>[] = [];
    let offset = 0;
    let attempts = 0;
    const maxAttempts = 600;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const res = await fetch(
          `https://api.mercadopago.com/v1/payments/search?limit=100&offset=${offset}&sort=date_created&criteria=desc`,
          {
            headers: { Authorization: `Bearer ${mpToken}` },
          }
        );

        if (!res.ok) {
          console.error(`HTTP ${res.status}, retry...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const data = await res.json();
        const results = data.results as Record<string, unknown>[] || [];
        const total = data.paging?.total || 0;

        console.log(`[${attempts}] offset=${offset}: got ${results.length} results (total API: ${total}, fetched: ${allPayments.length})`);

        if (!results || results.length === 0) {
          console.log(`Done. Fetched all ${allPayments.length} payments`);
          break;
        }

        allPayments = allPayments.concat(results);
        offset += 100;

        if (allPayments.length >= total && total > 0) {
          console.log("Got all available payments!");
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (error) {
        console.error(`Attempt ${attempts} error:`, error);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    console.log(`\n=== FETCHING COMPLETE ===`);
    console.log(`Total fetched: ${allPayments.length}`);

    const { data: existingIds } = await supabase.from("mercadopago_raw").select("id");
    const existingIdSet = new Set((existingIds || []).map(r => r.id));

    const toInsert = allPayments
      .filter(p => p && p.id && !existingIdSet.has(String(p.id)))
      .map(p => {
        const m = mapPayment(p);
        return {
          id: m.id,
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
          raw_data: m.raw_data,
          processed: false,
        };
      });

    let saved = 0;
    console.log(`\nInserting ${toInsert.length} records...`);

    for (let i = 0; i < toInsert.length; i += 2000) {
      const batch = toInsert.slice(i, i + 2000);
      const { error } = await supabase.from("mercadopago_raw").insert(batch);
      if (!error) {
        saved += batch.length;
      } else {
        console.error(`Batch error:`, error.message);
      }
    }

    const now = new Date().toISOString();
    await supabase.from("sync_metadata").upsert(
      { sync_type: "mercadopago", last_sync_date: now, last_sync_count: saved },
      { onConflict: "sync_type" }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        total_fetched: allPayments.length,
        saved,
        duplicates_skipped: allPayments.length - toInsert.length,
        timestamp: now,
      }),
      headers,
    };
  } catch (error) {
    console.error("Fatal:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

export { handler };
