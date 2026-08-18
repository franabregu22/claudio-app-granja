import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

serve(async (req) => {
  try {
    // Validate authorization
    const authHeader = req.headers.get("Authorization");
    const edgeSecret = Deno.env.get("EDGE_FUNCTION_SECRET");

    if (!authHeader || !edgeSecret) {
      return new Response(JSON.stringify({ error: "Missing configuration" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    if (token !== edgeSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    const clientId = Deno.env.get("MERCADOPAGO_CLIENT_ID");
    const clientSecret = Deno.env.get("MERCADOPAGO_CLIENT_SECRET");

    // Get token
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
    });

    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    if (!token) {
      return new Response(JSON.stringify({ success: false, error: "No token" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fetch ALL payments with pagination
    let allPayments = [];
    let offset = 0;
    const myId = Number(Deno.env.get("MERCADOPAGO_COLLECTOR_ID") || "0");

    while (true) {
      console.log(`Fetching offset ${offset}...`);

      const res = await fetch(
        `https://api.mercadopago.com/v1/payments/search?limit=100&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!res.ok) {
        console.error("Fetch failed:", res.status);
        break;
      }

      const data = await res.json();
      const results = data.results;

      if (!results || results.length === 0) {
        console.log("No more results");
        break;
      }

      allPayments = allPayments.concat(results);
      offset = offset + 100;
    }

    console.log(`Total payments: ${allPayments.length}`);

    // Process payments
    let created = 0;
    let skipped = 0;

    for (const p of allPayments) {
      if (!p || !p.id) continue;

      const id = String(p.id);

      // Check if already exists - DEDUPLICATION
      const checkRes = await supabase
        .from("movimientos_caja")
        .select("id")
        .eq("vinculado_id", id)
        .eq("vinculado_a", "mercadopago")
        .limit(1);

      if (checkRes.data && checkRes.data.length > 0) {
        skipped = skipped + 1;
        continue;
      }

      // Determine tipo
      const tipo = p.collector_id === myId ? "ingreso" : "egreso";

      // Get concepto
      let concepto = "Movimiento";
      if (p.description) concepto = String(p.description);
      if (tipo === "ingreso" && p.payer) {
        let name = "";
        if (p.payer.first_name && p.payer.last_name) {
          name = `${p.payer.first_name} ${p.payer.last_name}`;
        } else if (p.payer.first_name) {
          name = p.payer.first_name;
        } else if (p.payer.last_name) {
          name = p.payer.last_name;
        } else if (p.payer.email) {
          name = p.payer.email;
        } else {
          name = "Desconocido";
        }
        concepto = `Transferencia de ${name}`;
      }

      // Get fecha
      let fecha = "2026-01-01";
      if (p.date_created && typeof p.date_created === "string") {
        fecha = p.date_created.substring(0, 10);
      }

      // CALCULO CORRECTO:
      // monto = bruto (lo que se debita/acredita)
      // impuesto_cheque = 0.6% (impuesto al débito/crédito)
      const bruto = Number(p.transaction_amount) || 0;
      const impuestoAlDebito = Number((bruto * 0.006).toFixed(2));

      // Insert - MONTO SIN INCLUIR IMPUESTO
      const insertRes = await supabase.from("movimientos_caja").insert({
        tipo: tipo,
        concepto: concepto.substring(0, 200),
        monto: bruto, // SOLO el bruto (sin impuesto)
        forma_pago: "mercadopago",
        fecha_operacion: fecha,
        fecha_pago: fecha,
        estado: "confirmado",
        impuesto_cheque: impuestoAlDebito, // 0.6% ADICIONAL
        notas: `Bruto: $${bruto} | Impuesto 0.6%: $${impuestoAlDebito} | ID: ${id}`,
        vinculado_a: "mercadopago",
        vinculado_id: id,
      });

      if (insertRes.error) {
        console.error(`Error ${id}:`, insertRes.error.message);
      } else {
        created = created + 1;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        total: allPayments.length,
        created: created,
        skipped: skipped,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
