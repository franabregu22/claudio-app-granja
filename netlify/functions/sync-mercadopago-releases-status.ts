import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import * as crypto from "crypto";
import { releaseIdentityIndex, classifyReleaseIdentity } from './lib/mp-release-identity';
import { collectPages } from '../../src/lib/mercadopago-calculations';

interface ParsedMovement {
  date: string;
  source_id: string;
  description: string;
  net_credit_amount: string;
  net_debit_amount: string;
  gross_amount: string;
  mp_fee_amount: string;
  taxes_amount: string;
  payment_method: string;
  raw_data: Record<string, string>;
  fingerprint: string;
  payload_hash: string;
}

function parseDecimalToCents(value: string): string {
  if (!value || !value.trim()) return "0";
  const trimmed = value.trim().replace(",", ".");
  const parts = trimmed.split(".");

  if (parts.length === 1) {
    return parts[0] + "00";
  } else if (parts.length === 2) {
    const integral = parts[0];
    const decimal = (parts[1] + "00").substring(0, 2);
    return integral + decimal;
  }
  return "0";
}

function generateFingerprint(
  date: string,
  source_id: string,
  net_credit_cents: string,
  net_debit_cents: string,
  description: string
): string {
  const credit_num = parseInt(net_credit_cents, 10);
  const debit_num = parseInt(net_debit_cents, 10);
  const signed_impact_cents = credit_num - debit_num;
  const signed_impact_str = (signed_impact_cents / 100).toFixed(2);

  const key = `${date}|${source_id}|${source_id}|${signed_impact_str}|${description}`;
  return crypto.createHash("md5").update(key).digest("hex");
}

function calculatePayloadHash(data: Record<string, string>): string {
  const jsonStr = JSON.stringify(data, Object.keys(data).sort(), 0);
  return crypto.createHash("sha256").update(jsonStr).digest("hex");
}

function parseCSV(csvText: string): Record<string, string>[] {
  const lines = csvText.split("\n");
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine);

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};

    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || "";
    }

    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === ";" && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function parseMovement(rowData: Record<string, string>): ParsedMovement | null {
  const date = rowData["DATE"]?.trim() || "";
  const source_id = rowData["SOURCE_ID"]?.trim() || "";
  const description = rowData["DESCRIPTION"]?.trim() || "";

  if (!date || !source_id) return null;

  const net_credit_cents = parseDecimalToCents(rowData["NET_CREDIT_AMOUNT"] || "0");
  const net_debit_cents = parseDecimalToCents(rowData["NET_DEBIT_AMOUNT"] || "0");
  const gross_cents = parseDecimalToCents(rowData["GROSS_AMOUNT"] || "0");
  const fee_cents = parseDecimalToCents(rowData["MP_FEE_AMOUNT"] || "0");
  const taxes_cents = parseDecimalToCents(rowData["TAXES_AMOUNT"] || "0");

  const payment_method = rowData["PAYMENT_METHOD"]?.trim() || "";

  const fingerprint = generateFingerprint(
    date,
    source_id,
    net_credit_cents,
    net_debit_cents,
    description
  );

  const payload_hash = calculatePayloadHash(rowData);

  return {
    date,
    source_id,
    description,
    net_credit_amount: net_credit_cents,
    net_debit_amount: net_debit_cents,
    gross_amount: gross_cents,
    mp_fee_amount: fee_cents,
    taxes_amount: taxes_cents,
    payment_method,
    raw_data: rowData,
    fingerprint,
    payload_hash,
  };
}

function centsToCurrency(cents: number): string {
  const dollars = cents / 100;
  return dollars.toFixed(2);
}

