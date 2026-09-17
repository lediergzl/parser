const { createClient } = require('@supabase/supabase-js');
const { useSupabaseAuthState } = require('./lib/wa-session-store');
const { DisconnectReason } = require('@whiskeysockets/baileys');

const sockets = new Map();
const reconnectTimers = new Map();
const activeBettingChats = new Set();

function enabled() {
  return String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() === 'true';
}

function admins() {
  return String(process.env.ADMIN_IDS || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite);
}

function supa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);
}

function textFromMessage(message) {
  const remoteJid = String(message?.key?.remoteJid || '').trim();
  if (remoteJid.endsWith('@g.us')) return '';
  const m = message?.message;
  if (!m) return '';
  return String(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function senderName(message) {
  return String(message?.pushName || message?.verifiedBizName || '').trim();
}

function bettingChatKey(comercialId, whatsappJid) {
  return `${Number(comercialId)}:${String(whatsappJid || '').trim()}`;
}

function normalizeCommand(texto) {
  return String(texto || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function pngChunk(type, data) {
  let crc = 0xffffffff;
  const b = Buffer.from(type, 'ascii');
  const all = Buffer.concat([b, data]);
  for (const byte of all) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc, 0);
  return Buffer.concat([len, b, data, c]);
}

function qrToPng(qrText, scale = 8) {
  const QRCode = require('qrcode-terminal/vendor/QRCode');
  const Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  const qr = new QRCode(0, Level.M); qr.addData(qrText); qr.make();
  const matrix = qr.modules; const width = matrix.length; const quiet = 4;
  const modules = width + quiet * 2; const size = modules * scale; const rows = [];
  for (let y = -quiet; y < width + quiet; y++) {
    const row = Buffer.alloc(1 + size * 3); row[0] = 0;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = y >= 0 && y < width && mx >= 0 && mx < width && matrix[y][mx] === true;
      const v = dark ? 0 : 255; const p = 1 + x * 3; row[p] = v; row[p + 1] = v; row[p + 2] = v;
    }
    for (let sy = 0; sy < scale; sy++) rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', require('zlib').deflateSync(Buffer.concat(rows), { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

async function telegramPhoto(chatId, buffer, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const form = new FormData();
  form.append('chat_id', String(chatId)); form.append('caption', caption);
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'whatsapp-qr.png');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  return r.ok;
}

async function telegramText(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text })
  });
}

async function commercialRole(db, id) {
  if (admins().includes(Number(id))) return 'admin';
  const { data } = await db.from('users').select('role').eq('telegram_id', id).maybeSingle();
  return data?.role || 'cliente';
}

async function saveStatus(db, id, patch) {
  await db.from('whatsapp_comercial_session').upsert({ comercial_telegram_id: id, ...patch, updated_at: new Date().toISOString() });
}

async function sendQr(id, qr) {
  const db = supa();
  await saveStatus(db, id, { estado: 'esperando_qr', ultimo_qr: qr, ultimo_error: null });
  const ok = await telegramPhoto(id, qrToPng(qr), '📲 QR de tu WhatsApp\n\nEn WhatsApp: Ajustes → Dispositivos vinculados → Vincular dispositivo.\n\n⚠️ Este QR es temporal. Si aparece otro, usa siempre el más reciente.');
  if (!ok) await telegramText(id, '⚠️ No pude enviarte el QR. Usa /wa_qr para solicitar el más reciente.');
}

async function buscarClienteWhatsApp(db, comercialId, senderJid, nombreSender) {
  const jid = String(senderJid || '').trim();
  const nombre = String(nombreSender || '').trim().slice(0, 120) || 'SIN NOMBRE';
  if (jid) {
    const { data: porJid, error } = await db.from('clientes_banca').select('*').eq('comercial_telegram_id', comercialId).eq('whatsapp_jid', jid).maybeSingle();
    if (error) throw error;
    if (porJid) return porJid;
  }
  if (nombre !== 'SIN NOMBRE') {
    const { data: porNombre, error } = await db.from('clientes_banca').select('*').eq('comercial_telegram_id', comercialId).eq('nombre', nombre);
    if (error) throw error;
    if (porNombre?.length === 1) {
      const cliente = porNombre[0];
      if (!cliente.whatsapp_jid || cliente.whatsapp_jid === jid) {
        if (jid && !cliente.whatsapp_jid) {
          const { data, error: updateError } = await db.from('clientes_banca').update({ whatsapp_jid: jid, updated_at: new Date().toISOString() }).eq('id', cliente.id).select('*').single();
          if (updateError) throw updateError;
          return data;
        }
        return cliente;
      }
    }
  }
  const { data: nuevo, error } = await db.from('clientes_banca').insert([{ comercial_telegram_id: comercialId, nombre, saldo: 0, whatsapp_jid: jid || null }]).select('*').single();
  if (error) {
    if (jid && String(error.code) === '23505') {
      const { data: existente, error: retryError } = await db.from('clientes_banca').select('*').eq('comercial_telegram_id', comercialId).eq('whatsapp_jid', jid).maybeSingle();
      if (retryError) throw retryError;
      if (existente) return existente;
    }
    throw error;
  }
  return nuevo;
}

