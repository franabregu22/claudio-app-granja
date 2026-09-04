import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    // Get counts
    const { count: paymentCount } = await supabase.from("mercadopago_raw").select("*", { count: "exact", head: true });

    let movementCount = 0;
    try {
      const { count } = await supabase.from("mercadopago_movements").select("*", { count: "exact", head: true });
      movementCount = count || 0;
    } catch (e) {
      movementCount = 0;
    }

    // Get last sync times
    const { data: syncData } = await supabase.from("sync_metadata").select("*");

    // Get totals
    const { data: paymentTotals } = await supabase.from("mercadopago_raw").select("transaction_amount, net_received_amount, total_paid_amount");

    let movementTotals = [];
    try {
      const { data } = await supabase.from("mercadopago_movements").select("amount");
      movementTotals = data || [];
    } catch (e) {
      movementTotals = [];
    }

    const totalPayments = (paymentTotals || []).reduce((sum, p) => sum + (p.transaction_amount || 0), 0);
    const totalNet = (paymentTotals || []).reduce((sum, p) => sum + (p.net_received_amount || 0), 0);
    const totalMovements = (movementTotals || []).reduce((sum, m) => sum + (m.amount || 0), 0);

    const grandTotal = totalNet + totalMovements;

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          status: "active",
          sync_type: "webhooks",
          data: {
            payments: {
              count: paymentCount || 0,
              total_transaction_amount: totalPayments,
              total_net_received: totalNet,
            },
            movements: {
              count: movementCount || 0,
              total_amount: totalMovements,
              types: ["commission", "investment_yield", "refund", "chargeback"],
            },
            reconciliation: {
              total_net_from_payments: totalNet,
              total_from_movements: totalMovements,
              grand_total: grandTotal,
              target: 172814.62,
              difference: Math.abs(grandTotal - 172814.62),
            },
            last_syncs: syncData || [],
            timestamp: new Date().toISOString(),
          },
        },
        null,
        2
      ),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
