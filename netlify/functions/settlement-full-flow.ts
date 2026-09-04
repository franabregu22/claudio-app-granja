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

    if (!mpToken) {
      return { statusCode: 400, body: JSON.stringify({ error: "No token" }), headers };
    }

    // Step 1: CREATE report
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    console.log("Step 1: Creating settlement report...");

    const createRes = await fetch("https://api.mercadopago.com/v1/account/settlement_report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        begin_date: sixtyDaysAgo.toISOString(),
        end_date: now.toISOString(),
      }),
    });

    if (createRes.status !== 202) {
      return {
        statusCode: createRes.status,
        body: JSON.stringify({ error: "Failed to create report", status: createRes.status }),
        headers,
      };
    }

    const reportData = await createRes.json();
    const reportId = reportData.id;

    console.log(`Step 2: Report created with ID ${reportId}, status: ${reportData.status}`);

    // Step 2: POLL for completion (limited time due to Netlify 30s timeout)
    let completed = false;
    let finalStatus = reportData;
    let pollCount = 0;
    const maxPolls = 12; // 12 polls x 1.5s = 18 seconds max

    while (!completed && pollCount < maxPolls) {
      pollCount++;

      console.log(`Poll ${pollCount}: Checking status...`);

      // Wait before polling (reduced for timeout)
      await new Promise(r => setTimeout(r, 1500));

      const statusRes = await fetch(
        `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );

      if (!statusRes.ok) {
        console.log(`Status check returned ${statusRes.status}`);
        const errText = await statusRes.text();
        console.log("Error:", errText.substring(0, 100));
        continue;
      }

      finalStatus = await statusRes.json();
      console.log(`Status: ${finalStatus.status}`);

      if (finalStatus.status === "completed") {
        completed = true;
        console.log("Report completed!");
      }
    }

    if (!completed) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Report not completed after polling",
          last_status: finalStatus.status,
          polls_done: pollCount,
        }),
        headers,
      };
    }

    // Step 3: DOWNLOAD
    console.log("Step 3: Downloading CSV...");

    // Try the ID endpoint first
    let csvRes = await fetch(
      `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
      { headers: { Authorization: `Bearer ${mpToken}` } }
    );

    if (!csvRes.ok) {
      console.log(`Download attempt 1 failed (${csvRes.status}), trying alternative...`);

      // Try with /download suffix
      csvRes = await fetch(
        `https://api.mercadopago.com/v1/account/settlement_report/${reportId}/download`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );
    }

    if (!csvRes.ok) {
      // Check if file_name or download_url appeared in final status
      console.log("Final status object:", JSON.stringify(finalStatus));

      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Failed to download report",
          status_code: csvRes.status,
          final_status_object: finalStatus,
          fields_in_response: Object.keys(finalStatus),
        }),
        headers,
      };
    }

    const csvText = await csvRes.text();

    console.log(`CSV downloaded: ${csvText.length} bytes, ${csvText.split("\n").length} lines`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        report_id: reportId,
        status: finalStatus.status,
        polls_used: pollCount,
        csv_lines: csvText.split("\n").length,
        csv_preview: csvText.split("\n").slice(0, 5),
        period: `${sixtyDaysAgo.toISOString().split("T")[0]} to ${now.toISOString().split("T")[0]}`,
      }),
      headers,
    };
  } catch (error) {
    console.error("Fatal:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      headers,
    };
  }
};

export { handler };
