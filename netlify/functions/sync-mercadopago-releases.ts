import { Handler } from "@netlify/functions";

const handler: Handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    const syncToken = process.env.SYNC_MERCADOPAGO_TOKEN;
    const writeEnabled = process.env.MP_SYNC_WRITE_ENABLED === "true";

    if (!mpToken || !syncToken) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Missing MERCADOPAGO_ACCESS_TOKEN or SYNC_MERCADOPAGO_TOKEN",
        }),
        headers,
      };
    }

    console.log(`[RELEASES] Write mode: ${writeEnabled ? "ENABLED" : "DRY_RUN (MP_SYNC_WRITE_ENABLED not set)"}`);

    const now = new Date();
    const begin = new Date(now.getTime() - 72 * 60 * 60 * 1000);

    const beginISO = begin.toISOString().split("T")[0];
    const endISO = now.toISOString().split("T")[0];

    console.log(`[RELEASES] Creating Release Report: ${beginISO} to ${endISO}`);

    const createRes = await fetch(
      "https://api.mercadopago.com/v1/account/release_report",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mpToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          begin_date: `${beginISO}T00:00:00Z`,
          end_date: `${endISO}T23:59:59Z`,
        }),
      }
    );

    if (!createRes.ok) {
      const errorText = await createRes.text();
      console.error(`[RELEASES] Failed to create report: ${createRes.status} ${errorText}`);
      return {
        statusCode: createRes.status,
        body: JSON.stringify({ error: `Failed to create report: ${createRes.status}` }),
        headers,
      };
    }

    const createData = await createRes.json();
    const taskId = createData.id || createData.task_id;

    if (!taskId) {
      console.error(`[RELEASES] No task_id in response: ${JSON.stringify(createData)}`);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "No task_id returned from create report" }),
        headers,
      };
    }

    console.log(`[RELEASES] Report created with task_id: ${taskId}`);

    let taskStatus = null;
    let attempts = 0;
    const maxAttempts = 5;
    const delayMs = 2000;

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempts++;

      console.log(`[RELEASES] Polling task status (attempt ${attempts}/${maxAttempts})...`);

      const statusRes = await fetch(
        `https://api.mercadopago.com/v1/account/release_report/task/${taskId}`,
        {
          headers: { Authorization: `Bearer ${mpToken}` },
        }
      );

      if (!statusRes.ok) {
        console.warn(`[RELEASES] Task status check failed: ${statusRes.status}`);
        continue;
      }

      taskStatus = await statusRes.json();
      console.log(`[RELEASES] Task status: ${taskStatus.status}`);

      if (taskStatus.status === "processed" || taskStatus.status === "enabled") {
        console.log(`[RELEASES] Task completed!`);
        break;
      }
    }

    if (!taskStatus || (taskStatus.status !== "processed" && taskStatus.status !== "enabled")) {
      console.log(`[RELEASES] Task not yet processed (status: ${taskStatus?.status})`);
      console.log(`[RELEASES] Window is 72h with daily overlap, so movements will be captured in next execution`);
      console.log(`[RELEASES] Idempotence via payload_hash UNIQUE handles any overlapping rows`);
      return {
        statusCode: 202,
        body: JSON.stringify({
          success: true,
          action: "create_submitted",
          task_id: taskId,
          status: taskStatus?.status || "unknown",
          message: "Report creation submitted, will process on next daily execution (72h window with overlap)",
        }),
        headers,
      };
    }

    console.log(`[RELEASES] Calling status function to process report`);

    const statusFunctionUrl = process.env.STATUS_FUNCTION_URL || `https://${process.env.NETLIFY_SITE_NAME}.netlify.app/.netlify/functions/sync-mercadopago-releases-status`;

    const processingRes = await fetch(statusFunctionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task_id: taskId,
        commit: writeEnabled,
      }),
    });

    if (!processingRes.ok) {
      console.error(`[RELEASES] Status processing failed: ${processingRes.status}`);
      const errorBody = await processingRes.text();
      console.error(`[RELEASES] Error: ${errorBody}`);
      return {
        statusCode: processingRes.status,
        body: JSON.stringify({ error: `Status processing failed: ${processingRes.status}` }),
        headers,
      };
    }

    const processingData = await processingRes.json();
    console.log(`[RELEASES] Processing complete: ${JSON.stringify(processingData)}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        action: "sync_complete",
        task_id: taskId,
        processing: processingData,
      }),
      headers,
    };
  } catch (error) {
    console.error("[RELEASES] ERROR:", error);
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
