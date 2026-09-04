import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

interface MappedMovement {
  id: string;
  type: string;
  description: string;
  amount: number;
  net_amount: number;
  currency_id: string;
  status: string;
  date_created: string;
  payer_id: string | null;
  related_resource: string | null;
  details: Record<string, unknown>;
  raw_data: Record<string, unknown>;
}

function mapMovement(movement: Record<string, unknown>): MappedMovement {
  return {
    id: String(movement.id),
    type: movement.type as string || "",
    description: movement.description as string || "",
    amount: movement.amount as number || 0,
    net_amount: (movement.amount as number || 0) - ((movement.commission as number || 0) + (movement.taxes as number || 0)),
    currency_id: "ARS",
    status: movement.status as string || "active",
    date_created: movement.date_created as string || new Date().toISOString(),
    payer_id: movement.payer_id as string | null || null,
    related_resource: movement.related_resource as string | null || null,
    details: (movement.details || {}) as Record<string, unknown>,
    raw_data: movement,
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
    const token = authHeader.replace("Bearer ", "").trim();
    const expectedToken = process.env.SYNC_MERCADOPAGO_TOKEN || "";

    if (!token || !expectedToken || token !== expectedToken) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
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

    // Fetch all money movements
    let allMovements: Record<string, unknown>[] = [];
    let offset = 0;

    console.log("Fetching money movements from MercadoPago...");

    while (true) {
      try {
        const res = await fetch(
          `https://api.mercadopago.com/v1/account/money/balance/movements?limit=100&offset=${offset}`,
          {
            headers: { Authorization: `Bearer ${mpToken}` },
          }
        );

        if (!res.ok) {
          console.error(`MercadoPago fetch failed: ${res.status}`);
          break;
        }

        const data = await res.json();
        const results = data.results as Record<string, unknown>[] || [];

        if (!results || results.length === 0) {
          console.log("Reached end of movements list");
          break;
        }

        allMovements = allMovements.concat(results);
        offset += 100;

        console.log(`Fetched ${allMovements.length} movements so far...`);

        // Safety limit
        if (allMovements.length >= 100000) {
          console.log("Reached safety limit");
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error fetching:`, error);
        break;
      }
    }

    console.log(`Total movements fetched: ${allMovements.length}`);

    // Get existing IDs
    console.log("Checking for existing records...");
    const { data: existingIds } = await supabase
      .from("mercadopago_movements")
      .select("id");

    const existingIdSet = new Set((existingIds || []).map(r => r.id));

    // Prepare bulk insert
    const toInsert = allMovements
      .filter(m => m && m.id && !existingIdSet.has(String(m.id)))
      .map(m => {
        const mapped = mapMovement(m);
        return {
          id: mapped.id,
          type: mapped.type,
          description: mapped.description,
          amount: mapped.amount,
          net_amount: mapped.net_amount,
          currency_id: mapped.currency_id,
          status: mapped.status,
          date_created: mapped.date_created,
          payer_id: mapped.payer_id,
          related_resource: mapped.related_resource,
          details: mapped.details,
          raw_data: mapped.raw_data,
        };
      });

    let saved = 0;
    let skipped = allMovements.length - toInsert.length;
    let errors = 0;

    console.log(`Preparing to insert ${toInsert.length} new movements...`);
    for (let i = 0; i < toInsert.length; i += 1000) {
      const batch = toInsert.slice(i, i + 1000);
      const { error } = await supabase.from("mercadopago_movements").insert(batch);

      if (!error) {
        saved += batch.length;
        console.log(`Inserted batch: ${Math.min(i + 1000, toInsert.length)}/${toInsert.length}`);
      } else {
        console.error(`Error in batch ${i / 1000}:`, error.message);
        errors += batch.length;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Sync completed",
        total_fetched: allMovements.length,
        saved,
        skipped,
        errors,
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