async function registrarBetAtomica(db, { comercialId, clienteBancaId, loteriaId, sorteoId, fecha, inputRaw, totalApuesta, detalle, moneda }) {
  const { data, error } = await db.rpc('registrar_bet_comercial_atomica', {
    p_comercial_telegram_id: comercialId,
    p_cliente_banca_id: clienteBancaId,
    p_loteria_id: loteriaId,
    p_sorteo_id: sorteoId,
    p_fecha_apuesta: fecha,
    p_input_raw: inputRaw,
    p_total_apuesta: totalApuesta,
    p_detalle: detalle,
    p_moneda: moneda || 'cup'
  });
  if (error) throw error;
  const r = Array.isArray(data) ? data[0] : data;
  if (!r?.ok || !r.bet_id) throw new Error(r?.message || 'La base de datos no confirmó la apuesta.');
  return { id: Number(r.bet_id), saldoAntes: Number(r.saldo_antes || 0), credito: Number(r.credito || 0), saldoDespues: Number(r.saldo_despues || 0) };
}

async function procesarJugadaWhatsApp({ comercialId, texto, senderJid, senderName: nombreSender }) {
  const db = supa();
  const { data: pref } = await db.from('user_preferences').select('loteria_id,sorteo_id,moneda').eq('telegram_id', comercialId).maybeSingle();
  if (!pref?.loteria_id || !pref?.sorteo_id) throw new Error('El comercial debe seleccionar lotería y sorteo con /start antes de recibir jugadas por WhatsApp.');
  const { data: sorteo } = await db.from('sorteos').select('id,nombre,hora_apertura,hora_cierre,activo').eq('id', pref.sorteo_id).maybeSingle();
  if (!sorteo?.activo) throw new Error('El sorteo seleccionado no está activo.');
  const Engine = global.Engine, Preprocesador = global.Preprocesador, Utils = global.Utils, Expansion = global.Expansion;
  if (!Engine?.calcular || !Preprocesador?.preprocesarJugada || !Utils?.limpiarMonto || !Expansion) throw new Error('Motor LotoPro no disponible.');
  const result = Engine.calcular({ rawInput: texto, loteriaId: pref.loteria_id, sorteoId: pref.sorteo_id }, { Expansion, limpiarMonto: Utils.limpiarMonto, preprocesarJugada: Preprocesador.preprocesarJugada, obtenerTimestampLocal: () => new Date().toISOString() });
  if (!result?.ok || !result.certified) {
    const detail = (result?.errors || []).map(e => e.message || e.reason).join('\n');
    throw new Error(`${result?.message || 'La jugada no pudo procesarse.'}${detail ? `\n${detail}` : ''}`);
  }
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Havana' }).format(new Date());
  const bets = [];
  const cliente = await buscarClienteWhatsApp(db, comercialId, senderJid, nombreSender);
  for (const j of result.jugadas || []) {
    const nombre = String(cliente.nombre || nombreSender || senderJid || 'SIN NOMBRE').trim().slice(0, 120);
    const total = Number(j.monto_total || 0);
    if (!Number.isFinite(total) || total < 0) throw new Error('Monto de jugada inválido.');
    const registro = await registrarBetAtomica(db, { comercialId, clienteBancaId: cliente.id, loteriaId: pref.loteria_id, sorteoId: pref.sorteo_id, fecha, inputRaw: j.jugada_texto || texto, totalApuesta: total, detalle: JSON.stringify(j.jugadas_detalle || []), moneda: pref.moneda || 'cup' });
    cliente.saldo = registro.saldoDespues;
    bets.push({ id: registro.id, nombre, total, credito: registro.credito, saldoAntes: registro.saldoAntes, saldoDespues: registro.saldoDespues });
  }
  return { bets, total: Number(result.totalGeneral || 0), sorteo: sorteo.nombre };
}

