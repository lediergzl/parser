// Flujo de depósitos WhatsApp reutilizando public.deposit_requests.
// El cliente solicita desde WhatsApp y el comercial/admin aprueba desde Telegram.
const { createClient } = require('@supabase/supabase-js');
const baileys = require('@whiskeysockets/baileys');

const originalMakeWASocket = baileys.default;
const depositStates = new Map();
const commercialSockets = new Map();
let telegramHandlersInstalled = false;

function supa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);
}
function admins() { return String(process.env.ADMIN_IDS || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite); }
function money(v) { return Number(v || 0).toFixed(2); }
function norm(v) { return String(v || '').trim().replace(/\s+/g, ' '); }
function senderJid(m) { return String(m?.key?.participant || m?.key?.remoteJid || '').trim(); }
function remoteJid(m) { return String(m?.key?.remoteJid || '').trim(); }
function textFromMessage(m) {
  const x = m?.message;
  return norm(x?.conversation || x?.extendedTextMessage?.text || x?.imageMessage?.caption || x?.videoMessage?.caption || x?.documentMessage?.caption || '');
}
function hasProofMedia(m) { const x = m?.message; return Boolean(x?.imageMessage || x?.documentMessage || x?.videoMessage); }
function phoneKey(jid) { const m = String(jid || '').match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/); return m ? m[1] : String(jid || '').split('@')[0].replace(/:\d+$/, ''); }

async function telegramSendMessage(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const body = { chat_id: String(chatId), text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok;
}

async function telegramSendPhoto(chatId, buffer, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !buffer) return false;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'comprobante.jpg');
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    return r.ok;
  } catch (e) { console.warn('[WA DEPOSITO] comprobante:', e?.message || e); return false; }
}

async function downloadProof(sock, message) {
  if (!hasProofMedia(message)) return null;
  try {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    return await downloadMediaMessage(message, 'buffer', {}, { logger: { info() {}, error() {}, warn() {}, debug() {} } });
  } catch (e) { console.warn('[WA DEPOSITO] descarga comprobante:', e?.message || e); return null; }
}

async function resolverComercialId(sock) {
  const telefono = phoneKey(sock?.user?.id);
  if (!telefono) return null;
  const db = supa();
  const { data, error } = await db.from('whatsapp_comercial_session').select('comercial_telegram_id,telefono').limit(1000);
  if (error) { console.warn('[WA DEPOSITO] resolver comercial:', error.message); return null; }
  const row = (data || []).find(x => phoneKey(x.telefono) === telefono);
  if (!row) return null;
  const id = Number(row.comercial_telegram_id);
  if (Number.isFinite(id)) { commercialSockets.set(id, sock); return id; }
  return null;
}

