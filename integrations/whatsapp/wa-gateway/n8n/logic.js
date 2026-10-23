// ADR-025 §18 — n8n STAGING logic (pure; embedded verbatim into the workflow's Code nodes by build-workflow.mjs and
// unit-tested by logic.test.mjs). Text only in this stage: photos, PDF and audio get a "solo texto" reply.
const WA = (() => {
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const WINDOW_S = 300;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  function sha256Hex(str) {
    const K = [], H = [], isP = (n) => { for (let f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
    for (let n = 2, c = 0; c < 64; n++) if (isP(n)) { if (c < 8) H[c] = (Math.pow(n, 1 / 2) * 2 ** 32) | 0; K[c++] = (Math.pow(n, 1 / 3) * 2 ** 32) | 0; }
    const b = Array.from(unescape(encodeURIComponent(str)), (ch) => ch.charCodeAt(0)); const l = b.length * 8;
    b.push(0x80); while (b.length % 64 !== 56) b.push(0);
    for (let i = 7; i >= 0; i--) b.push(i > 3 ? 0 : (l >>> (i * 8)) & 0xff);
    const r = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < b.length; o += 64) {
      const w = []; for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) { const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) { const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0; }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  const nonce = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

  /** Edge → n8n (token already checked by the Webhook Header Auth credential): body {ts, nonce, event}; fresh ts, single-use
   *  nonce (seen = { nonce: expiresAtS }, kept in workflow static data), well-formed event carrying its Edge capability */
  function verify(body, nowS, seen) {
    if (!body || !/^[0-9]{10}$/.test(String(body.ts)) || !/^[0-9a-f]{16,64}$/.test(String(body.nonce)) || !body.event || typeof body.event !== 'object') return { ok: false, reason: 'format' };
    if (Math.abs(nowS - Number(body.ts)) > WINDOW_S) return { ok: false, reason: 'stale' };
    for (const k of Object.keys(seen)) if (seen[k] < nowS) delete seen[k];
    if (seen[body.nonce]) return { ok: false, reason: 'nonce_replay' };
    seen[body.nonce] = nowS + 2 * WINDOW_S;
    const event = body.event;
    if (event.type !== 'wa.message' || !Number.isSafeInteger(event.inbound_id) || !/^\+[0-9]{8,15}$/.test(String(event.phone))
        || !/^v1\.[0-9]{1,18}\.[0-9]{10}\.[0-9a-f]{64}$/.test(String(event.cap))) return { ok: false, reason: 'event' };
    return { ok: true, event };
  }

  /** today in Argentina (UTC-3, no DST) as YYYY-MM-DD */
  const today = (nowMs) => new Date(nowMs - 3 * 3600 * 1000).toISOString().slice(0, 10);

  /** Graph API recipient: Meta test recipients registered as 54XX… need the mobile 9 removed (cfg.ar_strip_9) */
  const toNumber = (phone, cfg) => { const d = String(phone).replace('+', ''); return cfg && cfg.ar_strip_9 && /^549[0-9]{10}$/.test(d) ? '54' + d.slice(3) : d; };

  /** first decision for one message (no draft state here): buttons carry their own draft id + version; any text first asks
   *  the database for the sender's context (public.wa_context) — the interpreter / commands decide afterwards */
  function route(event, cfg) {
    const ctx = { to: toNumber(event.phone, cfg), inbound_id: event.inbound_id };
    const b = String(event.button_payload || '');
    const bm = b.match(new RegExp(`^(CONFIRM|CANCEL):(${UUID}):([0-9]{1,5})$`));
    if (bm) return { ...ctx, request: { action: bm[1] === 'CONFIRM' ? 'confirm' : 'cancel', inbound_id: event.inbound_id, cap: event.cap, draft_id: bm[2], expected_version: Number(bm[3]) } };
    if (b) return { ...ctx, reply: 'Ese botón no es válido.' };
    if (event.kind !== 'text') return { ...ctx, reply: 'Por ahora solo proceso mensajes de texto.' };
    if (!String(event.text || '').trim()) return { ...ctx, reply: 'Mandame el gasto en una línea, por ejemplo: "gasté 18 mil de combustible en efectivo".' };
    return { ...ctx, text: String(event.text).slice(0, 1000), request: { action: 'context', inbound_id: event.inbound_id, cap: event.cap } };
  }

  /** n8n → Edge request: raw JSON body + ts / nonce headers (the x-wa-token header comes from the HTTP node credential) */
  function prepare(request, nowS, nonce) {
    return { raw: JSON.stringify(request), headers: { 'content-type': 'application/json', 'x-wa-timestamp': String(nowS), 'x-wa-nonce': nonce } };
  }

  const money = (v) => { const [i, d] = Number(v).toFixed(2).split('.'); return '$ ' + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d; };
  const ddmmyyyy = (iso) => String(iso || '').split('-').reverse().join('/');
  const METHOD = { CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'Mercado Pago' };
  const ERR = {
    WA_OPEN_DRAFT_EXISTS: 'Ya tenés un borrador abierto. Confirmalo, mandá la corrección o escribí "cancelar".',
    WA_VERSION_CHANGED: 'Ese botón es de una versión anterior. Usá el del último resumen.',
    WA_CONFIRMATION_NOT_EXPLICIT: 'Ese botón es de una versión anterior. Usá el del último resumen.',
    WA_NOT_DRAFT_OWNER: 'Ese borrador no es tuyo.',
    WA_DRAFT_EXPIRED: 'El borrador venció. Mandá el gasto de nuevo.',
    WA_WAITING_MP: 'Falta vincular el pago de Mercado Pago: respondé "mp <número de operación>".',
    WA_WAITING_MP_LIMIT: 'Tenés demasiados gastos esperando a Mercado Pago.',
    WA_MP_OUTFLOW_NOT_MATCHING: 'No encontré un egreso de Mercado Pago pendiente con ese número, monto y fecha.',
    WA_MP_OUTFLOW_TAKEN: 'Ese movimiento de Mercado Pago ya está vinculado a otro borrador.',
    WA_DRAFT_NOT_CONFIRMABLE: 'Ese borrador ya no se puede confirmar.',
    WA_DRAFT_NOT_CANCELLABLE: 'Ese borrador ya no se puede cancelar.',
    WA_DRAFT_NOT_EDITABLE: 'Ese borrador ya no se puede corregir.',
    WA_INVALID_PAYLOAD: 'No pude armar el gasto con esos datos.',
    WA_OWNER_NOT_AUTHORIZED: 'Tu número ya no está autorizado.',
  };
  const text = (to, body) => ({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: body.slice(0, 4000) } });
  const buttons = (to, body, id, v) => ({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: body.slice(0, 1000) },
    action: { buttons: [{ type: 'reply', reply: { id: `CONFIRM:${id}:${v}`, title: 'Confirmar' } }, { type: 'reply', reply: { id: `CANCEL:${id}:${v}`, title: 'Cancelar' } }] } } });
  // corrected fields (from the interpreter: { field: total|concept|category_id|method|date, from, to }) → labelled, formatted values
  const FIELD = { total: 'Importe', concept: 'Concepto', category_id: 'Categoría', method: 'Pago', date: 'Fecha' };
  const fmtField = (f, v, cfg) => f === 'total' ? money(v) : f === 'date' ? ddmmyyyy(v) : f === 'method' ? (METHOD[v] || v)
    : f === 'category_id' ? (((cfg.categories || []).find((c) => c.id === v) || {}).nombre || '?') : `"${String(v ?? '').slice(0, 60)}"`;
  const changeLine = (r, changes, cfg) => {
    const ch = (changes || []).filter((c) => c && FIELD[c.field]);
    return ch.length ? `✏️ Corregí ${r.short_code} (v${r.version}): ${ch.map((c) => `${FIELD[c.field]} ${fmtField(c.field, c.from, cfg)} → ${fmtField(c.field, c.to, cfg)}`).join('; ')}\n\n` : '';
  };
  // the recorded purchases behind the duplicate hint (database: same total, date ±2 days; details only for an ADMIN viewer)
  const dupLines = (r) => {
    if (!Array.isArray(r.duplicates)) return r.possible_duplicates > 0 ? `\n⚠ Hay ${r.possible_duplicates} gasto(s) parecido(s) cerca de esa fecha.` : '';
    const ref = (x) => [x.ref, x.concept, money(x.total), ddmmyyyy(x.date).slice(0, 5)].filter(Boolean).join(' · ') + (x.category ? ` (${x.category})` : '');
    const same = r.duplicates.filter((x) => x.same_category), other = r.duplicates.filter((x) => !x.same_category);
    return (same.length ? `\n⚠ Posible duplicado: ${same.map(ref).join('; ')}` : '')
      + (other.length ? `\nℹ Mismo importe y fecha cercana: ${other.map(ref).join('; ')}. Si es otro gasto, confirmá igual.` : '')
      + (r.possible_duplicates > r.duplicates.length ? ` (+${r.possible_duplicates - r.duplicates.length} más)` : '');
  };
  const summary = (r, cfg, changes) => {
    const p = r.payload || {};
    const mark = (f) => ((changes || []).some((c) => c && c.field === f) ? ' ✏️' : '');
    const cat = (cfg.categories || []).find((c) => c.id === p.category_id);
    const acc = Object.values(cfg.accounts || {}).find((a) => a && a.id === p.account_id);
    return changeLine(r, changes, cfg)
      + `Borrador ${r.short_code} (v${r.version}) — STAGING, simulación\nTotal: ${money(p.total)}${mark('total')}\nConcepto: ${p.concept}${mark('concept')}\n`
      + `Categoría: ${cat ? cat.nombre : '?'}${mark('category_id')}\nPago: ${METHOD[p.method] || p.method}${acc ? ' (' + acc.nombre + ')' : ''}${mark('method')}\n`
      + `Fecha: ${ddmmyyyy(p.date)}${mark('date')}` + dupLines(r);
  };
  const ASK = '¿Confirmás? Si algo está mal decime solo lo que cambia (por ejemplo "eran 15 mil" o "era transferencia"). "cancelar" lo descarta.';
  const drop = (st, id) => ({ open: st.open && st.open.draft_id === id ? null : st.open, waiting: st.waiting.filter((w) => w.draft_id !== id) });

  /** Edge response → WhatsApp message (Graph API body or null) + the sender's new state */
  function compose(ctx, status, body, st, cfg) {
    st = st || { open: null, waiting: [] };
    const req = ctx.request || {};
    if (req.action === 'expire') return { graph: null, state: st };
    if (status === 422 && body && body.error) {
      const code = body.error.code;
      if (code === 'WA_MESSAGE_ALREADY_USED') return { graph: null, state: st };
      const next = code === 'WA_DRAFT_NOT_CONFIRMABLE' || code === 'WA_DRAFT_NOT_CANCELLABLE' || code === 'WA_DRAFT_NOT_EDITABLE' ? drop(st, req.draft_id) : st;
      return { graph: text(ctx.to, ERR[code] || `No pude procesar el pedido (${code}).`), state: next };
    }
    if (status !== 200 || !body || !body.result) return { graph: text(ctx.to, 'Hubo un problema técnico; probá de nuevo en unos minutos.'), state: st };
    const r = body.result;
    if (r.ok === false) {
      if (r.error === 'WA_DRAFT_EXPIRED') return { graph: text(ctx.to, ERR.WA_DRAFT_EXPIRED), state: drop(st, req.draft_id) };
      const open = st.open && st.open.draft_id === r.draft_id ? { ...st.open, state: 'FAILED' } : { draft_id: r.draft_id, version: req.expected_version, state: 'FAILED', code: r.short_code };
      return { graph: text(ctx.to, `No se pudo registrar ${r.short_code || ''}: ${String(r.error || '').slice(0, 120)}.\nDecime qué corregir o escribí "cancelar".`), state: { ...st, open } };
    }
    if (r.already_confirmed) return { graph: text(ctx.to, `${r.short_code} ya estaba registrado.`), state: drop(st, r.draft_id) };
    if (r.state === 'CONFIRMED') return { graph: text(ctx.to, `✅ Registrado ${r.short_code} (simulación STAGING; no afecta la contabilidad real).`), state: drop(st, r.draft_id) };
    if (r.state === 'CANCELLED') return { graph: text(ctx.to, `Cancelado ${r.short_code}.`), state: drop(st, r.draft_id) };
    if (r.state === 'WAITING_MP') {
      const w = { draft_id: r.draft_id, version: r.version, state: 'WAITING_MP', code: r.short_code };
      return { graph: text(ctx.to, summary(r, cfg, ctx.changes) + `\n\nPagado con Mercado Pago: cuando aparezca el movimiento respondé "mp <número de operación>" (vence en 72 h).`),
               state: { open: st.open, waiting: [...st.waiting.filter((x) => x.draft_id !== r.draft_id), w] } };
    }
    if (r.state === 'DRAFT') {
      const s = drop(st, r.draft_id);
      return { graph: buttons(ctx.to, summary(r, cfg, ctx.changes) + '\n\n' + ASK, r.draft_id, r.version),
               state: { open: { draft_id: r.draft_id, version: r.version, state: 'DRAFT', code: r.short_code }, waiting: s.waiting } };
    }
    return { graph: null, state: st };
  }

  return { sha256Hex, nonce, toNumber, verify, today, route, prepare, compose };
})();
