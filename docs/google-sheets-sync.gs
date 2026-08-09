const SUPABASE_URL = 'TU_SUPABASE_URL_AQUI';
const SUPABASE_ANON_KEY = 'TU_SUPABASE_ANON_KEY_AQUI';

function sincronizarDatos() {
  sincronizarClientes();
  sincronizarPrecios();
  sincronizarPedidos();
  sincronizarPagos();
  sincronizarHistorialPrecios();
}

function sincronizarClientes() {
  const sheet = getOrCreateSheet('Clientes');
  sheet.clear();

  const clientes = llamarSupabase('clientes');

  if (clientes.length === 0) return;

  const headers = ['ID', 'Nombre', 'Categoría', 'Notas', 'Activo', 'Creado'];
  sheet.appendRow(headers);

  clientes.forEach(c => {
    sheet.appendRow([
      c.id,
      c.nombre,
      c.categoria,
      c.notas || '',
      c.activo ? 'Sí' : 'No',
      c.created_at
    ]);
  });
}

function sincronizarPrecios() {
  const sheet = getOrCreateSheet('Precios');
  sheet.clear();

  const precios = llamarSupabase('precios_actuales');

  if (precios.length === 0) return;

  const headers = ['ID', 'Categoría', 'Tipo Cliente', 'Precio', 'Vigente Desde'];
  sheet.appendRow(headers);

  precios.forEach(p => {
    sheet.appendRow([
      p.id,
      p.categoria,
      p.tipo_cliente,
      p.precio,
      p.vigente_desde
    ]);
  });
}

function sincronizarPedidos() {
  const sheet = getOrCreateSheet('Pedidos');
  sheet.clear();

  const pedidos = llamarSupabase('pedidos');

  if (pedidos.length === 0) return;

  const headers = ['ID', 'Cliente', 'Estado', 'Monto Total', 'Entregado En', 'Creado'];
  sheet.appendRow(headers);

  pedidos.forEach(p => {
    sheet.appendRow([
      p.id,
      p.cliente_nombre,
      p.estado,
      p.monto_total,
      p.entregado_en || '',
      p.creado_en
    ]);
  });
}

function sincronizarPagos() {
  const sheet = getOrCreateSheet('Pagos');
  sheet.clear();

  const pagos = llamarSupabase('pagos', 'order=fecha_pago.desc');

  if (pagos.length === 0) return;

  // Obtener nombres de clientes
  const clientes = llamarSupabase('clientes');
  const clientesMap = {};
  clientes.forEach(c => {
    clientesMap[c.id] = c.nombre;
  });

  const headers = ['Cliente ID', 'Cliente Nombre', 'Monto', 'Método Pago', 'Fecha Pago', 'Notas'];
  sheet.appendRow(headers);

  pagos.forEach(p => {
    sheet.appendRow([
      p.cliente_id,
      clientesMap[p.cliente_id] || 'Desconocido',
      p.monto,
      p.metodo_pago,
      p.fecha_pago,
      p.notas || ''
    ]);
  });
}

function sincronizarHistorialPrecios() {
  const sheet = getOrCreateSheet('Historial Precios');
  sheet.clear();

  const historial = llamarSupabase('precios_historial', 'order=actualizado_en.desc');

  if (historial.length === 0) return;

  const headers = ['Categoría', 'Tipo Cliente', 'Precio Anterior', 'Precio Nuevo', 'Vigente Desde', 'Actualizado En'];
  sheet.appendRow(headers);

  historial.forEach(h => {
    sheet.appendRow([
      h.categoria,
      h.tipo_cliente,
      h.precio_anterior,
      h.precio_nuevo,
      h.vigente_desde,
      h.actualizado_en
    ]);
  });
}

function llamarSupabase(tabla, queryParams = '') {
  let url = `${SUPABASE_URL}/rest/v1/${tabla}?select=*`;
  if (queryParams) {
    url += `&${queryParams}`;
  }

  const options = {
    method: 'get',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());

  if (response.getResponseCode() !== 200) {
    Logger.log('Error: ' + response.getContentText());
    return [];
  }

  return result;
}

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  return sheet;
}
