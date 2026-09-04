import { Handler } from "@netlify/functions";

const handler: Handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }), headers };
  }

  try {
    const body = event.body || "";
    const csvText = Buffer.from(body, event.isBase64Encoded ? "base64" : "utf-8").toString("utf-8");

    if (!csvText || csvText.length < 10) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "CSV is empty or too short" }),
        headers,
      };
    }

    const lines = csvText.split("\n").filter(l => l.trim());

    if (lines.length < 2) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "CSV must have header + at least 1 data line" }),
        headers,
      };
    }

    // Parse header
    const headerLine = lines[0];
    const headers_arr = headerLine.split(",").map(h => h.trim());

    console.log("CSV Headers:", headers_arr);

    // Parse data lines
    const records: Record<string, any>[] = [];
    const typeCount: Record<string, number> = {};
    let totalCredit = 0;
    let totalDebit = 0;
    let errors = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      try {
        const parts = line.split(",");
        const record: Record<string, any> = {};

        headers_arr.forEach((header, idx) => {
          record[header] = parts[idx]?.trim() || null;
        });

        const movementType = record.Tipo || record.movement_type || "UNKNOWN";
        typeCount[movementType] = (typeCount[movementType] || 0) + 1;

        // Track amounts
        const creditStr = record["Crédito Neto"] || record.net_credit_amount || "0";
        const debitStr = record["Débito Neto"] || record.net_debit_amount || "0";

        if (creditStr && creditStr !== "0" && creditStr !== "") {
          totalCredit += parseFloat(creditStr) || 0;
        }
        if (debitStr && debitStr !== "0" && debitStr !== "") {
          totalDebit += parseFloat(debitStr) || 0;
        }

        records.push(record);
      } catch (e) {
        console.error(`Error parsing line ${i}:`, e);
        errors++;
      }
    }

    const netTotal = totalCredit - totalDebit;

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          preview: true,
          status: "PREVIEW - not synced yet",
          csv_stats: {
            total_lines: lines.length,
            header_line: 1,
            data_lines: records.length,
            parse_errors: errors,
          },
          headers: headers_arr,
          movement_types: typeCount,
          financial_summary: {
            total_credit_ars: totalCredit.toFixed(2),
            total_debit_ars: totalDebit.toFixed(2),
            net_total_ars: netTotal.toFixed(2),
            target_balance_ars: "172814.62",
            difference_ars: (netTotal - 172814.62).toFixed(2),
          },
          sample_records: records.slice(0, 3),
          next_step: "POST to /sync-settlement-csv with confirm=true to actually insert data",
        },
        null,
        2
      ),
      headers,
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      headers,
    };
  }
};

export { handler };
