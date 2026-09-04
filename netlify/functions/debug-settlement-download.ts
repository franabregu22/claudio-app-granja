import { Handler } from "@netlify/functions";

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const clientId = process.env.MERCADOPAGO_CLIENT_ID;
    const clientSecret = process.env.MERCADOPAGO_CLIENT_SECRET;

    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
    });

    const tokenData = await tokenRes.json();
    const mpToken = tokenData.access_token;

    // Use most recent report ID from previous debug
    const reportId = 103053915; // From "With columns parameter"

    console.log(`Checking status and download options for report ${reportId}...`);

    // First, check status by GET-ing the report
    const statusRes = await fetch(`https://api.mercadopago.com/v1/account/settlement_report/${reportId}`, {
      headers: { Authorization: `Bearer ${mpToken}` },
    });

    console.log(`GET settlement_report/${reportId} status: ${statusRes.status}`);
    const statusData = await statusRes.json();
    console.log("Status response:", JSON.stringify(statusData, null, 2));

    const results: Record<string, any> = {};

    // Try different download endpoints
    const downloadEndpoints = [
      { url: `/v1/account/settlement_report/${reportId}`, name: "Direct ID" },
      { url: `/v1/account/settlement_report/${reportId}/download`, name: "ID + /download" },
      { url: `/v1/settlement_report/${reportId}`, name: "Simplified path" },
      { url: `/v1/reports/settlement/${reportId}`, name: "Reports API" },
      {
        url: statusData.file_name ? `/v1/account/settlement_report/${statusData.file_name}` : null,
        name: "Using file_name field",
      },
    ];

    for (const { url, name } of downloadEndpoints) {
      if (!url) {
        results[name] = { skipped: true, reason: "No file_name in response" };
        continue;
      }

      console.log(`\nTrying: ${name} (${url})`);

      try {
        const res = await fetch(`https://api.mercadopago.com${url}`, {
          headers: { Authorization: `Bearer ${mpToken}` },
        });

        console.log(`Response: ${res.status}`);

        const contentType = res.headers.get("content-type");

        if (res.ok && (contentType?.includes("text") || contentType?.includes("csv"))) {
          const text = await res.text();
          results[name] = {
            status: res.status,
            success: true,
            contentType,
            preview: text.split("\n").slice(0, 3),
            totalLines: text.split("\n").length,
          };
        } else if (res.ok) {
          const text = await res.text();
          results[name] = {
            status: res.status,
            contentType,
            preview: text.substring(0, 200),
          };
        } else {
          const text = await res.text();
          results[name] = {
            status: res.status,
            error: text.substring(0, 100),
          };
        }
      } catch (e) {
        console.error(`Exception on ${name}:`, e);
        results[name] = { error: String(e) };
      }

      await new Promise(r => setTimeout(r, 500));
    }

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          report_id: reportId,
          current_status: statusData.status,
          download_attempts: results,
        },
        null,
        2
      ),
      headers,
    };
  } catch (error) {
    console.error("Fatal:", error);
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
