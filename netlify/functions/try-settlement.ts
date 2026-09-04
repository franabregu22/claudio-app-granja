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

    // Generate settlement report with last 90 days
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const beginDate = ninetyDaysAgo.toISOString().split("T")[0];
    const endDate = now.toISOString().split("T")[0];

    console.log(`Requesting settlement report for ${beginDate} to ${endDate}...`);

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

    console.log(`Report response status: ${reportRes.status}`);

    const reportData = await reportRes.json();
    console.log("Report response:", JSON.stringify(reportData, null, 2));

    const reportId = reportData.id;

    if (!reportId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No report ID", data: reportData }),
        headers,
      };
    }

    console.log(`Report ID: ${reportId}, Status: ${reportData.status}`);

    // Try waiting longer and checking status
    for (let wait = 1; wait <= 5; wait++) {
      await new Promise(r => setTimeout(r, wait * 2000));

      console.log(`Wait #${wait}: Checking report status...`);

      const statusRes = await fetch(
        `https://api.mercadopago.com/v1/account/settlement_report/${reportId}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );

      console.log(`Status check response: ${statusRes.status}`);

      if (statusRes.ok) {
        const csv = await statusRes.text();
        console.log(`Got CSV! Length: ${csv.length}`);
        return { statusCode: 200, body: JSON.stringify({ success: true, csv_length: csv.length, first_lines: csv.split("\n").slice(0, 3) }), headers };
      }

      const statusError = await statusRes.text();
      console.log(`Status error: ${statusRes.status} - ${statusError.substring(0, 100)}`);
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Could not get CSV after retries", reportId }), headers };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
