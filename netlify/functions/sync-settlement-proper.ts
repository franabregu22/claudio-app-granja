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
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }), headers };
    }

    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    console.log("Getting MercadoPago token...");
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${process.env.MERCADOPAGO_CLIENT_ID}&client_secret=${process.env.MERCADOPAGO_CLIENT_SECRET}`,
    });

    const tokenData = await tokenRes.json();
    const mpToken = tokenData.access_token;

    if (!mpToken) {
      return { statusCode: 400, body: JSON.stringify({ error: "Failed to get token" }), headers };
    }

    // Generate settlement report
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const beginDate = ninetyDaysAgo.toISOString();
    const endDate = now.toISOString();

    console.log(`Requesting settlement report for ${beginDate.split('T')[0]} to ${endDate.split('T')[0]}...`);

    const reportRes = await fetch("https://api.mercadopago.com/v1/account/settlement_report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        begin_date: beginDate,
        end_date: endDate,
      }),
    });

    console.log(`Report creation response: ${reportRes.status}`);

    if (!reportRes.ok && reportRes.status !== 202) {
      const errData = await reportRes.json();
      console.error("Report creation failed:", errData);
      return {
        statusCode: reportRes.status,
        body: JSON.stringify({ error: "Failed to create report", detail: errData }),
        headers,
      };
    }

    const reportData = await reportRes.json();
    const reportId = reportData.id;

    console.log(`Report queued with ID: ${reportId}, Status: ${reportData.status}`);

    if (!reportId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No report ID returned", data: reportData }),
        headers,
      };
    }

    // Poll for completion - wait up to 60 seconds
    let completed = false;
    let finalData = reportData;

    for (let i = 0; i < 30; i++) {
      if (finalData.status === "completed") {
        completed = true;
        console.log(`Report completed after ${i} polls`);
        break;
      }

      await new Promise(r => setTimeout(r, 2000));

      console.log(`Poll #${i + 1}: Checking status...`);

      const statusRes = await fetch(
        `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );

      if (statusRes.ok) {
        finalData = await statusRes.json();
        console.log(`Status: ${finalData.status}`);
      } else {
        console.log(`Status check failed: ${statusRes.status}`);
      }
    }

    if (!completed) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Report not completed after polling",
          status: finalData.status,
          reportId,
        }),
        headers,
      };
    }

    // Now download the CSV
    console.log(`Downloading CSV for report ${reportId}...`);

    const downloadRes = await fetch(
      `https://api.mercadopago.com/v1/account/settlement_report/${reportId}/download`,
      {
        headers: { Authorization: `Bearer ${mpToken}` },
      }
    );

    if (!downloadRes.ok) {
      console.error(`Download failed: ${downloadRes.status}`);
      const errText = await downloadRes.text();
      console.error("Error:", errText.substring(0, 200));

      // Try alternative endpoint
      console.log("Trying alternative download endpoint...");
      const altRes = await fetch(
        `https://api.mercadopago.com/v1/settlement_report/${reportId}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );

      if (!altRes.ok) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "Failed to download report",
            primary_status: downloadRes.status,
            alt_status: altRes.status,
          }),
          headers,
        };
      }

      const csvText = await altRes.text();
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          lines: csvText.split("\n").length,
          first_line: csvText.split("\n")[0],
          message: "Downloaded from alternative endpoint",
        }),
        headers,
      };
    }

    const csvText = await downloadRes.text();

    console.log(`CSV downloaded: ${csvText.length} bytes, ${csvText.split("\n").length} lines`);

    // Parse CSV
    const lines = csvText.split("\n").filter(l => l.trim());

    let saved = 0;
    let skipped = 0;

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

        const { error } = await supabase.from("mercadopago_settlement").upsert([record], {
          onConflict: "source_id",
        });

        if (!error) {
          saved++;
        } else {
          console.error(`Insert error for ${sourceId}:`, error.message);
          skipped++;
        }
      } catch (parseError) {
        console.error(`Parse error on line ${i}:`, parseError);
        skipped++;
      }
    }

    const now_iso = new Date().toISOString();
    await supabase.from("sync_metadata").upsert(
      { sync_type: "settlement_report", last_sync_date: now_iso, last_sync_count: saved },
      { onConflict: "sync_type" }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Settlement report synced",
        report_id: reportId,
        period: `${beginDate.split('T')[0]} to ${endDate.split('T')[0]}`,
        total_lines: lines.length,
        saved,
        skipped,
        timestamp: now_iso,
      }),
      headers,
    };
  } catch (error) {
    console.error("Fatal error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

export { handler };