async function clienteWhatsApp(db, comercialId, jid) {
  const { data, error } = await db.from('clientes_banca').select('id,nombre,saldo,whatsapp_jid,comercial_telegram_id').eq('comercial_telegram_id', comercialId).eq('whatsapp_jid', jid).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function crearSolicitud(sock, comercialId, message, state, referenceText) {
  const db = supa();
  const jid = senderJid(message);
  const cliente = await clienteWhatsApp(db, comercialId, jid);
  if (!cliente) {
    await sock.sendMessage(remoteJid(message), { text: '❌ Este WhatsApp no está registrado con el comercial. Primero debes registrarte con el comercial para poder solicitar una recarga.' });
    return;
  }
  const payload = {
    user_telegram_id: Number(comercialId),
    amount: state.amount,
    payment_method: state.paymentMethod || 'otro',
    proof_file_id: null,
    status: 'pending',
    admin_notes: referenceText ? `Referencia WhatsApp: ${referenceText}` : 'Comprobante recibido por WhatsApp.',
    comercial_telegram_id: Number(comercialId),
    whatsapp_jid: jid,
    source: 'whatsapp_comercial',
    proof_message_id: String(message?.key?.id || ''),
    client_name: cliente.nombre || null
  };
  const { data: request, error } = await db.from('deposit_requests').insert([payload]).select('id,amount,payment_method').single();
  if (error) throw error;
  depositStates.delete(`${Number(comercialId)}:${jid}`);

  const keyboard = { inline_keyboard: [[
    { text: '✅ Aprobar recarga', callback_data: `wa_deposit_approve_${request.id}` },
    { text: '❌ Rechazar', callback_data: `wa_deposit_reject_${request.id}` }
  ]] };
  const texto = [
    '💰 NUEVA RECARGA DE CLIENTE WHATSAPP', '',
    `🧾 Solicitud #${request.id}`,
    `👤 Cliente: ${cliente.nombre || 'Sin nombre'}`,
    `📱 WhatsApp: ${jid}`,
    `💵 Monto: $${money(request.amount)}`,
    `💳 Método: ${request.payment_method}`,
    referenceText ? `🔖 Referencia: ${referenceText}` : '🧾 Comprobante: enviado por WhatsApp', '',
    'Verifica el pago y selecciona una opción:'
  ].join('\n');
  await telegramSendMessage(comercialId, texto, keyboard);
  const proof = await downloadProof(sock, message);
  if (proof) await telegramSendPhoto(comercialId, proof, `Comprobante WhatsApp — solicitud #${request.id}`);
  await sock.sendMessage(remoteJid(message), { text: `✅ Solicitud de recarga enviada.\n\n🧾 Solicitud #${request.id}\n💵 Monto: $${money(request.amount)}\n💳 Método: ${request.payment_method}\n\n⏳ El comercial debe verificar y aprobar el pago. Te avisaremos cuando el saldo quede acreditado.` });
}

async function procesarMensajeDeposito(sock, comercialId, message) {
  if (!message?.key || message.key.fromMe) return false;
  const remote = remoteJid(message);
  if (!remote || remote === 'status@broadcast' || remote.endsWith('@g.us')) return false;
  const jid = senderJid(message);
  if (!jid || jid.endsWith('@g.us')) return false;
  const key = `${Number(comercialId)}:${jid}`;
  const text = textFromMessage(message);
  const command = text.toLowerCase();

  if (command === '/saldo') {
    try {
      const cliente = await clienteWhatsApp(supa(), comercialId, jid);
      await sock.sendMessage(remote, { text: cliente ? `💰 SALDO DISPONIBLE\n\n👤 ${cliente.nombre}\n💵 $${money(cliente.saldo)}\n\nPara recargar escribe /depositar.` : '❌ Este WhatsApp no está registrado con el comercial.' });
    } catch (e) { console.error('[WA DEPOSITO] /saldo:', e); await sock.sendMessage(remote, { text: '❌ No pude consultar tu saldo en este momento.' }); }
    return true;
  }

  if (command === '/cancelar_deposito' || command === '/cancelar') {
    const removed = depositStates.delete(key);
    await sock.sendMessage(remote, { text: removed ? '❌ Solicitud de recarga cancelada. Tu saldo no fue modificado.' : 'ℹ️ No tienes una solicitud de recarga en curso.' });
    return true;
  }

  if (command === '/depositar' || command === '/recargar') {
    try {
      const cliente = await clienteWhatsApp(supa(), comercialId, jid);
      if (!cliente) { await sock.sendMessage(remote, { text: '❌ Este WhatsApp no está registrado con el comercial. Primero debes registrarte con el comercial.' }); return true; }
      depositStates.set(key, { step: 'method', amount: null, paymentMethod: null });
      await sock.sendMessage(remote, { text: '💰 RECARGAR SALDO\n\nSelecciona el método escribiendo:\n\n1. Transfermóvil\n2. EnZona\n\nDespués te pediré el monto y el comprobante.\n\nPara cancelar: /cancelar_deposito' });
    } catch (e) { console.error('[WA DEPOSITO] iniciar:', e); await sock.sendMessage(remote, { text: '❌ No pude iniciar la recarga. Inténtalo nuevamente.' }); }
    return true;
  }

  const state = depositStates.get(key);
  if (!state) return false;

  if (state.step === 'method') {
    if (!['1', '2', 'transfermovil', 'transfermóvil', 'enzona'].includes(command)) { await sock.sendMessage(remote, { text: '❌ Método no válido. Escribe 1 para Transfermóvil o 2 para EnZona.' }); return true; }
    state.paymentMethod = ['1', 'transfermovil', 'transfermóvil'].includes(command) ? 'transfermovil' : 'enzona';
    state.step = 'amount';
    depositStates.set(key, state);
    await sock.sendMessage(remote, { text: `💳 Método: ${state.paymentMethod === 'transfermovil' ? 'Transfermóvil' : 'EnZona'}\n\nEscribe ahora el monto que deseas depositar.\n\nEjemplo: 1000` });
    return true;
  }

  if (state.step === 'amount') {
    const amount = Number(command.replace('$', '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) { await sock.sendMessage(remote, { text: '❌ Monto no válido. Escribe un número mayor que 0. Ejemplo: 1000' }); return true; }
    state.amount = Math.round(amount * 100) / 100;
    state.step = 'proof';
    depositStates.set(key, state);
    await sock.sendMessage(remote, { text: `💰 Monto: $${money(state.amount)}\n💳 Método: ${state.paymentMethod}\n\n📎 Ahora envía la captura/comprobante de la transferencia.\n\nTambién puedes escribir el número de referencia.\n\nPara cancelar: /cancelar_deposito` });
    return true;
  }

  if (state.step === 'proof') {
    if (!text && !hasProofMedia(message)) return true;
    try { await crearSolicitud(sock, comercialId, message, state, text || null); }
    catch (e) { console.error('[WA DEPOSITO] crear solicitud:', e); await sock.sendMessage(remote, { text: '❌ No pude registrar la solicitud de recarga. No se modificó tu saldo. Inténtalo nuevamente.' }); }
    return true;
  }
  return false;
}

function instalarTelegram() {
  const bot = global.__LOTO_BOT__;
  if (!bot || telegramHandlersInstalled) return;
  telegramHandlersInstalled = true;

  bot.action(/^wa_deposit_approve_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const requestId = Number(ctx.match[1]);
    try {
      const db = supa();
      const { data: req, error } = await db.from('deposit_requests').select('id,comercial_telegram_id,whatsapp_jid,amount,status,client_name').eq('id', requestId).eq('source', 'whatsapp_comercial').maybeSingle();
      if (error) throw error;
      if (!req) return ctx.reply('❌ Solicitud no encontrada.');
      if (!admins().includes(Number(ctx.from.id)) && Number(req.comercial_telegram_id) !== Number(ctx.from.id)) return ctx.reply('⛔ No estás autorizado para aprobar esta recarga.');
      if (req.status !== 'pending') return ctx.reply(`ℹ️ La solicitud #${requestId} ya fue procesada.`);
      const { data, error: rpcError } = await db.rpc('aprobar_deposito_comercial_atomico', { p_request_id: requestId, p_aprobado_por: Number(ctx.from.id) });
      if (rpcError) throw rpcError;
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.ok) throw new Error('La base de datos no confirmó la acreditación.');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.reply(`✅ Recarga #${requestId} aprobada.\n\n👤 ${req.client_name || req.whatsapp_jid}\n💰 Acreditado: $${money(req.amount)}\n💵 Nuevo saldo: $${money(result.saldo_despues)}`);
      const sock = commercialSockets.get(Number(req.comercial_telegram_id));
      if (sock) await sock.sendMessage(req.whatsapp_jid, { text: `🎉 RECARGA APROBADA\n\n💰 Se acreditaron $${money(req.amount)} a tu saldo.\n💵 Nuevo saldo: $${money(result.saldo_despues)}\n\nYa puedes continuar jugando.` }).catch(() => {});
    } catch (e) { console.error('[WA DEPOSITO] aprobar:', e); await ctx.reply(`❌ No se pudo aprobar la solicitud #${requestId}.\n\n${e?.message || e}`); }
  });

  bot.action(/^wa_deposit_reject_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const requestId = Number(ctx.match[1]);
    try {
      const db = supa();
      const { data: req, error } = await db.from('deposit_requests').select('id,comercial_telegram_id,whatsapp_jid,amount,status').eq('id', requestId).eq('source', 'whatsapp_comercial').maybeSingle();
      if (error) throw error;
      if (!req) return ctx.reply('❌ Solicitud no encontrada.');
      if (!admins().includes(Number(ctx.from.id)) && Number(req.comercial_telegram_id) !== Number(ctx.from.id)) return ctx.reply('⛔ No estás autorizado para rechazar esta recarga.');
      if (req.status !== 'pending') return ctx.reply(`ℹ️ La solicitud #${requestId} ya fue procesada.`);
      const { error: updateError } = await db.from('deposit_requests').update({ status: 'rejected', admin_notes: `Rechazado por ${ctx.from.id}`, updated_at: new Date().toISOString() }).eq('id', requestId).eq('source', 'whatsapp_comercial').eq('status', 'pending');
      if (updateError) throw updateError;
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.reply(`❌ Recarga #${requestId} rechazada.`);
      const sock = commercialSockets.get(Number(req.comercial_telegram_id));
      if (sock) await sock.sendMessage(req.whatsapp_jid, { text: `❌ RECARGA RECHAZADA\n\nLa solicitud #${requestId} por $${money(req.amount)} fue rechazada. Si realizaste el pago, contacta al comercial para revisar el comprobante.` }).catch(() => {});
    } catch (e) { console.error('[WA DEPOSITO] rechazar:', e); await ctx.reply('❌ No se pudo rechazar la solicitud.'); }
  });
}

