import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const handler: Handler = async (event) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    // Get all payments
    const { data: payments } = await supabase.from("mercadopago_raw").select("*");
    const { data: movements } = await supabase.from("mercadopago_movements").select("*");

    // Build CSV
    let csv = "Tipo,ID,Fecha,Monto,Descripción,Estado\n";

    // Add payments
    if (payments) {
      for (const p of payments) {
        const amount = (p.net_received_amount || 0);
        csv += `PAGO,${p.id},${p.date_created},${amount},${p.description || ""},${p.status}\n`;
      }
    }

    // Add movements
    if (movements) {
      for (const m of movements) {
        const amount = (m.amount || 0);
        csv += `${m.type.toUpperCase()},${m.id},${m.date_created},${amount},${m.description || ""},${m.status}\n`;
      }
    }

    const headers = {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=mercadopago_completo.csv",
      "Access-Control-Allow-Origin": "*",
    };

    return {
      statusCode: 200,
      body: csv,
      headers,
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(error) }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

export { handler };