function buildInputRowForRPC(
  movement: ParsedMovement,
  reportId: string
): Record<string, string> {
  const creditPesos = (parseInt(movement.net_credit_amount, 10) / 100).toFixed(2);
  const debitPesos = (parseInt(movement.net_debit_amount, 10) / 100).toFixed(2);
  const grossPesos = (parseInt(movement.gross_amount, 10) / 100).toFixed(2);
  const feePesos = (parseInt(movement.mp_fee_amount, 10) / 100).toFixed(2);
  const taxesPesos = (parseInt(movement.taxes_amount, 10) / 100).toFixed(2);

  return {
    DATE: movement.date,
    SOURCE_ID: movement.source_id,
    DESCRIPTION: movement.description,
    NET_CREDIT_AMOUNT: creditPesos,
    NET_DEBIT_AMOUNT: debitPesos,
    GROSS_AMOUNT: grossPesos,
    MP_FEE_AMOUNT: feePesos,
    TAXES_AMOUNT: taxesPesos,
    PAYMENT_METHOD: movement.payment_method,
    BALANCE_AMOUNT: movement.raw_data.BALANCE_AMOUNT || '',
    TRANSACTION_APPROVAL_DATE: movement.raw_data.TRANSACTION_APPROVAL_DATE || '',
    _payload_hash: movement.payload_hash,
    _report_id: reportId,
  };
}