if (typeof originalMakeWASocket === 'function' && !originalMakeWASocket.__lotoProDepositPatch) {
  const patchedMakeWASocket = function (...args) {
    const sock = originalMakeWASocket(...args);
    const originalOn = sock?.ev?.on?.bind(sock.ev);
    if (!originalOn) return sock;
    sock.ev.on = function (event, listener) {
      if (event !== 'messages.upsert' || typeof listener !== 'function') return originalOn(event, listener);
      const wrapped = async payload => {
        const comercialId = await resolverComercialId(sock);
        if (comercialId) {
          for (const message of payload?.messages || []) {
            try { if (await procesarMensajeDeposito(sock, comercialId, message)) continue; }
            catch (e) { console.error('[WA DEPOSITO] interceptor:', e); }
          }
        }
        return listener(payload);
      };
      return originalOn(event, wrapped);
    };
    return sock;
  };
  Object.assign(patchedMakeWASocket, originalMakeWASocket);
  patchedMakeWASocket.__lotoProDepositPatch = true;
  baileys.default = patchedMakeWASocket;
}

setInterval(instalarTelegram, 1000).unref?.();
instalarTelegram();
global.__LOTO_WA_DEPOSIT_STATES__ = depositStates;
global.__LOTO_WA_DEPOSIT_SOCKETS__ = commercialSockets;
