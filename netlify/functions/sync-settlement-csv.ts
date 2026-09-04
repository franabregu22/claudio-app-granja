import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }), headers };
  }

  try {
    const csvText = event.body || "";

    if (!csvText || csvText.length < 10) {
      return { statusCode: 400, body: JSON.stringify({ error: "CSV empty" }), headers };
    }

    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    const lines = csvText.split("\n").filter(l => l.trim());
    if (lines.length < 2) {
      return { statusCode: 400, body: JSON.stringify({ error: "No data" }), headers };
    }

    const headers_arr = lines[0].split(",").map(h => h.trim());
    const payments: any[] = [];
    const movements: any[] = [];

    // Fast parse
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      const record: Record<string, any> = {};

      headers_arr.forEach((h, idx) => {
        record[h] = parts[idx]?.trim() || null;
      });

      const movementType = record["Tipo"] || "UNKNOWN";
      const sourceId = record["Id de Liquidación"] || `${i}`;
      const dateStr = record["Fecha"] || new Date().toISOString();
      const creditStr = record["Crédito Neto"] || "0";
      const debitStr = record["Débito Neto"] || "0";

      const creditAmount = parseFloat(creditStr) || 0;
      const debitAmount = parseFloat(debitStr) || 0;

      if (movementType.toUpperCase().includes("PAYMENT") || movementType.toUpperCase().includes("PAGO")) {
        payments.push({
          id: sourceId,
          transaction_amount: creditAmount,
          currency_id: "ARS",
          status: "approved",
          status_detail: "accredited",
          date_created: dateStr,
          date_approved: dateStr,
          money_release_date: dateStr,
          payer_id: "",
          payer_email: null,
          payer_identification: null,
          collector_id: 0,
          payment_method: "mercadopago",
          payment_type_id: "account_money",
          description: movementType,
          net_received_amount: creditAmount,
          total_paid_amount: creditAmount,
          operation_type: "regular_payment",
          issuer_id: null,
          authorization_code: null,
          statement_descriptor: null,
          captured: true,
          installments: 1,
          processed: false,
          data: record,
        });
      } else {
        movements.push({
          id: sourceId,
          type: movementType.toLowerCase(),
          description: movementType,
          status: "completed",
          amount: creditAmount - debitAmount,
          net_amount: creditAmount - debitAmount,
          currency_id: "ARS",
          date_created: dateStr,
          payer_id: null,
          related_resource: sourceId,
          details: record,
          raw_data: record,
        });
      }
    }

    let paymentsInserted = 0;
    let movementsInserted = 0;

    // Batch insert payments
    if (payments.length > 0) {
      for (let i = 0; i < payments.length; i += 500) {
        const batch = payments.slice(i, i + 500);
        const { error } = await supabase.from("mercadopago_raw").upsert(batch, { onConflict: "id" });
        if (!error) paymentsInserted += batch.length;
      }
    }

    // Batch insert movements
    if (movements.length > 0) {
      for (let i = 0; i < movements.length; i += 500) {
        const batch = movements.slice(i, i + 500);
        const { error } = await supabase.from("mercadopago_movements").upsert(batch, { onConflict: "id" });
        if (!error) movementsInserted += batch.length;
      }
    }

    const now = new Date().toISOString();
    await supabase.from("sync_metadata").upsert(
      { sync_type: "settlement_csv", last_sync_date: now, last_sync_count: paymentsInserted + movementsInserted },
      { onConflict: "sync_type" }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Settlement CSV synced successfully",
        stats: {
          total_lines_processed: lines.length - 1,
          payments_inserted: paymentsInserted,
          movements_inserted: movementsInserted,
        },
        timestamp: now,
      }),
      headers,
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      headers,
    };
  }
};

export { handler };
