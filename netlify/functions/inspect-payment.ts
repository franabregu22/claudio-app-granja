import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const handler: Handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || "");

    // Get a sample of payments to see what fields are available
    const { data } = await supabase
      .from("mercadopago_raw")
      .select("data")
      .limit(3);

    if (!data || !data[0]) {
      return { statusCode: 400, body: JSON.stringify({ error: "No payments found" }), headers };
    }

    const sample = data[0].data as Record<string, unknown>;

    // Extract available keys from first payment
    const keys = Object.keys(sample).sort();

    return {
      statusCode: 200,
      body: JSON.stringify({
        available_fields: keys,
        sample_data: {
          id: sample.id,
          status: sample.status,
          transaction_amount: sample.transaction_amount,
          transaction_details: sample.transaction_details,
          money_release_info: sample.money_release_info,
          fee_details: sample.fee_details,
          metadata: sample.metadata,
        },
      }, null, 2),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: String(error) }), headers };
  }
};

export { handler };