async function recibirMensaje(db, sock, comercialId, message) {
  if (!message?.key?.id || message.key.fromMe) return;
  const texto = textFromMessage(message); if (!texto) return;
  const remoteJid = String(message.key.remoteJid || '').trim();
  if (!remoteJid || remoteJid === 'status@broadcast') return;
  const senderJid = String(message.key.participant || remoteJid).trim();
  const nombreSender = senderName(message);
  const key = bettingChatKey(comercialId, senderJid || remoteJid);
  const command = normalizeCommand(texto);

  if (command === '/jugar') {
    activeBettingChats.add(key);
    await sock.sendMessage(remoteJid, { text: '🎰 Modo jugada activado. Puedes enviar tus jugadas ahora.\n\nPara salir del modo jugada escribe /salir.' });
    return;
  }

  if (command === '/salir') {
    activeBettingChats.delete(key);
    await sock.sendMessage(remoteJid, { text: '✅ Modo jugada desactivado. Tus mensajes ya no se procesarán como apuestas.\n\nCuando quieras jugar de nuevo escribe /jugar.' });
    return;
  }

  if (!activeBettingChats.has(key)) return;

  const { data: inserted, error } = await db.from('whatsapp_inbox').insert([{ comercial_telegram_id: comercialId, message_id: String(message.key.id), remote_jid: remoteJid, sender_jid: senderJid || null, sender_name: nombreSender || null, texto }]).select('id').single();
  if (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate')) return;
    console.error('WhatsApp inbox error:', error); return;
  }
  await db.from('whatsapp_comercial_session').update({ ultimo_mensaje_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('comercial_telegram_id', comercialId);
  try {
    const r = await procesarJugadaWhatsApp({ comercialId, texto, senderJid, senderName: nombreSender });
    await db.from('whatsapp_inbox').update({ procesado: true, bet_ids: r.bets.map(b => b.id), error: null }).eq('id', inserted.id);
    const resumen = r.bets.map(b => { const creditoTxt = b.credito > 0 ? `\n💳 Crédito aplicado: $${b.credito.toFixed(2)}\n💰 Saldo restante: $${b.saldoDespues.toFixed(2)}` : ''; return `👤 ${b.nombre}: $${b.total.toFixed(2)}${creditoTxt}`; }).join('\n');
    await sock.sendMessage(remoteJid, { text: `✅ Jugada recibida y registrada.\n\n${resumen}\n\n💵 Total: $${r.total.toFixed(2)}\n🎰 ${r.sorteo}` });
    await telegramText(comercialId, `📲 Jugada recibida por WhatsApp\n\n${resumen}\n\n💵 Total: $${r.total.toFixed(2)}\n🎰 ${r.sorteo}`);
  } catch (err) {
    await db.from('whatsapp_inbox').update({ error: String(err?.message || err) }).eq('id', inserted.id);
    await sock.sendMessage(remoteJid, { text: `⚠️ Recibí la jugada pero NO fue registrada.\n\n${String(err?.message || err)}` });
    await telegramText(comercialId, `⚠️ Jugada WhatsApp no registrada\n\n${String(err?.message || err)}`);
  }
}

async function conectarComercial(db, comercialId, force = false) {
  const id = Number(comercialId); if (!Number.isFinite(id)) throw new Error('comercialId inválido');
  if (sockets.has(id) && !force) return sockets.get(id);
  if (sockets.has(id)) { try { sockets.get(id).end?.(new Error('reconnect')); } catch (_) {} sockets.delete(id); }
  const makeWASocket = require('@whiskeysockets/baileys').default;
  const { state, saveCreds } = await useSupabaseAuthState(db, `commercial:${id}`);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, markOnlineOnConnect: false, shouldSyncHistoryMessage: () => false });
  sockets.set(id, sock);
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) await sendQr(id, qr).catch(e => console.error(`QR ${id}:`, e));
    if (connection === 'open') {
      const telefono = sock.user?.id || null;
      await saveStatus(db, id, { estado: 'conectado', ultimo_qr: null, telefono, ultimo_error: null });
      await telegramText(id, `✅ WhatsApp conectado${telefono ? `: ${telefono}` : ''}. Ya puedes recibir jugadas.`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      await saveStatus(db, id, { estado: loggedOut ? 'desconectado' : 'conectando', ultimo_error: String(lastDisconnect?.error?.message || '') });
      sockets.delete(id);
      if (!loggedOut && !reconnectTimers.has(id)) {
        const timer = setTimeout(() => { reconnectTimers.delete(id); conectarComercial(db, id).catch(e => console.error(`reconnect WA ${id}:`, e)); }, 3000);
        reconnectTimers.set(id, timer);
      }
    }
  });
  sock.ev.on('messages.upsert', async event => {
    if (event.type !== 'notify' || event.requestId) return;
    for (const message of event.messages || []) await recibirMensaje(db, sock, id, message);
  });
  return sock;
}

