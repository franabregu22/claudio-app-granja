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
    // CONFIRM / UNCLASSIFIED ("Confirmar sin clasificar") both go to wa_confirm, which reads the button from the stored message
    const bm = b.match(new RegExp(`^(CONFIRM|UNCLASSIFIED|CANCEL):(${UUID}):([0-9]{1,5})$`));
    if (bm) return { ...ctx, request: { action: bm[1] === 'CANCEL' ? 'cancel' : 'confirm', inbound_id: event.inbound_id, cap: event.cap, draft_id: bm[2], expected_version: Number(bm[3]) } };
    // METHOD:<draft>:<version>:<method> ("¿Cómo lo pagaste?"): read the context first; the correction is built from the database draft
    const pm = b.match(new RegExp(`^METHOD:(${UUID}):([0-9]{1,5}):(CASH|TRANSFER|MERCADOPAGO)$`));
    if (pm) return { ...ctx, text: '', pick: { draft_id: pm[1], version: Number(pm[2]), method: pm[3] }, request: { action: 'context', inbound_id: event.inbound_id, cap: event.cap } };
    // MPLINK:<draft>:<version>:<SOURCE_ID> — one of the pending Mercado Pago outflows offered for a waiting draft (wa_link_mp re-checks it)
    const lm = b.match(new RegExp(`^MPLINK:(${UUID}):([0-9]{1,5}):([0-9]{6,20})$`));
    if (lm) return { ...ctx, request: { action: 'link_mp', inbound_id: event.inbound_id, cap: event.cap, draft_id: lm[1], expected_version: Number(lm[2]), source_id: lm[3] } };
    if (b) return { ...ctx, reply: 'Ese botón no es válido.' };
    // a photo / PDF: the Edge already stored the original (document) — read the context, then the receipt reader decides
    if ((event.kind === 'image' || event.kind === 'document') && event.media_error) return { ...ctx, reply: MEDIA_ERR[event.media_error] || MEDIA_ERR.default };
    if ((event.kind === 'image' || event.kind === 'document') && event.document && event.document.id && event.document.signed_url) {
      return { ...ctx, text: String(event.caption || '').slice(0, 500), media: { id: event.document.id, mime: event.document.mime, signed_url: event.document.signed_url,
        duplicate: !!event.document.duplicate, links: Number(event.document.links || 0), draft_short_code: event.document.draft_short_code || null },
        request: { action: 'context', inbound_id: event.inbound_id, cap: event.cap } };
    }
    if (event.kind !== 'text') return { ...ctx, reply: 'Por ahora solo proceso mensajes de texto.' };
    if (!String(event.text || '').trim()) return { ...ctx, reply: 'Mandame el gasto en una línea, por ejemplo: "gasté 18 mil de combustible en efectivo".' };
    return { ...ctx, text: String(event.text).slice(0, 1000), request: { action: 'context', inbound_id: event.inbound_id, cap: event.cap } };
  }

  const MEDIA_ERR = {
    unsupported_type: 'Ese tipo de archivo no lo proceso: mandá una foto (JPG / PNG) o un PDF del comprobante.',
    too_large: 'El archivo supera los 10 MB. Mandá una foto o un PDF más liviano.',
    default: 'No pude recibir el archivo. Reenvialo en un rato o escribime el gasto.',
  };
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
    WA_CATEGORY_REQUIRED: 'Primero decime el tipo de gasto (la subcategoría).',
    WA_ACCOUNT_REQUIRED: 'Primero decime desde qué cuenta lo pagaste.',
    WA_ACCOUNT_NOT_SELECTABLE: 'Esa cuenta no está habilitada en el ERP para ese medio de pago. Decime desde qué cuenta lo pagaste.',
    WA_CATEGORY_NOT_SELECTABLE: 'Esa subcategoría ya no está disponible en el ERP. Decime cuál usar (el resto del gasto se mantiene).',
    WA_OWNER_NOT_AUTHORIZED: 'Tu número ya no está autorizado.',
    WA_UNCLASSIFIED_NOT_ALLOWED: 'Ese borrador ya tiene subcategoría: usá el botón Confirmar del último resumen.',
    WA_METHOD_REQUIRED: 'Primero decime cómo lo pagaste: efectivo, transferencia o Mercado Pago.',
    WA_BUTTON_MISMATCH: 'Ese botón ya no corresponde. Usá el del último resumen.',
    WA_CONCEPT_REQUIRED: '¿Con qué concepto querés registrar este gasto?',
    WA_DOCUMENT_ALREADY_USED: 'Ese comprobante ya está en otro borrador o ya fue registrado.',
    WA_DOCUMENT_NOT_OWNED: 'Ese comprobante lo mandó otra persona: no lo puedo registrar desde tu número.',
  };
  const text = (to, body) => ({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: body.slice(0, 4000) } });
  // reply buttons (Meta: at most 3, title at most 20 characters). Owner decision: "Registrar sin clasif." — 21 characters with the
  // final period, so it is shown without it: "Registrar sin clasif" (20). The button id stays UNCLASSIFIED:<draft>:<version>.
  const UNCLASSIFIED_TITLE = 'Registrar sin clasif';
  const buttons = (to, body, id, v, first = 'CONFIRM') => ({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: body.slice(0, 1000) },
    action: { buttons: [{ type: 'reply', reply: { id: `${first}:${id}:${v}`, title: first === 'UNCLASSIFIED' ? UNCLASSIFIED_TITLE : 'Confirmar' } },
                        { type: 'reply', reply: { id: `CANCEL:${id}:${v}`, title: 'Cancelar' } }] } } });
  // "¿Cómo lo pagaste?": one button per payment method; the id names the draft, the version and the method (the database refuses any
  // other use). Meta allows 3 reply buttons, so there is no Cancelar button on this message: "cancelar" by text is always available
  const mpButtons = (to, body, id, v, cands) => ({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: body.slice(0, 1000) },
    action: { buttons: cands.map((c) => ({ type: 'reply', reply: { id: `MPLINK:${id}:${v}:${c.source_id}`, title: `Op …${String(c.source_id).slice(-6)}` } })) } } });
  const METHOD_BUTTONS = [['CASH', 'Efectivo'], ['TRANSFER', 'Transferencia'], ['MERCADOPAGO', 'Mercado Pago']];
  const methodButtons = (to, body, id, v) => ({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: body.slice(0, 1000) },
    action: { buttons: METHOD_BUTTONS.map(([m, title]) => ({ type: 'reply', reply: { id: `METHOD:${id}:${v}:${m}`, title } })) } } });
  // corrected fields (from the interpreter: { field: total|concept|category_id|method|date, from, to }) → labelled, formatted values
  const catLabel = (cfg, id) => { if (!id) return '(sin elegir)'; const c = (cfg.categories || []).find((x) => x.id === id);
    return c ? (c.grupo ? `${c.grupo} › ${c.nombre}` : c.nombre) : '(ya no disponible)'; };
  // the data still to choose on a draft (subcategory / paying account) and the question for each — no confirm button meanwhile
  const pendingQuestions = (p, cfg) => {
    const q = [];
    if (p.concept_pending) q.push('¿Con qué concepto querés registrar este gasto?');
    if (p.category_pending) {
      const offered = (p.category_options || []).map((id) => (cfg.categories || []).find((c) => c.id === id)).filter(Boolean);
      const groups = [...new Set((cfg.categories || []).map((c) => c.grupo).filter(Boolean))];
      q.push(offered.length ? `¿Qué tipo de ${offered[0].grupo || 'gasto'}? ${offered.map((c) => c.nombre).join(' o ')}.`
        : `¿En qué categoría va?${groups.length ? ' Por ejemplo: ' + groups.slice(0, 12).join(', ') + '.' : ''} Decime el tipo.`);
    }
    if (p.method_pending) q.push('¿Cómo lo pagaste? Efectivo, transferencia o Mercado Pago.');
    else if (p.account_pending) q.push(`¿Desde qué cuenta lo pagaste? ${accList(cfg).filter((a) => a.method === p.method).map((a) => a.nombre).join(' o ')}.`);
    return q;
  };
  // paying accounts come live from the ERP (context); the method of each comes from the database (older contexts: from its type)
  const TYPE_METHOD = { CASH: 'CASH', BANK_ACCOUNT: 'TRANSFER', EXTERNAL_SERVICE: 'MERCADOPAGO' };
  const accList = (cfg) => Object.values(cfg.accounts || {}).filter(Boolean).map((a) => ({ ...a, method: a.method || TYPE_METHOD[a.account_type] }));
  const accName = (cfg, id) => (id ? ((accList(cfg).find((a) => a.id === id) || {}).nombre || '(ya no habilitada)') : '(sin elegir)');
  const FIELD = { total: 'Importe', concept: 'Concepto', category_id: 'Categoría', method: 'Pago', account_id: 'Cuenta', date: 'Fecha' };
  const fmtField = (f, v, cfg) => f === 'total' ? money(v) : f === 'date' ? ddmmyyyy(v) : f === 'method' ? (v === 'PENDING' ? 'A pagar' : v ? METHOD[v] || v : '(a elegir)')
    : f === 'category_id' ? catLabel(cfg, v) : f === 'account_id' ? accName(cfg, v) : `"${String(v ?? '').slice(0, 60)}"`;
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
    const acc = p.account_id ? ' (' + accName(cfg, p.account_id) + ')' : (p.account_pending ? ' (cuenta a elegir)' : '');
    return changeLine(r, changes, cfg)
      + `Borrador ${r.short_code} (v${r.version}) — STAGING, simulación\nTotal: ${money(p.total)}${mark('total')}\nConcepto: ${p.concept_pending ? '(a definir)' : p.concept}${mark('concept')}\n`
      + `Categoría: ${catLabel(cfg, p.category_id)}${mark('category_id')}\nPago: ${p.pending_payment ? 'A PAGAR — no mueve Caja ni Bancos' + (p.due_date ? ' · vence ' + ddmmyyyy(p.due_date) : '') : p.method ? (METHOD[p.method] || p.method) + acc : '(a elegir)'}${mark('method') || mark('account_id')}\n`
      + `Fecha: ${ddmmyyyy(p.date)}${mark('date')}` + receiptLine(p) + dupLines(r);
  };
  // the receipt read (receipt.js, when embedded) and the "solo IVA" variant (no category / payment: only Fiscal)
  const receiptLine = (p) => (typeof WAR !== 'undefined' && p.receipt ? WAR.line(p) : '');
  const vatSummary = (r) => { const p = r.payload || {};
    return `Borrador ${r.short_code} (v${r.version}) — SOLO CRÉDITO FISCAL\nTotal del comprobante: ${money(p.total)}\nFecha: ${ddmmyyyy(p.date)}` + receiptLine(p)
      + '\nSe registra solo en Fiscal: sin gasto y sin movimiento de dinero.'; };
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
      // the subcategory was deactivated / moved after the proposal: refused inside the confirmation, nothing recorded
      const e = String(r.error || '');
      const body = /^WA_CATEGORY_NOT_SELECTABLE/.test(e)
        ? `No se registró ${r.short_code || ''}: la subcategoría elegida ya no está disponible en el ERP. Decime cuál usar (el resto del gasto se mantiene) o escribí "cancelar".`
        : /^WA_ACCOUNT_NOT_SELECTABLE/.test(e)   // the paying account was disabled after the proposal
          ? `No se registró ${r.short_code || ''}: la cuenta elegida ya no está habilitada en el ERP. Decime desde qué cuenta lo pagaste (el resto del gasto se mantiene) o escribí "cancelar".`
          : `No se pudo registrar ${r.short_code || ''}: ${e.slice(0, 120)}.\nDecime qué corregir o escribí "cancelar".`;
      return { graph: text(ctx.to, body), state: { ...st, open } };
    }
    if (r.already_confirmed) return { graph: text(ctx.to, `${r.short_code} ya estaba registrado.`), state: drop(st, r.draft_id) };
    if (r.state === 'CONFIRMED' && r.unclassified) {
      // "Confirmar sin clasificar": the money is recorded (or, for Mercado Pago, already was), the subcategory is chosen in the ERP
      const x = r.result || {};
      const body = x.financial_effect === 'EXISTING_MP_OUTFLOW'
        ? `✅ ${r.short_code} confirmado SIN CLASIFICAR. El egreso de Mercado Pago${x.amount ? ' de ' + money(x.amount) : ''} ya figura en el ERP como pendiente de clasificar; no se registró otro movimiento.`
        : `✅ Registré el egreso ${r.short_code}${x.amount ? ' de ' + money(x.amount) : ''}: ya descuenta de la cuenta. Queda SIN CLASIFICAR: la subcategoría se elige después en el ERP (sin otro movimiento).`;
      return { graph: text(ctx.to, body + ' (simulación STAGING; no afecta la contabilidad real).'), state: drop(st, r.draft_id) };
    }
    if (r.state === 'CONFIRMED' && r.result && r.result.payable_id) {   // ADR-026: a pending expense
      const x = r.result;
      return { graph: text(ctx.to, `✅ Registré ${r.short_code} como gasto A PAGAR${x.amount ? ' de ' + money(x.amount) : ''}: ya figura en resultados, sin mover Caja ni Bancos.`
        + `${x.due_date ? ' Vence el ' + ddmmyyyy(x.due_date) + '.' : ''} Lo pagás desde el ERP (Caja → Cuentas a pagar).`), state: drop(st, r.draft_id) };
    }
    if (r.state === 'CONFIRMED' && r.result && r.result.fiscal_document_id && !r.result.purchase_id) {
      return { graph: text(ctx.to, `✅ Registré el crédito fiscal de ${r.short_code} en Fiscal (sin gasto ni movimiento de dinero).`), state: drop(st, r.draft_id) };
    }
    if (r.state === 'CONFIRMED') return { graph: text(ctx.to, `✅ Registrado ${r.short_code} (simulación STAGING; no afecta la contabilidad real).`), state: drop(st, r.draft_id) };
    if (r.state === 'CANCELLED') return { graph: text(ctx.to, `Cancelado ${r.short_code}.`), state: drop(st, r.draft_id) };
    if (r.state === 'WAITING_MP') {
      const w = { draft_id: r.draft_id, version: r.version, state: 'WAITING_MP', code: r.short_code };
      const cands = Array.isArray(r.mp_candidates) ? r.mp_candidates.slice(0, 3) : [];
      if (cands.length) return { graph: mpButtons(ctx.to, summary(r, cfg, ctx.changes) + `\n\nEncontré ${cands.length === 1 ? 'este egreso' : 'estos egresos'} de Mercado Pago pendiente${cands.length === 1 ? '' : 's'} con el mismo importe y fecha. Tocá el que corresponde (o respondé "mp <número de operación>"):\n`
          + cands.map((c) => `• ${c.source_id} · ${money(c.amount)} · ${ddmmyyyy(c.date)}`).join('\n'), r.draft_id, r.version, cands),
        state: { open: st.open, waiting: [...st.waiting.filter((x) => x.draft_id !== r.draft_id), w] } };
      return { graph: text(ctx.to, summary(r, cfg, ctx.changes) + `\n\nPagado con Mercado Pago: cuando aparezca el movimiento respondé "mp <número de operación>" (vence en 72 h).`),
               state: { open: st.open, waiting: [...st.waiting.filter((x) => x.draft_id !== r.draft_id), w] } };
    }
    if (r.state === 'DRAFT') {
      const s = drop(st, r.draft_id);
      const p = r.payload || {};
      // a mandatory datum is still to choose. The account (a financial datum) pending → NO confirmation at all. Only the
      // subcategory pending → answer it, or the explicit "Confirmar sin clasificar" (the money now, the subcategory later in the ERP)
      const q = pendingQuestions(p, cfg);
      const onlyCategory = p.category_pending && !p.concept_pending && !p.fiscal && !p.account_pending && !p.method_pending && p.account_id && p.method;
      if (p.vat_only) return { graph: buttons(ctx.to, vatSummary(r) + '\n\n¿Confirmás? "cancelar" lo descarta.', r.draft_id, r.version),
                               state: { open: { draft_id: r.draft_id, version: r.version, state: 'DRAFT', code: r.short_code }, waiting: s.waiting } };
      const graph = p.method_pending
        ? methodButtons(ctx.to, summary(r, cfg, ctx.changes) + '\n\n' + (q.length > 1 ? 'Me faltan datos:\n• ' + q.join('\n• ') : q[0])
                        + '\nTocá cómo lo pagaste (o escribilo); "cancelar" lo descarta.', r.draft_id, r.version)
        : !q.length
        ? buttons(ctx.to, summary(r, cfg, ctx.changes) + '\n\n' + ASK, r.draft_id, r.version)
        : onlyCategory
          ? buttons(ctx.to, summary(r, cfg, ctx.changes) + '\n\n' + q[0] + `\nRespondé con el nombre, o tocá "${UNCLASSIFIED_TITLE}": `
                            + (p.method === 'MERCADOPAGO'
                              ? 'el egreso de Mercado Pago ya está en el ERP y queda pendiente de clasificar (no se registra otro movimiento).'
                              : 'registro el egreso ahora (descuenta de la cuenta) y la subcategoría se elige después en el ERP.')
                            + ' "cancelar" lo descarta.', r.draft_id, r.version, 'UNCLASSIFIED')
          : text(ctx.to, summary(r, cfg, ctx.changes) + '\n\n' + (q.length > 1 ? 'Me faltan dos datos:\n• ' + q.join('\n• ') : q[0])
                         + '\nRespondé con el nombre; "cancelar" lo descarta.');
      return { graph,
               state: { open: { draft_id: r.draft_id, version: r.version, state: 'DRAFT', code: r.short_code }, waiting: s.waiting } };
    }
    return { graph: null, state: st };
  }

  return { sha256Hex, nonce, toNumber, verify, today, route, prepare, compose };
})();
