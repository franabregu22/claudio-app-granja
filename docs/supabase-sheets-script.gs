// Google Apps Script para conectar Supabase con Google Sheets (BIDIRECCIONAL)
// Reemplaza SUPABASE_URL y SUPABASE_KEY con tus valores

const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_KEY = 'your-anon-key';

// ============ CLIENTES ============

function SUPABASE_CLIENTES() {
  const response = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/clientes?select=*`, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    return `Error: ${data.message}`;
  }

  const result = [['ID', 'Nombre', 'Activo']];
  data.forEach(row => {
    result.push([
      row.id,
      row.nombre,
      row.activo ? 'Sí' : 'No'
    ]);
  });

  return result;
}

function guardarClientesASupabase() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    SpreadsheetApp.getUi().alert('No hay datos para guardar');
    return;
  }

  // Saltar encabezado (fila 1)
  for (let i = 1; i < data.length; i++) {
    const id = data[i][0];
    const nombre = data[i][1];
    const activo = data[i][2] === 'Sí' ? true : false;

    if (!id || !nombre) continue; // Saltar filas vacías

    const payload = {
      nombre: nombre,
      activo: activo
    };

    // Si tiene ID, es UPDATE. Si no, es INSERT.
    const method = id && id.toString().length > 10 ? 'PATCH' : 'POST';
    const url = id && id.toString().length > 10
      ? `${SUPABASE_URL}/rest/v1/clientes?id=eq.${id}`
      : `${SUPABASE_URL}/rest/v1/clientes`;

    UrlFetchApp.fetch(url, {
      method: method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  }

  SpreadsheetApp.getUi().alert('✅ Clientes guardados en Supabase');
}

// ============ PRECIOS ============

function SUPABASE_PRECIOS() {
  const response = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/precios_actuales?select=*&order=categoria`, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    return `Error: ${data.message}`;
  }

  const result = [['ID', 'Categoría', 'Precio']];
  data.forEach(row => {
    const label = {
      'xl': 'XL',
      'n1': 'N1 - Grande',
      'n2': 'N2 - Mediano',
      'n3': 'N3 - Chico',
      'docena': 'Docena'
    }[row.categoria] || row.categoria;

    result.push([row.id, label, row.precio]);
  });

  return result;
}

function guardarPreciosASupabase() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    SpreadsheetApp.getUi().alert('No hay datos para guardar');
    return;
  }

  const categoriaMap = {
    'XL': 'xl',
    'N1 - Grande': 'n1',
    'N2 - Mediano': 'n2',
    'N3 - Chico': 'n3',
    'Docena': 'docena'
  };

  for (let i = 1; i < data.length; i++) {
    const id = data[i][0];
    const categoria = data[i][1];
    const precio = data[i][2];

    if (!id || !categoria || !precio) continue;

    const payload = {
      precio: parseInt(precio)
    };

    UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/precios_actuales?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  }

  SpreadsheetApp.getUi().alert('✅ Precios guardados en Supabase');
}

// ============ PEDIDOS (Lectura) ============

function SUPABASE_PEDIDOS() {
  const response = UrlFetchApp.fetch(
    `${SUPABASE_URL}/rest/v1/pedidos?select=id,cliente_nombre,monto_total,estado,entregado_en&order=creado_en.desc&limit=50`,
    {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
      muteHttpExceptions: true
    }
  );

  const data = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    return `Error: ${data.message}`;
  }

  const result = [['ID', 'Cliente', 'Monto', 'Estado', 'Entregado']];
  data.forEach(row => {
    result.push([
      row.id,
      row.cliente_nombre,
      row.monto_total,
      row.estado,
      row.entregado_en ? row.entregado_en.split('T')[0] : ''
    ]);
  });

  return result;
}

// ============ PAGOS (Lectura) ============

function SUPABASE_PAGOS() {
  const response = UrlFetchApp.fetch(
    `${SUPABASE_URL}/rest/v1/pagos?select=*&order=fecha_pago.desc&limit=100`,
    {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
      muteHttpExceptions: true
    }
  );

  const data = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    return `Error: ${data.message}`;
  }

  const result = [['ID', 'Cliente', 'Monto', 'Método', 'Fecha']];
  data.forEach(row => {
    // Obtener nombre del cliente (necesitaría otro fetch, por ahora mostramos ID)
    result.push([
      row.id,
      row.cliente_id,
      row.monto,
      row.metodo_pago,
      row.fecha_pago
    ]);
  });

  return result;
}

// ============ UTILIDADES ============

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Supabase')
    .addSubMenu(ui.createMenu('📥 Cargar datos')
      .addItem('Clientes', 'refreshClientes')
      .addItem('Precios', 'refreshPrecios')
      .addItem('Pedidos', 'refreshPedidos')
      .addItem('Pagos', 'refreshPagos'))
    .addSubMenu(ui.createMenu('💾 Guardar cambios')
      .addItem('Guardar Clientes', 'guardarClientesASupabase')
      .addItem('Guardar Precios', 'guardarPreciosASupabase'))
    .addSeparator()
    .addItem('Configurar (README)', 'showSetup')
    .addToUi();
}

function showSetup() {
  const html = HtmlService.createHtmlOutput(`
    <style>
      body { font-family: Arial; padding: 20px; }
      h2 { color: #333; }
      code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; }
      .paso { margin: 15px 0; }
      strong { color: #2c3e50; }
    </style>
    <h2>🔗 Supabase ↔ Google Sheets (BIDIRECCIONAL)</h2>

    <div class="paso">
      <strong>✅ Está configurado correctamente si ves este menú.</strong>
    </div>

    <div class="paso">
      <strong>📥 CARGAR DATOS:</strong>
      <p>Menú Supabase → Cargar datos → Clientes/Precios/etc.</p>
      <p>Trae los datos de Supabase a tu Sheet</p>
    </div>

    <div class="paso">
      <strong>✏️ EDITAR EN SHEETS:</strong>
      <p>1. Carga los datos (ej: Clientes)</p>
      <p>2. Edita lo que quieras en las celdas</p>
      <p>3. Cambia nombres, precios, etc.</p>
    </div>

    <div class="paso">
      <strong>💾 GUARDAR CAMBIOS:</strong>
      <p>Menú Supabase → Guardar cambios → Clientes/Precios</p>
      <p>Envia todos tus cambios a Supabase automáticamente</p>
    </div>

    <div class="paso">
      <strong>⚠️ IMPORTANTE:</strong>
      <p>• Los datos leídos tienen una columna ID (no la elimines)</p>
      <p>• Edita: nombre, precio, estado</p>
      <p>• Agregar filas nuevas vacías = crear nuevos registros</p>
    </div>
  `);
  SpreadsheetApp.getUi().showModelessDialog(html, 'Configuración');
}

function refreshClientes() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = SUPABASE_CLIENTES();
  if (typeof data === 'string') {
    SpreadsheetApp.getUi().alert(data);
    return;
  }
  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}

function refreshPrecios() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = SUPABASE_PRECIOS();
  if (typeof data === 'string') {
    SpreadsheetApp.getUi().alert(data);
    return;
  }
  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}

function refreshPedidos() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = SUPABASE_PEDIDOS();
  if (typeof data === 'string') {
    SpreadsheetApp.getUi().alert(data);
    return;
  }
  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}

function refreshPagos() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = SUPABASE_PAGOS();
  if (typeof data === 'string') {
    SpreadsheetApp.getUi().alert(data);
    return;
  }
  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}