async function desconectarComercial(db, id) {
  const sock = sockets.get(Number(id));
  if (sock) { try { sock.logout(); } catch (_) { try { sock.end?.(); } catch (_) {} } sockets.delete(Number(id)); }
  for (const key of activeBettingChats) {
    if (key.startsWith(`${Number(id)}:`)) activeBettingChats.delete(key);
  }
  await db.from('whatsapp_comercial_session').update({ estado: 'desconectado', creds: null, keys: null, ultimo_qr: null, updated_at: new Date().toISOString() }).eq('comercial_telegram_id', id);
}

function statusFor(id) {
  const sock = sockets.get(Number(id));
  return sock ? 'activo' : 'inactivo';
}

async function registrarWhatsappComerciales(bot) {
  if (!enabled()) { console.log('ℹ️ WA_BAILEYS_ENABLED no está en true.'); return; }
  const db = supa();
  bot.command('wa_conectar', async ctx => {
    const role = await commercialRole(db, ctx.from.id);
    if (!['comercial','admin'].includes(role)) return ctx.reply('⛔ Solo un comercial puede conectar su WhatsApp.');
    await ctx.reply('📲 Preparando tu conexión de WhatsApp. En unos segundos recibirás el QR aquí.');
    try { await conectarComercial(db, ctx.from.id, true); } catch (e) { console.error(e); await ctx.reply(`❌ No se pudo iniciar WhatsApp: ${e.message}`); }
  });
  bot.command('wa_qr', async ctx => {
    const role = await commercialRole(db, ctx.from.id);
    if (!['comercial','admin'].includes(role)) return ctx.reply('⛔ Solo un comercial puede usar este comando.');
    const { data } = await db.from('whatsapp_comercial_session').select('ultimo_qr,estado').eq('comercial_telegram_id', ctx.from.id).maybeSingle();
    if (!data?.ultimo_qr) return ctx.reply('ℹ️ No hay un QR pendiente. Usa /wa_conectar.');
    await sendQr(ctx.from.id, data.ultimo_qr);
  });
  bot.command('wa_estado', async ctx => {
    const role = await commercialRole(db, ctx.from.id);
    if (!['comercial','admin'].includes(role)) return ctx.reply('⛔ Sin permiso.');
    const { data } = await db.from('whatsapp_comercial_session').select('estado,telefono,ultimo_error,ultimo_mensaje_at').eq('comercial_telegram_id', ctx.from.id).maybeSingle();
    return ctx.reply(`📲 WhatsApp\nEstado: ${data?.estado || statusFor(ctx.from.id)}${data?.telefono ? `\nTeléfono: ${data.telefono}` : ''}${data?.ultimo_error ? `\nError: ${data.ultimo_error}` : ''}${data?.ultimo_mensaje_at ? `\nÚltimo mensaje: ${data.ultimo_mensaje_at}` : ''}`);
  });
  bot.command('wa_desconectar', async ctx => {
    const role = await commercialRole(db, ctx.from.id);
    if (!['comercial','admin'].includes(role)) return ctx.reply('⛔ Sin permiso.');
    await desconectarComercial(db, ctx.from.id); await ctx.reply('✅ WhatsApp desconectado.');
  });
  bot.command('wa_comerciales', async ctx => {
    if (!admins().includes(Number(ctx.from.id))) return ctx.reply('⛔ Solo admin.');
    const { data } = await db.from('users').select('telegram_id,username,first_name').eq('role','comercial').order('telegram_id');
    if (!data?.length) return ctx.reply('No hay comerciales definidos.');
    const ids = data.map(x => x.telegram_id); const { data: sessions } = await db.from('whatsapp_comercial_session').select('comercial_telegram_id,estado,telefono').in('comercial_telegram_id', ids);
    const map = new Map((sessions || []).map(x => [Number(x.comercial_telegram_id), x]));
    return ctx.reply(data.map(x => { const s = map.get(Number(x.telegram_id)); return `👤 ${x.first_name || x.username || x.telegram_id}\nID: ${x.telegram_id}\nWhatsApp: ${s?.estado || 'sin configurar'}${s?.telefono ? `\n${s.telefono}` : ''}`; }).join('\n\n'));
  });
  const { data: comerciales } = await db.from('users').select('telegram_id').eq('role','comercial');
  for (const c of comerciales || []) conectarComercial(db, c.telegram_id).catch(e => console.error(`No se pudo restaurar WhatsApp del comercial ${c.telegram_id}:`, e));
  console.log(`✅ WhatsApp multi-comercial listo (${(comerciales || []).length} comerciales)`);
}

module.exports = { registrarWhatsappComerciales, conectarComercial, desconectarComercial, procesarJugadaWhatsApp };
