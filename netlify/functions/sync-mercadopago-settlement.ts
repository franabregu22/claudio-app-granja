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
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    if (!authHeader || !authHeader.trim()) {
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

    // Generate settlement report
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const beginDate = thirtyDaysAgo.toISOString().split("T")[0];
    const endDate = now.toISOString().split("T")[0];

    console.log(`Generating settlement report for ${beginDate} to ${endDate}...`);

    const reportRes = await fetch("https://api.mercadopago.com/v1/account/settlement_report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        begin_date: `${beginDate}T00:00:00Z`,
        end_date: `${endDate}T23:59:59Z`,
      }),
    });

    if (reportRes.status !== 202) {
      console.error(`Report generation failed: ${reportRes.status}`);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Failed to generate report" }),
        headers,
      };
    }

    const reportData = await reportRes.json();
    const reportId = reportData.id;

    if (!reportId) {
      console.error("No report ID in response");
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No report ID in response" }),
        headers,
      };
    }

    console.log(`Report queued: ${reportId}. Waiting for generation...`);

    // Wait longer for report to be generated
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Try to download with report ID
    console.log(`Attempting to download report ${reportId}...`);

    let downloadRes = await fetch(
      `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
      {
        headers: { Authorization: `Bearer ${mpToken}` },
      }
    );

    // If 404 or 403, might need to wait more
    if (!downloadRes.ok && (downloadRes.status === 404 || downloadRes.status === 403)) {
      console.log("Report not ready yet, waiting more...");
      await new Promise(resolve => setTimeout(resolve, 10000));

      downloadRes = await fetch(
        `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
        {
          headers: { Authorization: `Bearer ${mpToken}` },
        }
      );
    }

    if (!downloadRes.ok) {
      const errorText = await downloadRes.text();
      console.error(`Download failed: ${downloadRes.status}`, errorText);
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Failed to download report",
          status: downloadRes.status,
          detail: errorText.substring(0, 200)
        }),
        headers,
      };
    }

    const csvText = await downloadRes.text();
    const lines = csvText.split("\n").filter(l => l.trim());

    console.log(`CSV has ${lines.length} lines. Parsing...`);

    // Parse CSV (simple parser for MercadoPago format)
    let saved = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      try {
        const parts = line.split(",");
        const sourceId = parts[1]?.trim();

        if (!sourceId) {
          skipped++;
          continue;
        }

        // Check if already exists
        const { data: existing } = await supabase
          .from("mercadopago_settlement")
          .select("id")
          .eq("source_id", sourceId)
          .single();

        if (existing) {
          skipped++;
          continue;
        }

        // Parse CSV fields (MercadoPago settlement format)
        const record = {
          date_movement: parts[0] ? new Date(parts[0].trim()).toISOString() : null,
          source_id: sourceId,
          record_type: parts[2]?.trim() || null,
          movement_type: parts[3]?.trim() || null,
          net_credit_amount: parts[4] ? parseFloat(parts[4]) : null,
          net_debit_amount: parts[5] ? parseFloat(parts[5]) : null,
          gross_amount: parts[6] ? parseFloat(parts[6]) : null,
          mp_fee_amount: parts[7] ? parseFloat(parts[7]) : null,
          financing_fee_amount: parts[8] ? parseFloat(parts[8]) : null,
          shipping_fee_amount: parts[9] ? parseFloat(parts[9]) : null,
          taxes_amount: parts[10] ? parseFloat(parts[10]) : null,
          external_reference: parts[11]?.trim() || null,
          related_source_id: parts[12]?.trim() || null,
          coupon_amount: parts[13] ? parseFloat(parts[13]) : null,
          raw_line: line,
        };

        const { error } = await supabase
          .from("mercadopago_settlement")
          .insert([record]);

        if (!error) {
          saved++;
        } else {
          console.error(`Error inserting ${sourceId}:`, error.message);
          errors++;
        }
      } catch (parseError) {
        console.error(`Parse error on line ${i}:`, parseError);
        errors++;
      }
    }

    console.log(`Settlement sync complete: ${saved} saved, ${skipped} skipped, ${errors} errors`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Settlement report synced",
        report_id: reportId,
        period: `${beginDate} to ${endDate}`,
        total_lines: lines.length - 1,
        saved,
        skipped,
        errors,
        timestamp: new Date().toISOString(),
      }),
      headers,
    };
  } catch (error) {
    console.error("Fatal error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

export { handler };
