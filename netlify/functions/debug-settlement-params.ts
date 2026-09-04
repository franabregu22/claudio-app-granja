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

    // Test different parameter combinations
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const paramCombos = [
      {
        name: "Full ISO 8601 UTC",
        body: {
          begin_date: sixtyDaysAgo.toISOString(),
          end_date: now.toISOString(),
        },
      },
      {
        name: "ISO 8601 no milliseconds",
        body: {
          begin_date: sixtyDaysAgo.toISOString().split(".")[0] + "Z",
          end_date: now.toISOString().split(".")[0] + "Z",
        },
      },
      {
        name: "YYYY-MM-DD only",
        body: {
          begin_date: sixtyDaysAgo.toISOString().split("T")[0],
          end_date: now.toISOString().split("T")[0],
        },
      },
      {
        name: "Unix timestamp",
        body: {
          begin_date: Math.floor(sixtyDaysAgo.getTime() / 1000),
          end_date: Math.floor(now.getTime() / 1000),
        },
      },
      {
        name: "With type parameter",
        body: {
          begin_date: sixtyDaysAgo.toISOString(),
          end_date: now.toISOString(),
          type: "settlement",
        },
      },
      {
        name: "With columns parameter",
        body: {
          begin_date: sixtyDaysAgo.toISOString(),
          end_date: now.toISOString(),
          columns: ["all"],
        },
      },
    ];

    const results: Record<string, any> = {};

    for (const combo of paramCombos) {
      console.log(`\nTrying: ${combo.name}`);
      console.log(`Body:`, JSON.stringify(combo.body));

      try {
        const res = await fetch("https://api.mercadopago.com/v1/account/settlement_report", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${mpToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(combo.body),
        });

        console.log(`Response status: ${res.status}`);

        const data = await res.json();
        console.log(`Response:`, JSON.stringify(data));

        results[combo.name] = {
          status: res.status,
          response: data,
          hasId: !!data.id,
          hasFileName: !!data.file_name,
        };
      } catch (e) {
        console.error(`Exception:`, e);
        results[combo.name] = { error: String(e) };
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ parameter_tests: results }, null, 2),
      headers,
    };
  } catch (error) {
    console.error("Fatal:", error);
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
