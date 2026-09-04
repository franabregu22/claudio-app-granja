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

    // Step 1: Create report configuration
    console.log("Creating settlement report configuration...");

    const configRes = await fetch("https://api.mercadopago.com/v1/account/settlement_report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "settlement",
      }),
    });

    console.log(`Config response: ${configRes.status}`);
    const configData = await configRes.json();
    console.log("Config response:", JSON.stringify(configData, null, 2));

    if (configRes.ok && configData.id) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          config_id: configData.id,
          message: "Settlement report configuration created",
          data: configData,
        }),
        headers,
      };
    }

    return {
      statusCode: configRes.status,
      body: JSON.stringify({ error: "Config creation failed", data: configData }),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