const handler: Handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }), headers };
  }

  try {
    // Authenticate
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const expectedToken = process.env.SYNC_MERCADOPAGO_TOKEN || "";

    if (!token || !expectedToken || token !== expectedToken) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
        headers,
      };
    }

    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (parseErr) {
      console.error(`[STATUS-REPORT] Failed to parse event.body: ${parseErr}`);
      console.error(`[STATUS-REPORT] Raw event.body: ${event.body}`);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid JSON in request body" }),
        headers,
      };
    }
    const taskId = body.task_id;
    const commit = body.commit === true;

    if (!taskId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing task_id in body" }),
        headers,
      };
    }

    const accountId = process.env.SYNC_ACCOUNT_ID || "1054315166";
    const writeEnabled = process.env.MP_SYNC_WRITE_ENABLED === "true";

    console.log(`[STATUS-REPORT] Checking task ${taskId}`);

    // Get MP Access Token
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

    if (!mpToken) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing MERCADOPAGO_ACCESS_TOKEN" }),
        headers,
      };
    }

    // Check task status using official task endpoint
    console.log(`[STATUS-REPORT] Fetching task status...`);

    const taskRes = await fetch(
      `https://api.mercadopago.com/v1/account/release_report/task/${taskId}`,
      { headers: { Authorization: `Bearer ${mpToken}` } }
    );

    if (!taskRes.ok) {
      return {
        statusCode: taskRes.status,
        body: JSON.stringify({ error: `Failed to get task status: ${taskRes.status}` }),
        headers,
      };
    }

    const responseText = await taskRes.text();
    console.log(`[STATUS-REPORT] Task response text (first 300 chars): ${responseText.substring(0, 300)}`);

    let taskStatus;
    try {
      taskStatus = JSON.parse(responseText);
    } catch (parseErr) {
      console.error(`[STATUS-REPORT] Failed to parse JSON: ${parseErr}`);
      console.error(`[STATUS-REPORT] Raw response: ${responseText}`);
      throw parseErr;
    }

    if (!taskStatus) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: `Task ${taskId} not found` }),
        headers,
      };
    }

    console.log(`[STATUS-REPORT] Current task status: ${taskStatus.status}`);

    // If not processed, return status (MP uses "processed" or "pending")
    if (taskStatus.status !== "processed" && taskStatus.status !== "enabled") {
      return {
        statusCode: 200,
        body: JSON.stringify(
          {
            success: true,
            action: "status_check",
            task_id: taskId,
            status: taskStatus.status,
            message: "Report is still being processed. Check again later.",
            checked_at: new Date().toISOString(),
          },
          null,
          2
        ),
        headers,
      };
    }

    // Task is ready - get report_id and file_name
    console.log(`[STATUS-REPORT] Task completed. Retrieving report details...`);

    const reportId = taskStatus.report_id;
    const fileName = taskStatus.file_name;

    if (!reportId || !fileName) {
      throw new Error(`Missing report_id or file_name in task response: ${JSON.stringify(taskStatus)}`);
    }

    console.log(`[STATUS-REPORT] Report ID: ${reportId}, File: ${fileName}`);

    const downloadRes = await fetch(
      `https://api.mercadopago.com/v1/account/release_report/${fileName}`,
      { headers: { Authorization: `Bearer ${mpToken}` } }
    );

    if (!downloadRes.ok) {
      throw new Error(`Failed to download: ${downloadRes.status}`);
    }

    const csvText = await downloadRes.text();
    const lines = csvText.split("\n").filter((l) => l.trim());

    console.log(`[STATUS-REPORT] Downloaded ${lines.length} lines. Parsing...`);

    // Parse CSV
    const rowsData = parseCSV(csvText);
    const movements: ParsedMovement[] = [];

    for (const rowData of rowsData) {
      const parsed = parseMovement(rowData);
      if (parsed) {
        movements.push(parsed);
      }
    }

    console.log(`[STATUS-REPORT] Parsed ${movements.length} movements`);

    // Query Supabase for existing financial movements (dedup against real data)
    console.log(`[STATUS-REPORT] Querying Supabase for existing financial movements...`);

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch all existing financial movements for account_id
    // (external_reference contains SOURCE_ID from historical import)
    const existingFMs = await collectPages<any>((from, to) => supabase
      .from("mp_financial_movement")
      .select('id,external_reference,settlement_amount,mp_movement_source_link(mp_source_record(source_external_id))', { count: 'exact' })
      .eq("account_id", parseInt(accountId, 10))
      .order('id').range(from, to));
    const identityIndex = releaseIdentityIndex(existingFMs);

    // Compare CSV movements against Supabase reality (by source_id match)
    const duplicatesInSupabase: ParsedMovement[] = [];
    const newMovementsNotInSupabase: ParsedMovement[] = [];

    const identityConflicts: string[] = [];
    let batchId = -1;
    for (const mov of movements) {
      const impact = parseInt(mov.net_credit_amount, 10) - parseInt(mov.net_debit_amount, 10);
      const identity = classifyReleaseIdentity(identityIndex, mov.source_id, mov.description.toLowerCase(), impact);
      if (identity === 'conflict') {
        identityConflicts.push(mov.source_id);
      } else if (identity === 'duplicate') {
        duplicatesInSupabase.push(mov);
      } else {
        newMovementsNotInSupabase.push(mov);
        if (identity === 'new') identityIndex.set(mov.source_id, new Map([[batchId--, impact]]));
      }
    }
    if (identityConflicts.length) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Hay operaciones repetidas o con importes distintos. Revisar antes de importar.', source_ids: [...new Set(identityConflicts)], writes_performed: false }) };
    }

    console.log(`[STATUS-REPORT] Duplicates in Supabase: ${duplicatesInSupabase.length}, New: ${newMovementsNotInSupabase.length}`);

    // Categorize movements (DRY RUN - compare against Supabase reality)
    const newMovements: ParsedMovement[] = [];
    const duplicateMovements: ParsedMovement[] = [];
    let rawOnlyCount = 0;
    let rawOnlyDuplicate = 0;
    let rawOnlyNew = 0;
    let ambiguousCount = 0;

    let ingresoCents = 0;
    let egresoCents = 0;

    for (const mov of movements) {
      const desc = mov.description.toLowerCase();
      const isDuplicate = duplicatesInSupabase.includes(mov);

      // Ignore control rows (opening/closing without SOURCE_ID)
      if (!mov.source_id || mov.source_id.trim() === "") {
        console.log(`[STATUS-REPORT] Ignoring control row without SOURCE_ID: ${desc}`);
        continue;
      }

      // Skip RAW_ONLY (reserves) - don't create FM for these
      if (desc === "reserve_for_payment" || desc === "reserve_for_payout") {
        rawOnlyCount++;
        if (isDuplicate) {
          rawOnlyDuplicate++;
        } else {
          rawOnlyNew++;
        }
        continue;
      }

      // Skip unclassified/ambiguous
      if (desc !== "payment" && desc !== "payout" && desc !== "asset_management" && desc !== "") {
        ambiguousCount++;
        continue;
      }

      // Valid classifiable movement
      if (isDuplicate) {
        duplicateMovements.push(mov);
      } else {
        newMovements.push(mov);
      }

      const credit_num = parseInt(mov.net_credit_amount, 10);
      const debit_num = parseInt(mov.net_debit_amount, 10);
      const impact = credit_num - debit_num;

      if (impact > 0) {
        ingresoCents += impact;
      } else if (impact < 0) {
        egresoCents += Math.abs(impact);
      }
    }

    // Build p_input_rows array for RPC import
    const rpcInputRows = [];
    for (const mov of movements) {
      const desc = mov.description.toLowerCase();

      // Skip control rows
      if (!mov.source_id || mov.source_id.trim() === "") {
        continue;
      }

      // Skip duplicates already in Supabase
      if (duplicatesInSupabase.includes(mov)) {
        continue;
      }

      // Include: classifiable movements + reserves
      if (
        desc === "payment" ||
        desc === "payout" ||
        desc === "asset_management" ||
        desc === "reserve_for_payment" ||
        desc === "reserve_for_payout"
      ) {
        rpcInputRows.push(buildInputRowForRPC(mov, reportId));
      } else {
        // Block unknown descriptions
        console.warn(
          `[STATUS-REPORT] WARNING: Unknown description '${desc}' for SOURCE_ID ${mov.source_id}. ` +
          `Will NOT be imported. Must review and classify manually.`
        );
      }
    }

    console.log(`[STATUS-REPORT] RPC input rows ready: ${rpcInputRows.length} rows (classifiable + reserves)`);

    // Build summary
    const netCents = ingresoCents - egresoCents;
    const summary = {
      report_id: reportId,
      csv_total_rows: movements.length,
      csv_existing_in_supabase: duplicatesInSupabase.length,
      csv_new_not_in_supabase: newMovementsNotInSupabase.length,
      raw_only_reserves: {
        total: rawOnlyCount,
        duplicates: rawOnlyDuplicate,
        new: rawOnlyNew,
      },
      financial_movements_valid: {
        duplicates: duplicateMovements.length,
        new: newMovements.length,
      },
      unclassified_ambiguous: ambiguousCount,
      ledger_entries_would_create: newMovements.length,
      ingresos: centsToCurrency(ingresoCents),
      egresos: centsToCurrency(egresoCents),
      neto: centsToCurrency(netCents),
      dedup_scope: "source_reference_and_amount_all_pages",
      rpc_input_rows_ready: rpcInputRows.length,
      read_only_dry_run: !commit || !writeEnabled,
      parsed_at: new Date().toISOString(),
    };

    console.log(`[STATUS-REPORT] Summary: ${JSON.stringify(summary)}`);

    let importResult = null;

    if (commit && writeEnabled && rpcInputRows.length > 0) {
      console.log(`[STATUS-REPORT] WRITE MODE: Calling import_financial_movements_reconciliation_v2 with ${rpcInputRows.length} rows`);

      const importRes = await supabase.rpc("import_financial_movements_reconciliation_v2", {
        p_account_id: parseInt(accountId, 10),
        p_input_rows: rpcInputRows,
        p_source_type: "report",
        p_month_start: new Date(reportId).toISOString().split("T")[0],
        p_month_end: new Date().toISOString().split("T")[0],
        p_import_id: `report-${reportId}-${Date.now()}`,
      });

      if (importRes.error) {
        console.error(`[STATUS-REPORT] RPC error: ${JSON.stringify(importRes.error)}`);
        throw importRes.error;
      }

      importResult = importRes.data;
      console.log(`[STATUS-REPORT] Import result: ${JSON.stringify(importResult)}`);
    } else if (commit && !writeEnabled) {
      console.warn(`[STATUS-REPORT] COMMIT REQUESTED BUT MP_SYNC_WRITE_ENABLED NOT SET - DRY RUN MODE`);
    } else if (!commit) {
      console.log(`[STATUS-REPORT] DRY RUN MODE (commit=false)`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          success: true,
          action: "report_processed",
          mode: commit && writeEnabled ? "write" : "dry_run",
          summary,
          ...(importResult && { import_result: importResult }),
          ...(newMovements.length > 0 && {
            preview: newMovements.slice(0, 3).map((m) => {
              const impact = parseInt(m.net_credit_amount, 10) - parseInt(m.net_debit_amount, 10);
              return {
                date: m.date,
                source_id: m.source_id,
                description: m.description,
                amount: (impact / 100).toFixed(2),
              };
            }),
          }),
        },
        null,
        2
      ),
      headers,
    };
  } catch (error) {
    console.error("[STATUS-REPORT] ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

export { handler };
