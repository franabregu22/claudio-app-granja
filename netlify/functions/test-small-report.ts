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

    // Small report: only 7 days
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    console.log("Creating small 7-day settlement report...");
    const startTime = Date.now();

    const createRes = await fetch("https://api.mercadopago.com/v1/account/settlement_report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        begin_date: sevenDaysAgo.toISOString(),
        end_date: now.toISOString(),
      }),
    });

    const reportData = await createRes.json();
    const reportId = reportData.id;
    const createTime = Date.now() - startTime;

    console.log(`Report ${reportId} created in ${createTime}ms`);

    // Poll quickly to see how fast it completes
    let completed = false;
    let pollCount = 0;
    const maxPolls = 30;
    let completionTime = 0;

    while (!completed && pollCount < maxPolls) {
      pollCount++;
      await new Promise(r => setTimeout(r, 500));

      const statusRes = await fetch(
        `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );

      if (statusRes.ok) {
        const status = await statusRes.json();
        console.log(`Poll ${pollCount}: ${status.status}`);

        if (status.status === "completed") {
          completed = true;
          completionTime = Date.now() - startTime;
          console.log(`Completed in ${completionTime}ms (${pollCount} polls)`);

          // Try to download
          const dlRes = await fetch(
            `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
            { headers: { Authorization: `Bearer ${mpToken}` } }
          );

          if (dlRes.ok) {
            const csv = await dlRes.text();
            const lines = csv.split("\n").filter(l => l.trim());

            return {
              statusCode: 200,
              body: JSON.stringify({
                success: true,
                report_id: reportId,
                creation_time_ms: createTime,
                completion_time_ms: completionTime,
                polls_needed: pollCount,
                csv_lines: lines.length,
                csv_preview: lines.slice(0, 5),
                period: `${sevenDaysAgo.toISOString().split("T")[0]} to ${now.toISOString().split("T")[0]}`,
              }),
              headers,
            };
          }
        }
      }
    }

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "Report not completed in time",
        creation_time_ms: createTime,
        polls_done: pollCount,
        last_status: "pending",
      }),
      headers,
    };
  } catch (error) {
    console.error("Fatal:", error);
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
