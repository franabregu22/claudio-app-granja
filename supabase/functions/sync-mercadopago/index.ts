import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://santotomasapp.netlify.app",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Content-Type": "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const edgeSecret = Deno.env.get("EDGE_FUNCTION_SECRET");

    if (!authHeader || !edgeSecret) {
      return new Response(JSON.stringify({ error: "Missing configuration" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const token = authHeader.replace("Bearer ", "");
    if (token !== edgeSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), {
        status: 405,
        headers: corsHeaders,
      });
    }

    const clientId = Deno.env.get("MERCADOPAGO_CLIENT_ID");
    const clientSecret = Deno.env.get("MERCADOPAGO_CLIENT_SECRET");

    // Get MercadoPago token
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
    });

    const tokenData = await tokenRes.json();
    const mpToken = tokenData.access_token;

    if (!mpToken) {
      return new Response(JSON.stringify({ success: false, error: "Failed to get MP token" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Fetch ALL payments (no date filter for historical data)
    let allPayments = [];
    let offset = 0;

    console.log("Fetching all historical payments from MercadoPago...");

    while (true) {
      console.log(`Fetching offset ${offset}...`);

      const res = await fetch(
        `https://api.mercadopago.com/v1/payments/search?limit=100&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${mpToken}` },
        }
      );

      if (!res.ok) {
        console.error("Fetch failed:", res.status);
        break;
      }

      const data = await res.json();
      const results = data.results;

      if (!results || results.length === 0) {
        console.log("No more results");
        break;
      }

      allPayments = allPayments.concat(results);
      offset = offset + 100;

      if (allPayments.length > 10000) {
        console.log("Reached 10k limit, stopping");
        break;
      }
    }

    console.log(`Total payments fetched: ${allPayments.length}`);

    // Save raw data to mercadopago_raw
    let saved = 0;
    let skipped = 0;

    for (const p of allPayments) {
      if (!p || !p.id) continue;

      const id = String(p.id);

      // Check if already exists
      const checkRes = await supabase
        .from("mercadopago_raw")
        .select("id")
        .eq("id", id)
        .single();

      if (checkRes.data) {
        skipped++;
        continue;
      }

      // Save raw payment data
      const { error } = await supabase.from("mercadopago_raw").insert({
        id: id,
        data: p,
        processed: false,
      });

      if (!error) {
        saved++;
      } else {
        console.error(`Error saving ${id}:`, error.message);
      }
    }

    console.log(`Saved: ${saved}, Skipped: ${skipped}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Historical data saved to mercadopago_raw",
        total_fetched: allPayments.length,
        saved: saved,
        skipped: skipped,
      }),
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
});
