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
      return { statusCode: 400, body: JSON.stringify({ error: "CSV is empty" }), headers };
    }

    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    const lines = csvText.split("\n").filter(l => l.trim());

    if (lines.length < 2) {
      return { statusCode: 400, body: JSON.stringify({ error: "CSV must have header + data" }), headers };
    }

    const headers_arr = lines[0].split(",").map(h => h.trim());

    console.log(`Processing CSV with ${lines.length - 1} data lines`);

    let paymentsInserted = 0;
    let movementsInserted = 0;
    let errors = 0;

    // Process each line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      try {
        const parts = line.split(",");
        const record: Record<string, any> = {};

        headers_arr.forEach((header, idx) => {
          record[header] = parts[idx]?.trim() || null;
        });

        const movementType = record["Tipo"] || record["movement_type"] || "UNKNOWN";
        const sourceId = record["Id de Liquidación"] || record["source_id"] || `${Date.now()}-${i}`;
        const dateStr = record["Fecha"] || record["date_movement"] || new Date().toISOString();
        const creditStr = record["Crédito Neto"] || record["net_credit_amount"] || "0";
        const debitStr = record["Débito Neto"] || record["net_debit_amount"] || "0";

        const creditAmount = parseFloat(creditStr) || 0;
        const debitAmount = parseFloat(debitStr) || 0;

        // Determine which table to insert into
        if (movementType.toUpperCase().includes("PAYMENT") || movementType.toUpperCase().includes("PAGO")) {
          // Insert into mercadopago_raw (payments)
          const paymentRecord = {
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
            description: `Settlement: ${movementType}`,
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
          };

          const { error } = await supabase
            .from("mercadopago_raw")
            .upsert([paymentRecord], { onConflict: "id" });

          if (!error) paymentsInserted++;
          else throw error;
        } else {
          // Insert into mercadopago_movements (comisiones, rendimientos, impuestos, etc.)
          const movementRecord = {
            id: sourceId,
            type: movementType.toLowerCase(),
            description: `${movementType} - ${record["Concepto"] || record["Descripción"] || ""}`.trim(),
            status: "completed",
            amount: creditAmount - debitAmount, // Net amount (can be negative for debits)
            net_amount: creditAmount - debitAmount,
            currency_id: "ARS",
            date_created: dateStr,
            payer_id: null,
            related_resource: sourceId,
            details: record,
            raw_data: record,
          };

          const { error } = await supabase
            .from("mercadopago_movements")
            .upsert([movementRecord], { onConflict: "id" });

          if (!error) movementsInserted++;
          else throw error;
        }
      } catch (e) {
        console.error(`Error on line ${i}:`, e);
        errors++;
      }
    }

    // Update sync metadata
    const now = new Date().toISOString();
    await supabase.from("sync_metadata").upsert(
      {
        sync_type: "settlement_csv",
        last_sync_date: now,
        last_sync_count: paymentsInserted + movementsInserted,
      },
      { onConflict: "sync_type" }
    );

    console.log(`Complete: ${paymentsInserted} payments, ${movementsInserted} movements, ${errors} errors`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Settlement CSV synced successfully",
        stats: {
          total_lines_processed: lines.length - 1,
          payments_inserted: paymentsInserted,
          movements_inserted: movementsInserted,
          errors,
        },
        timestamp: now,
      }),
      headers,
    };
  } catch (error) {
    console.error("Fatal:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      headers,
    };
  }
};

export { handler };
