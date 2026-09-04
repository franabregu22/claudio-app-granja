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

    const endpoints = [
      "/v1/transactions",
      "/v1/movements",
      "/v1/account/transactions",
      "/v1/account/movements",
      "/v1/reports/transactions",
      "/v1/account/settlement_report",
      "/v1/account/available_balance",
      "/v1/users/me",
      "/v1/account/fund",
    ];

    const results: Record<string, any> = {};

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`https://api.mercadopago.com${endpoint}`, {
          headers: { Authorization: `Bearer ${mpToken}` },
        });

        results[endpoint] = {
          status: res.status,
          ok: res.ok,
          contentType: res.headers.get("content-type"),
        };

        if (res.ok && endpoint === "/v1/users/me") {
          const data = await res.json();
          results[endpoint].sample = data;
        }
      } catch (e) {
        results[endpoint] = { error: String(e) };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ available_endpoints: results }, null, 2),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers: headers };
  }
};

export { handler };
