import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    const { count: rawCount } = await supabase.from("mercadopago_raw").select("*", { count: "exact", head: true });
    const { count: syncCount } = await supabase.from("sync_metadata").select("*", { count: "exact", head: true });

    const { data: latest } = await supabase
      .from("mercadopago_raw")
      .select("id, date_created, transaction_amount")
      .order("date_created", { ascending: false })
      .limit(1);

    return {
      statusCode: 200,
      body: JSON.stringify({
        mercadopago_raw_rows: rawCount || 0,
        sync_metadata_rows: syncCount || 0,
        latest_payment: latest?.[0] || null,
      }),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
