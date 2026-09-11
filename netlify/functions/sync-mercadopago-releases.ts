import { Handler } from "@netlify/functions";

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
    // Authenticate
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

    console.log("[CREATE-REPORT] Initiating Mercado Pago release report generation");

    // Get MP Access Token
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

    if (!mpToken) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing MERCADOPAGO_ACCESS_TOKEN" }),
        headers,
      };
    }

    // Create report for 24 hours (simple UTC dates for testing)
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Format as simple ISO strings WITHOUT milliseconds
    const beginDate = oneDayAgo.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endDate = now.toISOString().replace(/\.\d{3}Z$/, "Z");

    console.log(`[CREATE-REPORT] Test window (24h): ${beginDate} to ${endDate}`);

    const requestBody = {
      begin_date: beginDate,
      end_date: endDate,
    };

    console.log(`[CREATE-REPORT] Request method: POST`);
    console.log(`[CREATE-REPORT] Request URL: https://api.mercadopago.com/v1/account/release_report`);
    console.log(`[CREATE-REPORT] Request body: ${JSON.stringify(requestBody)}`);
    console.log(`[CREATE-REPORT] Request headers: Authorization: Bearer [TOKEN], Content-Type: application/json`);

    const createRes = await fetch("https://api.mercadopago.com/v1/account/release_report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    console.log(`[CREATE-REPORT] Response status: ${createRes.status}`);

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.log(`[CREATE-REPORT] MP Response body: ${errText}`);
      throw new Error(`Failed to create report: ${createRes.status} ${errText}`);
    }

    const reportData = await createRes.json();
    const reportId = reportData.id;

    if (!reportId) {
      throw new Error("No report ID in response");
    }

    console.log(`[CREATE-REPORT] Report created: ID=${reportId}, Status=${reportData.status}`);

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          success: true,
          action: "report_created",
          report_id: reportId,
          status: reportData.status,
          created_at: new Date().toISOString(),
          window_start: beginDate,
          window_end: endDate,
          next_step: `Call sync-mercadopago-releases-status with report_id=${reportId}`,
        },
        null,
        2
      ),
      headers,
    };
  } catch (error) {
    console.error("[CREATE-REPORT] ERROR:", error);
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
