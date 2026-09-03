import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

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
    // Validate token
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const expectedToken = process.env.SYNC_MERCADOPAGO_TOKEN || "";

    console.log("Token received length:", token.length);
    console.log("Expected token length:", expectedToken.length);
    console.log("Auth header:", authHeader.substring(0, 20) + "...");

    if (!token || !expectedToken) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing token configuration" }),
        headers,
      };
    }

    if (token !== expectedToken) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Invalid token" }),
        headers,
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    const supabase = createClient(supabaseUrl, supabaseKey);

    const clientId = process.env.MERCADOPAGO_CLIENT_ID;
    const clientSecret = process.env.MERCADOPAGO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing MercadoPago credentials" }),
        headers,
      };
    }

    // Get MercadoPago token
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

    // Fetch all payments
    let allPayments = [];
    let offset = 0;

    console.log("Fetching historical payments from MercadoPago...");

    while (true) {
      const res = await fetch(
        `https://api.mercadopago.com/v1/payments/search?limit=100&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${mpToken}` },
        }
      );

      if (!res.ok) {
        console.error("MercadoPago fetch failed:", res.status);
        break;
      }

      const data = await res.json();
      const results = data.results;

      if (!results || results.length === 0) {
        break;
      }

      allPayments = allPayments.concat(results);
      offset += 100;

      if (allPayments.length > 10000) {
        break;
      }
    }

    console.log(`Total payments fetched: ${allPayments.length}`);

    // Save to mercadopago_raw
    let saved = 0;
    let skipped = 0;

    for (const payment of allPayments) {
      if (!payment || !payment.id) continue;

      const id = String(payment.id);

      // Check if exists
      const { data: existing } = await supabase
        .from("mercadopago_raw")
        .select("id")
        .eq("id", id)
        .single();

      if (existing) {
        skipped++;
        continue;
      }

      // Insert
      const { error } = await supabase.from("mercadopago_raw").insert({
        id: id,
        data: payment,
        processed: false,
      });

      if (!error) {
        saved++;
      } else {
        console.error(`Error saving ${id}:`, error.message);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Sync completed",
        total_fetched: allPayments.length,
        saved,
        skipped,
      }),
      headers,
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  }
};

export { handler };
