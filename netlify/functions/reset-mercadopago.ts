import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const handler: Handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }), headers };
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    if (!supabaseUrl || !supabaseKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing Supabase config" }),
        headers,
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log("Clearing mercadopago_raw...");
    const { error: e1 } = await supabase.from("mercadopago_raw").delete().neq("id", "");

    console.log("Clearing sync_metadata...");
    const { error: e2 } = await supabase.from("sync_metadata").delete().neq("sync_type", "");

    if (e1 || e2) {
      console.error("Errors:", e1?.message, e2?.message);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Clear failed", errors: [e1, e2] }),
        headers,
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: "All tables cleared" }),
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
