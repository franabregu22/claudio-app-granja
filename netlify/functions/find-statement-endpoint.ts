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

    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const beginDate = ninetyDaysAgo.toISOString();
    const endDate = now.toISOString();

    const endpoints = [
      { url: "/v1/account/settlement_report", name: "settlement_report" },
      { url: "/v1/account/settlement_statement", name: "settlement_statement" },
      { url: "/v1/reports/settlement", name: "reports/settlement" },
      { url: "/v1/account/statement", name: "account/statement" },
      { url: "/v1/movements/settlement", name: "movements/settlement" },
    ];

    const results: Record<string, any> = {};

    for (const { url, name } of endpoints) {
      try {
        const res = await fetch(`https://api.mercadopago.com${url}`, {
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

        const data = await res.json();
        results[name] = {
          status: res.status,
          message: data.message || data.error || "success",
          hasId: !!data.id,
          id: data.id,
        };
      } catch (e) {
        results[name] = { error: String(e) };
      }

      await new Promise(r => setTimeout(r, 500));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ endpoints_tested: results }, null, 2),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
