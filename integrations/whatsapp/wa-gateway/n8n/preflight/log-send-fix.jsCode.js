const r = $json; const e = (r.body && r.body.error) || {};
console.log(JSON.stringify({ evt: 'whatsapp_send', status: r.statusCode, error: e.code || null, subcode: e.error_subcode || null }));
if (!(r.statusCode >= 200 && r.statusCode < 300)) throw new Error('WhatsApp send failed: HTTP ' + r.statusCode + (e.code ? ' code ' + e.code : '')
  + (e.error_subcode ? ' subcode ' + e.error_subcode : '') + (e.type ? ' ' + String(e.type).replace(/[^A-Za-z]/g, '').slice(0, 40) : ''));
return { json: { status: r.statusCode } };