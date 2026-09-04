import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const clientId = process.env.MERCADOPAGO_CLIENT_ID;
    const clientSecret = process.env.MERCADOPAGO_CLIENT_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get token
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
    });

    const tokenData = await tokenRes.json();
    const mpToken = tokenData.access_token;

    // Fetch first 100
    const res = await fetch(`https://api.mercadopago.com/v1/payments/search?limit=100&offset=0`, {
      headers: { Authorization: `Bearer ${mpToken}` },
    });

    const data = await res.json();
    const fetched = data.results?.length || 0;

    // Check DB
    const { data: existing, count } = await supabase.from("mercadopago_raw").select("id", { count: "exact" });

    console.log("Debug:", { fetched, db_count: count, first_payment_id: data.results?.[0]?.id });

    return {
      statusCode: 200,
      body: JSON.stringify({
        fetched_count: fetched,
        db_existing: count || 0,
        first_payment_api: data.results?.[0]?.id,
        existing_sample: existing?.slice(0, 3).map(r => r.id) || [],
      }),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
