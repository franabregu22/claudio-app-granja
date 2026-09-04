import { Handler } from "@netlify/functions";

const handler: Handler = async (event) => {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sincronizar Settlement - Granja Santo Tomás</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
    }

    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }

    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }

    .upload-area {
      border: 2px dashed #667eea;
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
      background: #f8f9ff;
      margin-bottom: 30px;
    }

    .upload-area:hover {
      background: #f0f2ff;
      border-color: #764ba2;
    }

    .upload-area.dragover {
      background: #e8ebff;
      border-color: #764ba2;
    }

    .upload-area input[type="file"] {
      display: none;
    }

    .upload-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }

    .upload-text {
      color: #333;
      font-weight: 500;
      margin-bottom: 5px;
    }

    .upload-hint {
      color: #999;
      font-size: 12px;
    }

    .files-list {
      margin-bottom: 30px;
    }

    .file-item {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .file-name {
      color: #333;
      font-weight: 500;
    }

    .file-size {
      color: #999;
      font-size: 12px;
      margin-top: 3px;
    }

    .remove-btn {
      background: #ff6b6b;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .remove-btn:hover {
      background: #ff5252;
    }

    .preview-section {
      background: #f9f9f9;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 30px;
      display: none;
    }

    .preview-section.show {
      display: block;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 15px;
      margin-bottom: 20px;
    }

    .stat-box {
      background: white;
      padding: 15px;
      border-radius: 6px;
      text-align: center;
    }

    .stat-label {
      color: #999;
      font-size: 12px;
      margin-bottom: 5px;
    }

    .stat-value {
      color: #333;
      font-size: 20px;
      font-weight: bold;
    }

    .stat-value.positive {
      color: #2ecc71;
    }

    .stat-value.negative {
      color: #e74c3c;
    }

    .movements-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
      font-size: 12px;
    }

    .movements-table th {
      background: #667eea;
      color: white;
      padding: 10px;
      text-align: left;
    }

    .movements-table td {
      padding: 8px 10px;
      border-bottom: 1px solid #eee;
    }

    .movements-table tbody tr:nth-child(odd) {
      background: #fafafa;
    }

    .action-buttons {
      display: flex;
      gap: 10px;
      margin-top: 30px;
    }

    .btn {
      flex: 1;
      padding: 12px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }

    .btn-primary {
      background: #667eea;
      color: white;
    }

    .btn-primary:hover {
      background: #5568d3;
    }

    .btn-primary:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: #e0e0e0;
      color: #333;
    }

    .btn-secondary:hover {
      background: #d0d0d0;
    }

    .message {
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 20px;
      display: none;
    }

    .message.show {
      display: block;
    }

    .message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }

    .message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }

    .message.loading {
      background: #d1ecf1;
      color: #0c5460;
      border: 1px solid #bee5eb;
    }

    .info-box {
      background: #e3f2fd;
      border-left: 4px solid #667eea;
      padding: 15px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #1565c0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Sincronizar Settlement Histórico</h1>
    <p class="subtitle">
      Cargá los CSV descargados de MercadoPago. Te mostraré preview antes de sincronizar.
    </p>

    <div class="info-box">
      <strong>ℹ️ Cómo descargar:</strong> MercadoPago → Reportes → Todas las transacciones → Descargá como CSV (90 días cada uno si es necesario)
    </div>

    <div class="message" id="message"></div>

    <div class="upload-area" id="uploadArea">
      <div class="upload-icon">📁</div>
      <div class="upload-text">Pegá o subí los CSV aquí</div>
      <div class="upload-hint">O hacé click para seleccionar archivos</div>
      <input type="file" id="fileInput" multiple accept=".csv" />
    </div>

    <div class="files-list" id="filesList"></div>

    <div class="preview-section" id="previewSection">
      <h3 style="margin-bottom: 15px; color: #333">📈 Preview de los datos</h3>

      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Total Líneas</div>
          <div class="stat-value" id="totalLines">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Tipos de Movimientos</div>
          <div class="stat-value" id="typeCount">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Diferencia vs Target</div>
          <div class="stat-value" id="difference">0</div>
        </div>
      </div>

      <table class="movements-table">
        <thead>
          <tr>
            <th>Tipo de Movimiento</th>
            <th style="text-align: right">Cantidad</th>
          </tr>
        </thead>
        <tbody id="movementsTable"></tbody>
      </table>

      <div style="margin-top: 15px; padding: 15px; background: white; border-radius: 6px">
        <strong>Total Estimado:</strong>
        <div style="font-size: 24px; font-weight: bold; color: #667eea; margin-top: 5px">
          <span id="totalArs">ARS 0,00</span>
        </div>
        <div style="font-size: 12px; color: #999; margin-top: 5px">
          Target: ARS 172.814,62
        </div>
      </div>
    </div>

    <div class="action-buttons">
      <button class="btn btn-secondary" id="clearBtn" style="display: none">Limpiar</button>
      <button class="btn btn-primary" id="syncBtn" disabled>Sincronizar Datos</button>
    </div>
  </div>

  <script>
    let uploadedFiles = [];

    const uploadArea = document.getElementById("uploadArea");
    const fileInput = document.getElementById("fileInput");
    const filesList = document.getElementById("filesList");
    const previewSection = document.getElementById("previewSection");
    const syncBtn = document.getElementById("syncBtn");
    const clearBtn = document.getElementById("clearBtn");
    const messageDiv = document.getElementById("message");

    uploadArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      uploadArea.classList.add("dragover");
    });

    uploadArea.addEventListener("dragleave", () => {
      uploadArea.classList.remove("dragover");
    });

    uploadArea.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadArea.classList.remove("dragover");
      handleFiles(e.dataTransfer.files);
    });

    uploadArea.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", (e) => {
      handleFiles(e.target.files);
    });

    function handleFiles(files) {
      for (const file of files) {
        if (file.type === "text/plain" || file.name.endsWith(".csv")) {
          const reader = new FileReader();
          reader.onload = (e) => {
            uploadedFiles.push({
              name: file.name,
              size: file.size,
              content: e.target.result,
            });
            updateFilesList();
            generatePreview();
          };
          reader.readAsText(file);
        }
      }
    }

    function updateFilesList() {
      filesList.innerHTML = uploadedFiles
        .map(
          (file, idx) => \`
        <div class="file-item">
          <div>
            <div class="file-name">✓ \${file.name}</div>
            <div class="file-size">\${(file.size / 1024).toFixed(1)} KB</div>
          </div>
          <button class="remove-btn" onclick="removeFile(\${idx})">Eliminar</button>
        </div>
      \`
        )
        .join("");

      syncBtn.disabled = uploadedFiles.length === 0;
      clearBtn.style.display = uploadedFiles.length > 0 ? "block" : "none";
    }

    function removeFile(idx) {
      uploadedFiles.splice(idx, 1);
      updateFilesList();
      generatePreview();
    }

    function generatePreview() {
      if (uploadedFiles.length === 0) {
        previewSection.classList.remove("show");
        return;
      }

      const allLines = [];
      const typeCount = {};
      let totalCredit = 0;
      let totalDebit = 0;

      uploadedFiles.forEach((file) => {
        const lines = file.content.split("\\n").filter((l) => l.trim());
        allLines.push(...lines);

        const headers = lines[0].split(",").map((h) => h.trim());

        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(",");
          const record = {};
          headers.forEach((h, idx) => {
            record[h] = parts[idx]?.trim() || null;
          });

          const movementType = record["Tipo"] || record["movement_type"] || "UNKNOWN";
          typeCount[movementType] = (typeCount[movementType] || 0) + 1;

          const creditStr = record["Crédito Neto"] || record["net_credit_amount"] || "0";
          const debitStr = record["Débito Neto"] || record["net_debit_amount"] || "0";

          if (creditStr && creditStr !== "0") totalCredit += parseFloat(creditStr) || 0;
          if (debitStr && debitStr !== "0") totalDebit += parseFloat(debitStr) || 0;
        }
      });

      const netTotal = totalCredit - totalDebit;
      const target = 172814.62;
      const difference = netTotal - target;

      document.getElementById("totalLines").textContent = allLines.length;
      document.getElementById("typeCount").textContent = Object.keys(typeCount).length;
      document.getElementById("totalArs").textContent = \`ARS \${netTotal.toLocaleString("es-AR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}\`;
      document.getElementById("difference").textContent = \`\${difference > 0 ? "+" : ""}ARS \${difference.toLocaleString("es-AR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}\`;
      document.getElementById("difference").className = \`stat-value \${difference >= 0 ? "positive" : "negative"}\`;

      const tbody = document.getElementById("movementsTable");
      tbody.innerHTML = Object.entries(typeCount)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => \`<tr><td>\${type}</td><td style="text-align: right">\${count}</td></tr>\`)
        .join("");

      previewSection.classList.add("show");
    }

    function showMessage(text, type) {
      messageDiv.textContent = text;
      messageDiv.className = \`message show \${type}\`;
      setTimeout(() => {
        if (type !== "loading") {
          messageDiv.classList.remove("show");
        }
      }, type === "loading" ? 999999 : 5000);
    }

    syncBtn.addEventListener("click", async () => {
      if (uploadedFiles.length === 0) return;

      showMessage(\`\${uploadedFiles.length} archivo(s) siendo procesado...\`, "loading");
      syncBtn.disabled = true;

      try {
        for (const file of uploadedFiles) {
          const response = await fetch(
            "https://santotomasapp.netlify.app/.netlify/functions/sync-settlement-csv",
            {
              method: "POST",
              headers: { "Content-Type": "text/plain" },
              body: file.content,
            }
          );

          const result = await response.json();

          if (!response.ok) {
            showMessage(\`Error en \${file.name}: \${result.error}\`, "error");
            syncBtn.disabled = false;
            return;
          }
        }

        showMessage(
          \`✓ Éxito! \${uploadedFiles.length} archivo(s) sincronizado(s). Datos en Supabase.\`,
          "success"
        );
        uploadedFiles = [];
        updateFilesList();
        previewSection.classList.remove("show");
      } catch (error) {
        showMessage(\`Error: \${error.message}\`, "error");
        syncBtn.disabled = false;
      }
    });

    clearBtn.addEventListener("click", () => {
      uploadedFiles = [];
      updateFilesList();
      previewSection.classList.remove("show");
    });
  </script>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
};

export { handler };
