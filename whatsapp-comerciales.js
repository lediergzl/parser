const { createClient } = require('@supabase/supabase-js');
const { useSupabaseAuthState } = require('./lib/wa-session-store');
const { crearLockSesionWhatsapp } = require('./lib/wa-instance-lock');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { adaptIncomingInteractive, sendNative, sendMainMenu, sendLotteryMenu, sendDrawMenu, sendConfirmationMenu } = require('./lib/wa-menu');
const { procesarMensajeDeposito, resolverSolicitudWhatsApp } = require('./wa-deposit-preload');
const { normalizarEntradaJugada, detectarNumerosAmbiguos, validarLimites } = require('./lib/jugada-input');
const { guardarGrupoResultadosComercial, leerGrupoResultadosComercial, listarGruposResultadosComerciales } = require('./lib/whatsapp-destino');

const sockets = new Map();
const authStates = new Map();
const locks = new Map();
const reconnectTimers = new Map();
const connecting = new Map();
const socketGenerations = new Map();
const activeBettingChats = new Set();
const jugarCooldowns = new Map();
const JUGAR_COOLDOWN_MS = 4000;
const WA_JUGADA_TIMEOUT_MS = Math.max(60 * 1000, Number(process.env.WA_JUGADA_TIMEOUT_MS || 15 * 60 * 1000));
const bettingSessionTimers = new Map();
// Baileys puede alternar entre @lid y senderPn en mensajes del mismo chat.
// Ambos deben apuntar al mismo identificador canónico de sesión.
const waIdentityAliases = new Map();
const registrationStates = new Map();
const qrLastSentAt = new Map();
const QR_RESEND_INTERVAL_MS = 15000;
const waMenuCache = { loterias: null, loteriasAt: 0, sorteos: new Map() };
const WA_MENU_CACHE_TTL_MS = 30 * 1000;
const waPreferenceCache = new Map();
const WA_PREFERENCE_CACHE_TTL_MS = 5 * 60 * 1000;

function programarSalidaAutomaticaWhatsApp(sock, db, comercialId, senderJid, remoteJid, key) {
  const anterior = bettingSessionTimers.get(key);
  if (anterior) clearTimeout(anterior);

  const timer = setTimeout(async () => {
    bettingSessionTimers.delete(key);
    if (!activeBettingChats.has(key)) return;

    activeBettingChats.delete(key);
    jugarCooldowns.delete(key);

    await reiniciarSesionWhatsApp(db, comercialId, senderJid).catch(() => {});
    for (const alias of [...waIdentityAliases.keys()]) {
      if (alias === bettingChatKey(comercialId, remoteJid) || alias === bettingChatKey(comercialId, senderJid)) waIdentityAliases.delete(alias);
    }
    try {
      await sock.sendMessage(remoteJid, {
        text: '⏱️ Tu sesión de jugada fue cerrada automáticamente por inactividad.\n\nCuando quieras jugar de nuevo escribe /jugar.'
      });
    } catch (e) {
      console.error('[WA SESION] No se pudo notificar salida automática:', e?.message || e);
    }
  }, WA_JUGADA_TIMEOUT_MS);

  bettingSessionTimers.set(key, timer);
}

function cancelarSalidaAutomaticaWhatsApp(key) {
  const timer = bettingSessionTimers.get(key);
  if (timer) clearTimeout(timer);
  bettingSessionTimers.delete(key);
}

function enabled() {
  return String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() === 'true';
}

// Sin esto, un redeploy/reinicio en Render mata el proceso sin avisarle a
// WhatsApp que cierre la sesión. El socket viejo queda "vivo" del lado de
// WhatsApp por unos segundos y, cuando el proceso nuevo reconecta con las
// mismas credenciales, WhatsApp expulsa una de las dos conexiones con un
// error de tipo conflict/replaced.
let shuttingDown = false;
async function cerrarTodo(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} recibido, cerrando ${sockets.size} conexión(es) de WhatsApp...`);
  for (const sock of sockets.values()) {
    try { sock.end(new Error('shutdown')); } catch (_) {}
  }
  // CRÍTICO: si el proceso muere (por ejemplo durante un redeploy de Render)
  // con escrituras de creds/keys todavía en cola en Supabase, el próximo
  // arranque carga un estado Signal desincronizado del real. Eso es lo que
  // produce el bucle "conecta -> Connection Failure -> 401 -> QR nuevo" que
  // nunca se estabiliza aunque se escanee el QR. Esperamos a que cada sesión
  // termine de escribirse y liberamos los locks distribuidos antes de salir.
  await Promise.all([...authStates.values()].map(a => a.flush().catch(() => {})));
  await Promise.all([...locks.values()].map(l => l.liberar().catch(() => {})));
}
process.on('SIGTERM', () => { cerrarTodo('SIGTERM').finally(() => process.exit(0)); });
process.on('SIGINT', () => { cerrarTodo('SIGINT').finally(() => process.exit(0)); });

function admins() {
  return String(process.env.ADMIN_IDS || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite);
}

function supa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);
}

function textFromMessage(message) {
  const remoteJid = String(message?.key?.remoteJid || '').trim();
  if (remoteJid.endsWith('@g.us')) return '';
  return textFromMessageAnyChat(message);
}

// Extrae texto tambien en grupos. Solo se usa para comandos enviados
// por el propio WhatsApp comercial (fromMe=true).
function textFromMessageAnyChat(message) {
  let m = message?.message;
  if (!m) return '';

  // WhatsApp puede envolver un texto normal dentro de ephemeral/view-once.
  // Los comandos de grupo deben llegar al parser aunque vengan envueltos.
  for (let i = 0; i < 4 && m; i++) {
    const nested =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.editedMessage?.message;
    if (!nested) break;
    m = nested;
  }

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
function normalizarJidPropio(valor) {
  const s = String(valor || '').trim().split(':')[0];
  if (s.endsWith('@s.whatsapp.net')) return s;
  if (/^\d+$/.test(s)) return s + '@s.whatsapp.net';
  return s;
}

async function normalizarJidPropioConLid(sock, valor) {
  const raw = String(valor || '').trim();
  if (!raw) return '';

  const normal = normalizarJidPropio(raw);
  if (!normal.endsWith('@lid')) return normal;

  try {
    const mapping = sock?.signalRepository?.lidMapping;
    if (mapping?.getPNForLID) {
      const pn = await mapping.getPNForLID(normal);
      if (pn) return normalizarJidPropio(pn);
    }
  } catch (_) {}

  return normal;
}

async function mensajeEsPropio(sock, message) {
  if (message?.key?.fromMe === true) return true;

  const propioRaw = String(sock?.user?.id || '').trim();
  const propio = await normalizarJidPropioConLid(sock, propioRaw);
  if (!propio) return false;

  const key = message?.key || {};
  const candidatos = [
    key.participantPn,
    key.senderPn,
    key.participant,
    key.participantAlt,
    key.senderAlt,
    key.senderLid,
    key.participantLid,
    key.remoteJidAlt,
    key.recipientAlt,
    key.recipientLid
  ].filter(Boolean);

  for (const candidato of candidatos) {
    const normal = await normalizarJidPropioConLid(sock, candidato);
    if (normal && normal === propio) return true;
  }

  return false;
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
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
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

async function sendQr(id, qr, options = {}) {
  const db = supa();
  const now = Date.now();
  const force = Boolean(options.force);
  const lastSent = qrLastSentAt.get(Number(id)) || 0;
  await saveStatus(db, id, { estado: 'esperando_qr', ultimo_qr: qr, ultimo_error: null });

  // Baileys puede rotar el QR varias veces durante una misma ventana de
  // vinculación. No inundamos Telegram con imágenes casi idénticas: el QR
  // almacenado en Supabase sigue siendo siempre el último generado.
  if (!force && now - lastSent < QR_RESEND_INTERVAL_MS) {
    console.log(`⏳ WA ${id}: QR actualizado en Supabase, envío a Telegram omitido por throttle.`);
    return false;
  }
  qrLastSentAt.set(Number(id), now);

  const ok = await telegramPhoto(
    id,
    qrToPng(qr),
    '📲 QR PARA VINCULAR EL WHATSAPP DEL COMERCIAL\n\nEn WhatsApp: Ajustes → Dispositivos vinculados → Vincular dispositivo.\n\n⚠️ Este QR es temporal. Si ya vinculaste el WhatsApp, ignora cualquier QR posterior y revisa /wa_estado.'
  );
  if (!ok) await telegramText(id, '⚠️ No pude enviarte el QR. Usa /wa_qr para solicitar el más reciente.');
  return ok;
}

function normalizarWhatsAppKey(value) {
  const v = String(value || '').trim().toLowerCase();
  const pn = v.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  if (pn) return pn[1];
  return v;
}

async function buscarClienteWhatsApp(db, comercialId, senderJid, alternateJid = null) {
  const candidatos = [...new Set(
    [senderJid, alternateJid]
      .map(v => String(v || '').trim())
      .filter(Boolean)
  )];
  if (!candidatos.length) throw new Error('No se pudo identificar el WhatsApp del cliente.');

  // Primero intentamos coincidencia exacta. Esto conserva clientes antiguos
  // registrados con @lid.
  const orExact = candidatos.map(jid => `whatsapp_jid.eq.${jid}`).join(',');
  const { data: exactRows, error: exactError } = await db
    .from('clientes_banca')
    .select('*')
    .eq('comercial_telegram_id', comercialId)
    .or(orExact)
    .limit(2);
  if (exactError) throw exactError;
  if (exactRows?.length === 1) return exactRows[0];
  if (exactRows?.length > 1) throw new Error('Hay más de un registro para este WhatsApp con el comercial.');

  // Compatibilidad con registros antiguos guardados como número/JID PN.
  const { data: rows, error } = await db
    .from('clientes_banca')
    .select('*')
    .eq('comercial_telegram_id', comercialId)
    .limit(1000);
  if (error) throw error;

  const keys = new Set(candidatos.map(normalizarWhatsAppKey));
  const matches = (rows || []).filter(row => keys.has(normalizarWhatsAppKey(row.whatsapp_jid)));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('Hay más de un registro para este WhatsApp con el comercial.');
  throw new Error('Este WhatsApp no está registrado con el comercial. Debes registrarte y realizar un depósito antes de jugar.');
}

async function obtenerPreferenciaWhatsApp(db, comercialId, whatsappJid) {
  const key = String(Number(comercialId)) + ':' + String(whatsappJid);
  const cached = waPreferenceCache.get(key);
  if (cached && Date.now() - cached.at < WA_PREFERENCE_CACHE_TTL_MS) return cached.data;

  const { data, error } = await db.from('whatsapp_cliente_preferencias')
    .select('comercial_telegram_id,whatsapp_jid,loteria_id,sorteo_id,moneda,updated_at')
    .eq('comercial_telegram_id', comercialId)
    .eq('whatsapp_jid', whatsappJid)
    .maybeSingle();
  if (error) throw error;
  const result = data || null;
  waPreferenceCache.set(key, { data: result, at: Date.now() });
  return result;
}

async function guardarPreferenciaWhatsApp(db, comercialId, whatsappJid, patch) {
  const payload = {
    comercial_telegram_id: Number(comercialId),
    whatsapp_jid: String(whatsappJid),
    loteria_id: patch.loteria_id !== undefined ? patch.loteria_id : null,
    sorteo_id: patch.sorteo_id !== undefined ? patch.sorteo_id : null,
    moneda: patch.moneda !== undefined ? patch.moneda : 'cup',
    updated_at: new Date().toISOString()
  };
  const { data, error } = await db
    .from('whatsapp_cliente_preferencias')
    .upsert(payload, { onConflict: 'comercial_telegram_id,whatsapp_jid' })
    .select('*')
    .single();
  if (error) throw error;
  const key = String(Number(comercialId)) + ':' + String(whatsappJid);
  waPreferenceCache.set(key, { data, at: Date.now() });
  return data;
}

async function reiniciarSesionWhatsApp(db, comercialId, jid) {
  await guardarPreferenciaWhatsApp(db, comercialId, jid, { loteria_id: null, sorteo_id: null });
}

async function listarLoteriasWhatsApp(db) {
  const now = Date.now();
  if (waMenuCache.loterias && now - waMenuCache.loteriasAt < WA_MENU_CACHE_TTL_MS) return waMenuCache.loterias;
  const { data, error } = await db.from('loterias').select('id,nombre').eq('activo', true).order('id');
  if (error) throw error;
  waMenuCache.loterias = data || [];
  waMenuCache.loteriasAt = now;
  return waMenuCache.loterias;
}

async function listarSorteosWhatsApp(db, loteriaId) {
  const key = Number(loteriaId);
  const cached = waMenuCache.sorteos.get(key);
  const now = Date.now();
  if (cached && now - cached.at < WA_MENU_CACHE_TTL_MS) return cached.data;
  const { data, error } = await db.from('sorteos').select('id,nombre,hora_apertura,hora_cierre,activo,loteria_id').eq('loteria_id', loteriaId).eq('activo', true).order('hora_apertura');
  if (error) throw error;
  const result = data || [];
  waMenuCache.sorteos.set(key, { data: result, at: now });
  return result;
}

function formatoHora(valor) { return valor ? String(valor).slice(0, 5) : '--:--'; }

async function enviarSeleccionLoterias(sock, remoteJid, db, interactiveJid = null) {
  const loterias = await listarLoteriasWhatsApp(db);
  return sendLotteryMenu(sock, remoteJid, loterias, interactiveJid);
}

async function enviarSeleccionSorteos(sock, remoteJid, db, loteriaId, interactiveJid = null, loteriaConocida = null) {
  const loteria = loteriaConocida || (await db.from('loterias').select('id,nombre').eq('id', loteriaId).eq('activo', true).maybeSingle()).data;
  if (!loteria) return sock.sendMessage(remoteJid, { text: '❌ La lotería seleccionada no existe o está inactiva. Usa /loterias.' });
  const sorteos = await listarSorteosWhatsApp(db, loteriaId);
  return sendDrawMenu(sock, remoteJid, loteria, sorteos, interactiveJid);
}

async function enviarEstadoCliente(sock, remoteJid, db, comercialId, jid) {
  const pref = await obtenerPreferenciaWhatsApp(db, comercialId, jid);
  let texto = '⚙️ CONFIGURACIÓN DE JUEGO\n\n';
  if (!pref?.loteria_id) texto += '🎲 Lotería: NO SELECCIONADA\n';
  else { const { data: loteria } = await db.from('loterias').select('nombre').eq('id', pref.loteria_id).maybeSingle(); texto += `🎲 Lotería: ${loteria?.nombre || pref.loteria_id}\n`; }
  if (!pref?.sorteo_id) texto += '🎰 Sorteo: NO SELECCIONADO\n';
  else { const { data: sorteo } = await db.from('sorteos').select('nombre,hora_apertura,hora_cierre,activo').eq('id', pref.sorteo_id).maybeSingle(); texto += `🎰 Sorteo: ${sorteo?.nombre || pref.sorteo_id}\n`; if (sorteo) texto += `⏰ Horario: ${formatoHora(sorteo.hora_apertura)}-${formatoHora(sorteo.hora_cierre)}\n`; }
  try { const cliente = await buscarClienteWhatsApp(db, comercialId, jid); texto += `💰 Saldo: $${Number(cliente.saldo || 0).toFixed(2)}\n`; } catch (_) { texto += '👤 Cuenta: NO REGISTRADA\n'; }
  if (pref?.updated_at) texto += `🕒 Última selección: ${new Date(pref.updated_at).toLocaleString('es-CU', { timeZone: 'America/Havana' })}\n`;
  return sock.sendMessage(remoteJid, { text: texto });
}

async function registrarBetAtomica(db, args) {
  const { data, error } = await db.rpc('registrar_bet_comercial_atomica', {
    p_comercial_telegram_id: args.comercialId,
    p_cliente_banca_id: args.clienteBancaId,
    p_loteria_id: args.loteriaId,
    p_sorteo_id: args.sorteoId,
    p_fecha_apuesta: args.fecha,
    p_input_raw: args.inputRaw,
    p_total_apuesta: args.totalApuesta,
    p_detalle: args.detalle,
    p_moneda: args.moneda || 'cup'
  });
  if (error) throw error;
  const r = Array.isArray(data) ? data[0] : data;
  if (!r?.ok || !r.bet_id) throw new Error(r?.message || 'La base de datos no confirmó la apuesta.');
  return { id: Number(r.bet_id), saldoAntes: Number(r.saldo_antes || 0), credito: Number(r.credito || 0), saldoDespues: Number(r.saldo_despues || 0) };
}

async function validarSorteoAbierto(db, sorteoId, loteriaId) {
  const { data: sorteo, error } = await db.from('sorteos').select('id,nombre,loteria_id,hora_apertura,hora_cierre,activo').eq('id', sorteoId).maybeSingle();
  if (error) throw error;
  if (!sorteo || !sorteo.activo) throw new Error('El sorteo seleccionado no está activo.');
  if (Number(sorteo.loteria_id) !== Number(loteriaId)) throw new Error('El sorteo seleccionado no pertenece a la lotería elegida.');
  if (sorteo.hora_apertura && sorteo.hora_cierre) {
    const ahora = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const [ah, am] = String(sorteo.hora_apertura).slice(0,5).split(':').map(Number);
    const [ch, cm] = String(sorteo.hora_cierre).slice(0,5).split(':').map(Number);
    const [xh, xm] = ahora.split(':').map(Number);
    const actual = xh * 60 + xm;
    const apertura = ah * 60 + am;
    const cierre = ch * 60 + cm;
    const abierto = cierre >= apertura ? actual >= apertura && actual < cierre : actual >= apertura || actual < cierre;
    if (!abierto) throw new Error(`El sorteo ${sorteo.nombre} está cerrado. Horario: ${formatoHora(sorteo.hora_apertura)}-${formatoHora(sorteo.hora_cierre)} (Cuba).`);
  }
  return sorteo;}

async function sorteoSigueValido(db, loteriaId, sorteoId) {
  if (!loteriaId || !sorteoId) return null;

  const [{ data: loteria, error: loteriaError }, { data: sorteo, error: sorteoError }] = await Promise.all([
    db.from('loterias')
      .select('id,nombre,activo')
      .eq('id', Number(loteriaId))
      .maybeSingle(),
    db.from('sorteos')
      .select('id,nombre,loteria_id,hora_apertura,hora_cierre,activo')
      .eq('id', Number(sorteoId))
      .maybeSingle()
  ]);

  if (loteriaError) throw loteriaError;
  if (sorteoError) throw sorteoError;

  if (!loteria?.activo || !sorteo?.activo) return null;
  if (Number(sorteo.loteria_id) !== Number(loteria.id)) return null;
  if (!sorteoEstaAbiertoAhora(sorteo)) return null;

  return {
    loteriaNombre: String(loteria.nombre || loteria.id),
    sorteoNombre: String(sorteo.nombre || sorteo.id),
    hora_apertura: sorteo.hora_apertura,
    hora_cierre: sorteo.hora_cierre
  };
}

async function procesarJugadaWhatsApp({ comercialId, texto, senderJid, alternateJid = null }) {
  const db = supa();
  const textoOriginal = String(texto || '').trim();

  // Telegram y WhatsApp deben entregar exactamente la misma entrada lógica
  // al motor. Telegram normaliza esto en bet-bootstrap.js; WhatsApp lo hace
  // aquí antes de Engine.calcular().
  const textoProcesable = normalizarEntradaJugada(textoOriginal);
  const ambiguos = detectarNumerosAmbiguos(textoProcesable);
  if (ambiguos.length) {
    const error = new Error(
      'Jugada requiere atención humana. Se detectó un número ambiguo de 4 cifras: ' +
      ambiguos.join(', ') +
      '. No se calculó ni se descontó saldo.'
    );
    error.code = 'AMBIGUOUS_BET';
    error.ambiguousNumbers = ambiguos;
    throw error;
  }

  const cliente = await buscarClienteWhatsApp(db, comercialId, senderJid, alternateJid);
  const saldo = Number(cliente.saldo || 0);
  const pref = await obtenerPreferenciaWhatsApp(db, comercialId, senderJid);
  if (!pref?.loteria_id || !pref?.sorteo_id) {
    throw new Error('Primero debes seleccionar la lotería y el sorteo antes de enviar una jugada. Usa /loterias.');
  }

  const sorteo = await validarSorteoAbierto(db, pref.sorteo_id, pref.loteria_id);
  const Engine = global.Engine, Preprocesador = global.Preprocesador, Utils = global.Utils, Expansion = global.Expansion;
  if (!Engine?.calcular || !Preprocesador?.preprocesarJugada || !Utils?.limpiarMonto || !Expansion) {
    throw new Error('Motor LotoPro no disponible.');
  }

  const result = Engine.calcular(
    { rawInput: textoProcesable, loteriaId: pref.loteria_id, sorteoId: pref.sorteo_id },
    {
      Expansion,
      limpiarMonto: Utils.limpiarMonto,
      preprocesarJugada: Preprocesador.preprocesarJugada,
      obtenerTimestampLocal: () => new Date().toISOString()
    }
  );

  if (!result?.ok || !result.certified) {
    const detail = (result?.errors || [])
      .map(e => e.message || e.reason)
      .filter(Boolean)
      .join('\n');
    throw new Error((result?.message || 'La jugada no pudo procesarse.') + (detail ? '\n' + detail : ''));
  }

  const total = Number(result.totalGeneral || 0);
  const totalDeclarado = extraerTotalDeclarado(textoOriginal);
  const diferenciaTotal = totalDeclarado !== null
    ? Number((totalDeclarado - total).toFixed(2))
    : 0;
  const hayDiferenciaTotal = totalDeclarado !== null && Math.abs(diferenciaTotal) > 0.001;

  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('La jugada no tiene un monto válido.');
  }

  // Misma validación acumulativa que Telegram, antes de tocar el saldo.
  const fecha = fechaCuba();
  const detalle = (result.jugadas || []).flatMap(j => j.jugadas_detalle || []);
  const limite = await validarLimites(db, pref.loteria_id, pref.sorteo_id, fecha, detalle);
  if (limite) {
    const error = new Error(
      'Límite excedido.\n\n' +
      'Número: ' + limite.numero + '\n' +
      'Tipo: ' + limite.tipo + '\n' +
      'Acumulado anterior: $' + Number(limite.anterior).toFixed(2) + '\n' +
      'Esta jugada: $' + Number(limite.actual).toFixed(2) + '\n' +
      'Límite: $' + Number(limite.limite).toFixed(2) + '\n\n' +
      'La jugada no fue guardada.'
    );
    error.code = 'BET_LIMIT_EXCEEDED';
    error.limit = limite;
    throw error;
  }

  // La comprobación local permite responder inmediatamente, pero el RPC
  // sigue siendo la autoridad atómica sobre el saldo.
  if (saldo < total) {
    const error = new Error(
      'Saldo insuficiente. Disponible: $' + saldo.toFixed(2) +
      ', necesario: $' + total.toFixed(2) +
      '. Te faltan: $' + Math.max(0, total - saldo).toFixed(2) + '.'
    );
    error.code = 'INSUFFICIENT_BALANCE';
    error.saldoDisponible = saldo;
    error.totalRequerido = total;
    error.faltante = Math.max(0, total - saldo);
    error.loteriaId = pref.loteria_id;
    error.sorteoId = pref.sorteo_id;
    throw error;
  }

  const registro = await registrarBetAtomica(db, {
    comercialId,
    clienteBancaId: cliente.id,
    loteriaId: pref.loteria_id,
    sorteoId: pref.sorteo_id,
    fecha,
    inputRaw: textoOriginal,
    totalApuesta: total,
    detalle: JSON.stringify(detalle),
    moneda: pref.moneda || 'cup'
  });

  return {
    bets: [{
      id: registro.id,
      nombre: cliente.nombre,
      total,
      credito: registro.credito,
      saldoAntes: registro.saldoAntes,
      saldoDespues: registro.saldoDespues
    }],
    total,
    totalDeclarado,
    diferenciaTotal,
    hayDiferenciaTotal,
    sorteo: sorteo.nombre,
    loteriaId: pref.loteria_id,
    sorteoId: pref.sorteo_id,
    loteriaNombre: (await db.from('loterias').select('nombre').eq('id', pref.loteria_id).maybeSingle()).data?.nombre || String(pref.loteria_id),
    textoOriginal
  };
}


const WA_PENDING_BALANCE_PREFIX = 'WA_INSUFFICIENT_BALANCE_PENDING:';

function codificarPendienteSaldo({ loteriaId, sorteoId, total, saldoDisponible, faltante }) {
  return [
    WA_PENDING_BALANCE_PREFIX,
    'loteria=' + Number(loteriaId),
    'sorteo=' + Number(sorteoId),
    'total=' + Number(total).toFixed(2),
    'saldo=' + Number(saldoDisponible).toFixed(2),
    'faltante=' + Number(faltante).toFixed(2)
  ].join('|');
}

function decodificarPendienteSaldo(errorTexto) {
  const raw = String(errorTexto || '');
  if (!raw.startsWith(WA_PENDING_BALANCE_PREFIX)) return null;
  const result = {};
  for (const parte of raw.slice(WA_PENDING_BALANCE_PREFIX.length).split('|')) {
    const [clave, ...resto] = parte.split('=');
    if (clave) result[clave] = resto.join('=');
  }
  const loteriaId = Number(result.loteria);
  const sorteoId = Number(result.sorteo);
  const total = Number(result.total);
  const saldoDisponible = Number(result.saldo);
  const faltante = Number(result.faltante);
  if (![loteriaId, sorteoId, total, saldoDisponible, faltante].every(Number.isFinite)) return null;
  return { loteriaId, sorteoId, total, saldoDisponible, faltante };
}

async function enviarOpcionesRecargaWhatsApp(sock, remoteJid, pendingId, total, saldoDisponible, faltante) {
  const texto = [
    '💰 SALDO INSUFICIENTE',
    '',
    'La jugada fue calculada, pero tu saldo no alcanza.',
    '',
    '💵 Total de la jugada: $' + Number(total).toFixed(2),
    '💳 Saldo disponible: $' + Number(saldoDisponible).toFixed(2),
    '❗ Falta: $' + Number(faltante).toFixed(2),
    '',
    'La jugada quedó guardada automáticamente como pendiente.',
    'Recarga al menos el monto faltante y, cuando el comercial confirme la recarga, la jugada se procesará automáticamente.',
    '',
    'Jugada pendiente #' + pendingId
  ].join('\n');
  const fallback = texto + '\n\n💰 Para recargar escribe /depositar';
  try {
    await sendNative(sock, remoteJid, '💰 Saldo insuficiente', [
      { name: 'quick_reply', params: { display_text: '💰 Recargar saldo', id: '/depositar' } }
    ], fallback);
    return true;
  } catch (e) {
    console.warn('[WA SALDO] menú de recarga falló:', e?.message || e);
    await sock.sendMessage(remoteJid, { text: fallback }).catch(() => {});
    return false;
  }
}

async function procesarPendientesSaldoWhatsApp(db, sock, comercialId, whatsappJid) {
  const jid = String(whatsappJid || '').trim();
  if (!jid) return 0;
  const { data: pendientes, error } = await db.from('whatsapp_inbox')
    .select('id,texto,remote_jid,sender_jid,error,procesado,created_at')
    .eq('comercial_telegram_id', Number(comercialId))
    .eq('sender_jid', jid)
    .like('error', WA_PENDING_BALANCE_PREFIX + '%')
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) {
    console.error('[WA SALDO] No se pudieron cargar jugadas pendientes:', error);
    return 0;
  }
  let procesadas = 0;
  for (const pending of pendientes || []) {
    if (pending.procesado) continue;
    const meta = decodificarPendienteSaldo(pending.error);
    if (!meta) continue;
    const prefActual = await obtenerPreferenciaWhatsApp(db, comercialId, jid).catch(() => null);
    try {
      await guardarPreferenciaWhatsApp(db, comercialId, jid, {
        loteria_id: meta.loteriaId,
        sorteo_id: meta.sorteoId,
        moneda: prefActual?.moneda || 'cup'
      });
      const r = await procesarJugadaWhatsApp({
        comercialId,
        texto: String(pending.texto || ''),
        senderJid: jid,
        alternateJid: pending.remote_jid || jid
      });
      await db.from('whatsapp_inbox').update({
        procesado: true,
        bet_ids: r.bets.map(b => b.id),
        error: null
      }).eq('id', pending.id);
      const b = r.bets[0];
      await sock.sendMessage(pending.remote_jid || jid, {
        text: [
          '✅ JUGADA PENDIENTE PROCESADA',
          '',
          '🧾 Jugada #' + b.id,
          '📝 ' + r.textoOriginal,
          '',
          '💵 Total cobrado: $' + r.total.toFixed(2),
          '💰 Saldo restante: $' + b.saldoDespues.toFixed(2),
          '🎲 ' + r.loteriaNombre,
          '🎰 ' + r.sorteo,
          '',
          'La recarga ya fue aplicada y la jugada quedó registrada correctamente.'
        ].join('\n')
      }).catch(() => {});
      // Esta notificación es secundaria. Nunca debe bloquear el procesamiento
    // de la siguiente jugada del cliente si WhatsApp tiene un problema de sesión,
    // cifrado o entrega al chat propio del comercial.
    notificarComercialJugadaWhatsApp(sock, db, comercialId, b.id)
      .catch(e => console.error('[WA JUGADA] notificación secundaria falló:', e?.message || e));
      procesadas++;
    } catch (err) {
      if (err?.code === 'INSUFFICIENT_BALANCE') {
        await db.from('whatsapp_inbox').update({
          error: codificarPendienteSaldo({
            loteriaId: meta.loteriaId,
            sorteoId: meta.sorteoId,
            total: Number(err.totalRequerido || meta.total),
            saldoDisponible: Number(err.saldoDisponible || 0),
            faltante: Number(err.faltante || 0)
          })
        }).eq('id', pending.id);
        break;
      }
      console.error('[WA SALDO] Error procesando pendiente #' + pending.id + ':', err?.message || err);
      break;
    } finally {
      if (prefActual) {
        await guardarPreferenciaWhatsApp(db, comercialId, jid, {
          loteria_id: prefActual.loteria_id || null,
          sorteo_id: prefActual.sorteo_id || null,
          moneda: prefActual.moneda || 'cup'
        }).catch(() => {});
      }
    }
  }
  return procesadas;
}

function extraerTotalDeclarado(texto) {
  const raw = String(texto || '');
  const matches = [...raw.matchAll(/(?:^|\n)\s*total\s*[:=]?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)/gim)];
  if (!matches.length) return null;
  const valor = Number(String(matches[matches.length - 1][1] || '').replace(',', '.'));
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

function fechaCuba() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Havana' }).format(new Date()); }

async function enviarListaJugadas(bot, db, ctx) {
  const role = await commercialRole(db, ctx.from.id);
  if (!['comercial', 'admin'].includes(role)) return ctx.reply('⛔ Solo un comercial puede usar este comando.');
  const { data: pref } = await db.from('user_preferences').select('loteria_id,sorteo_id').eq('telegram_id', ctx.from.id).maybeSingle();
  if (!pref?.loteria_id || !pref?.sorteo_id) return ctx.reply('🎲 Primero selecciona la lotería y el sorteo con /start.');
  const { data: loteria } = await db.from('loterias').select('id,nombre').eq('id', pref.loteria_id).maybeSingle();
  const { data: sorteo } = await db.from('sorteos').select('id,nombre,hora_apertura,hora_cierre').eq('id', pref.sorteo_id).maybeSingle();
  if (!loteria || !sorteo) return ctx.reply('❌ La lotería o el sorteo seleccionado ya no existe. Usa /start.');
  const { data: bets, error } = await db.from('bets').select('id,input_raw,total_apuesta,moneda,created_at,cliente_banca_id').eq('comercial_telegram_id', ctx.from.id).eq('loteria_id', pref.loteria_id).eq('sorteo_id', pref.sorteo_id).eq('fecha_apuesta', fechaCuba()).order('created_at', { ascending: true });
  if (error) { console.error('lista jugadas error:', error); return ctx.reply('❌ No se pudo consultar la lista de jugadas.'); }
  if (!bets?.length) return ctx.reply(`📋 No hay jugadas para ${loteria.nombre} — ${sorteo.nombre} en la fecha de hoy.`);
  const ids = [...new Set(bets.map(b => b.cliente_banca_id).filter(Boolean))];
  const { data: clientes } = ids.length ? await db.from('clientes_banca').select('id,nombre,whatsapp_jid,saldo').in('id', ids) : { data: [] };
  const mapa = new Map((clientes || []).map(c => [Number(c.id), c]));
  const bloques = bets.map((b, i) => { const c = mapa.get(Number(b.cliente_banca_id)); const fechaHora = b.created_at ? new Date(b.created_at).toLocaleTimeString('es-CU', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit' }) : '--:--'; return `${i + 1}. 👤 ${c?.nombre || 'Cliente'}\n   🕒 ${fechaHora}\n   🧾 ${String(b.input_raw || '').slice(0, 700)}\n   💵 Total: $${Number(b.total_apuesta || 0).toFixed(2)} ${String(b.moneda || 'cup').toUpperCase()}\n   🆔 Apuesta #${b.id}`; });
  const encabezado = `📋 JUGADAS RECIBIDAS\n\n🎲 ${loteria.nombre}\n🎰 ${sorteo.nombre}\n⏰ ${formatoHora(sorteo.hora_apertura)}-${formatoHora(sorteo.hora_cierre)}\n📅 ${fechaCuba()}\n\n`;
  const chunks = []; let actual = encabezado;
  for (const bloque of bloques) { if ((actual + '\n\n' + bloque).length > 3900) { chunks.push(actual); actual = bloque; } else actual += (actual === encabezado ? '' : '\n\n') + bloque; }
  if (actual) chunks.push(actual);
  for (const chunk of chunks) await ctx.reply(chunk);
}


function minutosCuba() {
  const ahora = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = ahora.split(':').map(Number);
  return h * 60 + m;
}

function sorteoEstaAbiertoAhora(sorteo) {
  if (!sorteo?.hora_apertura || !sorteo?.hora_cierre) return false;
  const actual = minutosCuba();
  const [ah, am] = String(sorteo.hora_apertura).slice(0, 5).split(':').map(Number);
  const [ch, cm] = String(sorteo.hora_cierre).slice(0, 5).split(':').map(Number);
  const apertura = ah * 60 + am;
  const cierre = ch * 60 + cm;
  return cierre >= apertura ? actual >= apertura && actual < cierre : actual >= apertura || actual < cierre;
}

async function enviarMenuListaSorteosWhatsApp(db, sock, targetJid) {
  const { data: sorteos, error } = await db.from('sorteos')
    .select('id,nombre,hora_apertura,hora_cierre,activo,loteria_id')
    .eq('activo', true)
    .order('hora_apertura');
  if (error) throw error;
  if (!sorteos?.length) {
    await sock.sendMessage(targetJid, { text: 'ℹ️ No hay sorteos activos disponibles.' });
    return;
  }

  const loteriaIds = [...new Set(sorteos.map(s => s.loteria_id).filter(Boolean))];
  const { data: loterias, error: loteriasError } = loteriaIds.length
    ? await db.from('loterias').select('id,nombre').in('id', loteriaIds)
    : { data: [] };
  if (loteriasError) throw loteriasError;

  const loteriasMap = new Map((loterias || []).map(l => [Number(l.id), l.nombre]));
  const actualId = (sorteos.find(s => sorteoEstaAbiertoAhora(s)) || {}).id || null;

  const rows = sorteos.map(s => {
    const actual = Number(s.id) === Number(actualId);
    const loteria = loteriasMap.get(Number(s.loteria_id)) || 'Lotería';
    const horario = `${formatoHora(s.hora_apertura)}-${formatoHora(s.hora_cierre)}`;
    return {
      id: `/lista_sorteo ${s.id}`,
      title: `${actual ? '🟢 ' : '🎰 '}${loteria} — ${s.nombre}`.slice(0, 24),
      description: `${actual ? 'ACTUAL · ' : ''}${horario}`.slice(0, 72)
    };
  });

  const texto = [
    '📋 LISTA DE JUGADAS',
    '',
    actualId ? '🟢 El sorteo abierto ahora está marcado como ACTUAL.' : 'ℹ️ No hay un sorteo abierto ahora.',
    '',
    ...sorteos.map(s => {      const actual = Number(s.id) === Number(actualId);      const loteria = loteriasMap.get(Number(s.loteria_id)) || 'Lotería';
      return `${actual ? '🟢' : '🎰'} ${loteria} — ${s.nombre} · ${formatoHora(s.hora_apertura)}-${formatoHora(s.hora_cierre)}`;
    }),
    '',
    'Selecciona el sorteo del que quieres ver las jugadas.'
  ].join('\n');

  const quick = sorteos.slice(0, 3).map(s => {
    const actual = Number(s.id) === Number(actualId);
    const loteria = loteriasMap.get(Number(s.loteria_id)) || 'Lotería';
    return {
      name: 'quick_reply',
      params: {
        display_text: `${actual ? '🟢 ' : ''}${loteria} ${s.nombre}`.slice(0, 20),
        id: `/lista_sorteo ${s.id}`
      }
    };
  });

  if (sorteos.length <= 3) {
    return sendNative(sock, targetJid, '📋 LISTA DE JUGADAS\n\nSelecciona un sorteo:', quick, texto);
  }

  return sendNative(sock, targetJid, '📋 LISTA DE JUGADAS\n\nSelecciona un sorteo:', [
    { name: 'single_select', params: { title: 'Seleccionar sorteo', sections: [{ title: 'Sorteos disponibles', rows }] } }
  ], texto);
}

async function enviarListaJugadasWhatsApp(db, sock, comercialId, targetJid, sorteoId = null) {
  const fecha = fechaCuba();
  let sorteoSeleccionado = null;

  if (sorteoId !== null) {
    const { data, error } = await db.from('sorteos')
      .select('id,nombre,hora_apertura,hora_cierre,activo,loteria_id')
      .eq('id', Number(sorteoId))
      .eq('activo', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      await sock.sendMessage(targetJid, { text: '❌ El sorteo especificado no existe o está inactivo.' });
      return;
    }
    sorteoSeleccionado = data;
  } else {
    const { data: sorteos, error } = await db.from('sorteos')
      .select('id,nombre,hora_apertura,hora_cierre,activo,loteria_id')
      .eq('activo', true)
      .order('hora_apertura');
    if (error) throw error;
    sorteoSeleccionado = (sorteos || []).find(s => sorteoEstaAbiertoAhora(s)) || null;
    if (!sorteoSeleccionado) {
      await sock.sendMessage(targetJid, { text: 'ℹ️ No hay un sorteo abierto en este momento. Usa /lista para seleccionar el sorteo.' });
      return;
    }
  }

  const { data: bets, error } = await db.from('bets')
    .select('id,input_raw,total_apuesta,moneda,created_at,cliente_banca_id,loteria_id,sorteo_id')
    .eq('comercial_telegram_id', comercialId)
    .eq('fecha_apuesta', fecha)
    .eq('sorteo_id', Number(sorteoSeleccionado.id))
    .order('created_at', { ascending: true });
  if (error) throw error;

  const { data: loteria, error: loteriaError } = await db.from('loterias')
    .select('id,nombre').eq('id', Number(sorteoSeleccionado.loteria_id)).maybeSingle();
  if (loteriaError) throw loteriaError;

  if (!bets?.length) {
    await sock.sendMessage(targetJid, {
      text: String(loteria?.nombre || 'Lotería') + ' - ' + String(sorteoSeleccionado.nombre || 'Sorteo') +
        '\nFecha: ' + fecha + '\n\nNo hay jugadas registradas.'
    });
    return;
  }

  const totalGeneral = bets.reduce((sum, bet) => {
    const value = Number(bet.total_apuesta || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const encabezado = [
    String(loteria?.nombre || 'Lotería') + ' - ' + String(sorteoSeleccionado.nombre || 'Sorteo'),
    'Fecha: ' + fecha,
    bets.length + ' ' + (bets.length === 1 ? 'jugada' : 'jugadas') + ' | Total: $' + totalGeneral.toFixed(2),
    '',
    '༆࿐༵ ༆࿐༵ ༆࿐༵'
  ].join('\n');

  const bloques = bets.map(bet => {
    const raw = String(bet.input_raw || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\u2028|\u2029/g, '\n')
      .split('\n')
      .map(linea => linea.trim())
      .filter(Boolean)
      .join('\n');
    const total = Number(bet.total_apuesta || 0);

    return [
      raw || 'Jugada sin texto',
      'TOTAL : ' + total.toFixed(2),
      '──────────────────────────────'
    ].join('\n');
  });

  let texto = encabezado + '\n' + bloques.join('\n') + '\nTOTAL GENERAL: ' + totalGeneral.toFixed(2);

  const chunks = [];
  while (texto.length > 3900) {
    let corte = texto.lastIndexOf('\n', 3900);
    if (corte < 1000) corte = 3900;
    chunks.push(texto.slice(0, corte));
    texto = texto.slice(corte + 1);
  }
  if (texto) chunks.push(texto);

  for (let i = 0; i < chunks.length; i++) {
    await sock.sendMessage(targetJid, {
      text: chunks[i] + (chunks.length > 1 ? '\n\n📄 Parte ' + (i + 1) + '/' + chunks.length : '')
    });
  }
}

function promesaConTimeout(promise, ms, etiqueta) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(etiqueta + ' agotó el tiempo de espera (' + ms + ' ms).')), ms))
  ]);
}

async function notificarComercialJugadaWhatsApp(sock, db, comercialId, betId) {
  const targetJid = String(sock?.user?.id || '').trim();
  if (!targetJid || !betId) return false;
  try {
    const { data: bet, error } = await db.from('bets')
      .select('id,input_raw,total_apuesta,moneda,created_at,cliente_banca_id,loteria_id,sorteo_id')
      .eq('id', betId)
      .eq('comercial_telegram_id', comercialId)
      .maybeSingle();
    if (error) throw error;
    if (!bet) return false;
    const [{ data: cliente }, { data: loteria }, { data: sorteo }] = await Promise.all([
      bet.cliente_banca_id ? db.from('clientes_banca').select('nombre,whatsapp_jid').eq('id', bet.cliente_banca_id).maybeSingle() : Promise.resolve({ data: null }),
      bet.loteria_id ? db.from('loterias').select('nombre').eq('id', bet.loteria_id).maybeSingle() : Promise.resolve({ data: null }),
      bet.sorteo_id ? db.from('sorteos').select('nombre').eq('id', bet.sorteo_id).maybeSingle() : Promise.resolve({ data: null })
    ]);
    const hora = bet.created_at ? new Date(bet.created_at).toLocaleTimeString('es-CU', {
      timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit'
    }) : '--:--';
    const texto = [
      '🎰 NUEVA JUGADA RECIBIDA', '',
      '🧾 Apuesta #' + bet.id,
      '👤 Cliente: ' + (cliente?.nombre || 'Sin nombre'),
      '📱 WhatsApp: ' + (cliente?.whatsapp_jid || 'N/D'),
      '🎲 ' + (loteria?.nombre || bet.loteria_id || 'Lotería') + ' — ' + (sorteo?.nombre || bet.sorteo_id || 'Sorteo'),
      '🕒 Hora: ' + hora, '',
      '📝 ' + String(bet.input_raw || '').slice(0, 1000), '',
      '💵 Total: $' + Number(bet.total_apuesta || 0).toFixed(2) + ' ' + String(bet.moneda || 'cup').toUpperCase()
    ].join('\n');
    await promesaConTimeout(
      sock.sendMessage(targetJid, { text: texto }),
      8000,
      '[WA JUGADA] envío al comercial'
    );
    console.log('[WA JUGADA] notificación enviada al comercial target=' + targetJid + ' bet=' + bet.id);
    return true;
  } catch (error) {
    console.error('[WA JUGADA] no se pudo notificar al comercial:', error?.stack || error);
    return false;
  }
}

async function recibirMensaje(db, sock, comercialId, message) {
  if (!message?.key?.id) return;

  // El comercial recibe las solicitudes de recarga de clientes WhatsApp
  // en el chat privado de su propio WhatsApp. Ese mensaje y los botones
  // pueden regresar como fromMe=true, por lo que se procesa únicamente
  // si contiene una orden explícita de aprobar/rechazar una recarga WA.
  if (await mensajeEsPropio(sock, message)) {
    const interactiveId = adaptIncomingInteractive(message);
    // Los comandos de configuracion pueden ejecutarse dentro de un grupo.
    // El flujo normal de clientes sigue ignorando mensajes de grupos.
    const textoSelf = interactiveId || textFromMessageAnyChat(message);
    const commandSelf = normalizeCommand(textoSelf);
    const aprobarSelf = commandSelf.match(/^\/aprobar_recarga\s+(\d+)$/);
    const rechazarSelf = commandSelf.match(/^\/rechazar_recarga\s+(\d+)$/);

    if (commandSelf === '/probar_resultado') {
      const targetJid = String(message.key.remoteJid || '').trim();
      if (!targetJid.endsWith('@g.us')) {
        await sock.sendMessage(targetJid || sock.user?.id, {
          text: '⚠️ Ejecuta /probar_resultado dentro del grupo de WhatsApp asignado para resultados.'
        }).catch(() => {});
        return;
      }

      try {
        const sender = require('./lib/whatsapp-sender');
        const prueba = await sender.probarResultadoWhatsapp(db, comercialId);
        await sock.sendMessage(targetJid, {
          text: [
            '🧪 PRUEBA DE RESULTADOS ENCOLADA',
            '',
            '👥 Grupo: ' + (prueba.nombre || 'Grupo de resultados'),
            '🆔 ' + prueba.destinoId,
            '',
            'La prueba fue guardada en el outbox y se intentará enviar por el transporte WhatsApp comercial.',
            '',
            'Si recibes el mensaje 🧪 PRUEBA DE RESULTADOS WHATSAPP, el flujo de outbox está funcionando correctamente.'
          ].join('\\n')
        }).catch(() => {});
      } catch (e) {
        console.error('[WA PRUEBA RESULTADO] error:', e?.stack || e);
        await sock.sendMessage(targetJid, {
          text: '❌ No se pudo ejecutar la prueba: ' + (e?.message || e)
        }).catch(() => {});
      }
      return;
    }

    // Configuración del grupo de resultados del propio comercial.
    // Se ejecuta desde el WhatsApp comercial: basta enviar el comando dentro
    // del grupo que se quiere asignar.
    const comandosAsignarGrupo = new Set(['/wa_grupo_resultados', '/asignargrupo', '/asignar_grupo']);

    if (comandosAsignarGrupo.has(commandSelf)) {
      const targetJid = String(message.key.remoteJid || '').trim();
      if (!targetJid.endsWith('@g.us')) {
        await sock.sendMessage(targetJid || sock.user?.id, {
          text: '⚠️ Este comando debe enviarse dentro del grupo de WhatsApp que quieres asignar para recibir resultados y premios.'
        }).catch(() => {});
        return;
      }
      try {
        let nombreGrupo = null;
        try {
          const metadata = await sock.groupMetadata(targetJid);
          nombreGrupo = String(metadata?.subject || '').trim() || null;
        } catch (_) {}
        const grupo = await guardarGrupoResultadosComercial(db, comercialId, targetJid, nombreGrupo);
        await sock.sendMessage(targetJid, {
          text: [
            '✅ GRUPO DE RESULTADOS ASIGNADO',
            '',
            '👤 Comercial: ' + comercialId,
            '👥 ' + (nombreGrupo || 'Grupo WhatsApp'),
            '🆔 ' + grupo.destino_id,
            '',
            'Este grupo recibirá:',
            '🎲 resultados de los sorteos',
            '🏆 premios correspondientes a las jugadas de este comercial',
            '',
            'No necesitas copiar el ID manualmente.',
            'Para cambiarlo, ejecuta /asignargrupo dentro del nuevo grupo.'
          ].join('\n')
        }).catch(() => {});
      } catch (e) {
        console.error('[WA RESULTADOS] No se pudo asignar grupo al comercial ' + comercialId + ':', e?.message || e);
        await sock.sendMessage(targetJid, { text: '❌ No se pudo asignar este grupo: ' + (e?.message || e) }).catch(() => {});
      }
      return;
    }

    if (commandSelf === '/idgrupo' || commandSelf === '/id_grupo') {
      const targetJid = String(message.key.remoteJid || '').trim();
      if (!targetJid.endsWith('@g.us')) {
        await sock.sendMessage(targetJid || sock.user?.id, { text: '⚠️ Ejecuta /idgrupo dentro del grupo cuyo ID quieres consultar.' }).catch(() => {});
        return;
      }
      let nombreGrupo = null;
      try {
        const metadata = await sock.groupMetadata(targetJid);
        nombreGrupo = String(metadata?.subject || '').trim() || null;
      } catch (_) {}
      await sock.sendMessage(targetJid, {
        text: [
          '🆔 ID DEL GRUPO',
          '',
          '👥 ' + (nombreGrupo || 'Grupo WhatsApp'),
          '🆔 ' + targetJid,
          '',
          'Para asignarlo al comercial usa:',
          '/asignargrupo'
        ].join('\n')
      }).catch(() => {});
      return;
    }

    if (commandSelf === '/mi_grupo' || commandSelf === '/migrupo') {
      const targetJid = String(message.key.remoteJid || '').trim();
      try {
        const grupo = await leerGrupoResultadosComercial(db, comercialId);
        await sock.sendMessage(targetJid || sock.user?.id, {
          text: grupo?.activo
            ? ['📢 GRUPO DE RESULTADOS ACTUAL', '', '👥 ' + (grupo.nombre || 'Grupo WhatsApp'), '🆔 ' + grupo.destino_id].join('\n')
            : 'ℹ️ No tienes un grupo de resultados asignado.'
        }).catch(() => {});
      } catch (e) {
        await sock.sendMessage(targetJid || sock.user?.id, { text: '❌ No se pudo consultar el grupo: ' + (e?.message || e) }).catch(() => {});
      }
      return;
    }

    if (commandSelf === '/wa_ver_grupo_resultados') {
      const targetJid = String(message.key.remoteJid || '').trim();
      try {
        const grupo = await leerGrupoResultadosComercial(db, comercialId);
        await sock.sendMessage(targetJid || sock.user?.id, {
          text: grupo?.activo ? '📢 Grupo de resultados actual: ' + grupo.destino_id : 'ℹ️ No tienes un grupo de resultados asignado.'
        }).catch(() => {});
      } catch (e) {
        await sock.sendMessage(targetJid || sock.user?.id, { text: '❌ No se pudo consultar el grupo: ' + (e?.message || e) }).catch(() => {});
      }
      return;
    }
    const listaMenu = commandSelf.match(/^\/(lista|jugadas)$/);
    if (listaMenu) {
      const targetJid = String(message.key.remoteJid || '').trim();
      if (!targetJid || targetJid === 'status@broadcast') return;
      try {
        await enviarMenuListaSorteosWhatsApp(db, sock, targetJid);
      } catch (e) {
        console.error('[WA JUGADAS] error generando menú de sorteos:', e?.stack || e);
        await sock.sendMessage(targetJid, {
          text: `❌ No se pudo mostrar el menú de sorteos.\n\n${e?.message || e}`
        }).catch(() => {});
      }
      return;
    }

    const listaSorteoMatch = commandSelf.match(/^\/lista_sorteo\s+(\d+)$/);
    if (listaSorteoMatch) {
      const targetJid = String(message.key.remoteJid || '').trim();
      if (!targetJid || targetJid === 'status@broadcast') return;
      try {
        await enviarListaJugadasWhatsApp(db, sock, comercialId, targetJid, Number(listaSorteoMatch[1]));
      } catch (e) {
        console.error('[WA JUGADAS] error generando lista:', e?.stack || e);        await sock.sendMessage(targetJid, {
          text: `❌ No se pudo generar la lista de jugadas.\n\n${e?.message || e}`
        }).catch(() => {});
      }
      return;
    }

    if (!aprobarSelf && !rechazarSelf) return;

    const requestId = Number((aprobarSelf || rechazarSelf)[1]);
    try {
      const result = await resolverSolicitudWhatsApp(
        sock,
        comercialId,
        requestId,
        aprobarSelf ? 'aprobar' : 'rechazar'
      );

      if (aprobarSelf && result?.status === 'approved' && result?.request?.whatsapp_jid) {
        const procesadas = await procesarPendientesSaldoWhatsApp(
          db,
          sock,
          comercialId,
          result.request.whatsapp_jid
        );
        if (procesadas > 0) {
          console.log('[WA SALDO] Recarga #' + requestId + ' reanudó ' + procesadas + ' jugada(s) pendiente(s).');
        }
      }

      await sock.sendMessage(String(message.key.remoteJid || sock.user?.id || '').trim(), {
        text: aprobarSelf
          ? `✅ Recarga #${requestId} aprobada.\n💰 Acreditado: ${result.request.amount}\n💵 Nuevo saldo: ${result.saldoDespues.toFixed(2)}`
          : `❌ Recarga #${requestId} rechazada.`
      }).catch(() => {});
    } catch (e) {
      console.error('[WA DEPOSITO] decisión del comercial por WhatsApp:', e);
      await sock.sendMessage(String(message.key.remoteJid || sock.user?.id || '').trim(), {
        text: `❌ No se pudo procesar la recarga #${requestId}.\n\n${e?.message || e}`
      }).catch(() => {});
    }
    return;
  }

  // El depósito se procesa aquí, dentro del listener principal de Baileys.
  try {
    if (await procesarMensajeDeposito(sock, comercialId, message)) return;
  } catch (e) {
    console.error('[WA DEPOSITO] error en listener principal:', e);
  }

  const interactiveId = adaptIncomingInteractive(message);
  const texto = interactiveId || textFromMessage(message);
  if (!texto) return;
  const remoteJid = String(message.key.remoteJid || '').trim(); if (!remoteJid || remoteJid === 'status@broadcast') return;
  const senderPn = String(message.key.senderPn || message.key.participantPn || '').trim();
  const rawSenderJid = senderPn.endsWith('@s.whatsapp.net')
    ? senderPn
    : String(message.key.participant || remoteJid).trim();
  const interactiveJid = senderPn.endsWith('@s.whatsapp.net') ? senderPn : null;

  const aliasRemoteKey = bettingChatKey(comercialId, remoteJid);
  const aliasSenderKey = bettingChatKey(comercialId, rawSenderJid || remoteJid);
  const senderJid = waIdentityAliases.get(aliasRemoteKey)
    || waIdentityAliases.get(aliasSenderKey)
    || rawSenderJid
    || remoteJid;

  waIdentityAliases.set(aliasRemoteKey, senderJid);
  waIdentityAliases.set(aliasSenderKey, senderJid);

  const key = bettingChatKey(comercialId, senderJid || remoteJid);
  const command = normalizeCommand(texto);

  if (command === '/registrar' || command === '/registro') {
    registrationStates.set(key, { comercialId, senderJid, remoteJid });
    await sock.sendMessage(remoteJid, {
      text: '📝 REGISTRO DE CLIENTE\n\nEscribe ahora tu nombre. Ese nombre quedará vinculado a este WhatsApp con este comercial.\n\nEjemplo: Juan Pérez'
    });
    return;
  }

  const registrationState = registrationStates.get(key);
  if (registrationState && !command.startsWith('/')) {
    const nombre = String(texto || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!nombre) {
      await sock.sendMessage(remoteJid, { text: '❌ Debes escribir un nombre válido.' });
      return;
    }

    try {
      const candidatos = [...new Set([senderJid, remoteJid].filter(Boolean))];
      const orExact = candidatos.map(jid => `whatsapp_jid.eq.${jid}`).join(',');
      const { data: porWhatsApp, error: whatsappError } = await db
        .from('clientes_banca')
        .select('id,nombre,whatsapp_jid')
        .eq('comercial_telegram_id', comercialId)
        .or(orExact)
        .limit(2);
      if (whatsappError) throw whatsappError;

      if ((porWhatsApp || []).length > 1) {
        throw new Error('Este WhatsApp tiene más de un registro con el comercial. Debe revisarlo el comercial.');
      }

      if ((porWhatsApp || []).length === 1) {
        const cliente = porWhatsApp[0];
        const { data: actualizado, error } = await db
          .from('clientes_banca')
          .update({ nombre, whatsapp_jid: senderJid, updated_at: new Date().toISOString() })
          .eq('id', cliente.id)
          .select('id,nombre,saldo,whatsapp_jid')
          .single();
        if (error) throw error;
        registrationStates.delete(key);
        await sock.sendMessage(remoteJid, {
          text: `✅ Registro actualizado.\n\n👤 Cliente: ${actualizado.nombre}\n📱 WhatsApp vinculado correctamente.\n💰 Saldo: ${Number(actualizado.saldo || 0).toFixed(2)}\n\nAhora puedes usar /depositar para solicitar una recarga.`
        });
        return;
      }

      const { data: porNombre, error: nombreError } = await db
        .from('clientes_banca')
        .select('id,nombre,whatsapp_jid')
        .eq('comercial_telegram_id', comercialId)
        .eq('nombre', nombre)
        .limit(1);
      if (nombreError) throw nombreError;

      if ((porNombre || []).length === 1) {
        const cliente = porNombre[0];
        if (cliente.whatsapp_jid && String(cliente.whatsapp_jid) !== senderJid) {
          throw new Error('Ya existe un cliente con ese nombre vinculado a otro WhatsApp. Usa otro nombre o habla con el comercial.');
        }

        const { data: actualizado, error } = await db
          .from('clientes_banca')
          .update({ whatsapp_jid: senderJid, updated_at: new Date().toISOString() })
          .eq('id', cliente.id)
          .select('id,nombre,saldo,whatsapp_jid')
          .single();
        if (error) throw error;
        registrationStates.delete(key);
        await sock.sendMessage(remoteJid, {
          text: `✅ Registro completado.\n\n👤 Cliente: ${actualizado.nombre}\n📱 WhatsApp vinculado correctamente.\n💰 Saldo: ${Number(actualizado.saldo || 0).toFixed(2)}\n\nAhora puedes usar /depositar para solicitar una recarga.`
        });
        return;
      }

      const { data: nuevo, error: insertError } = await db
        .from('clientes_banca')
        .insert([{          comercial_telegram_id: Number(comercialId),
          nombre,
          saldo: 0,
          whatsapp_jid: senderJid
        }])
        .select('id,nombre,saldo,whatsapp_jid')
        .single();
      if (insertError) throw insertError;

      registrationStates.delete(key);
      await sock.sendMessage(remoteJid, {
        text: `✅ Registro completado.\n\n👤 Cliente: ${nuevo.nombre}\n📱 WhatsApp vinculado correctamente.\n💰 Saldo: ${Number(nuevo.saldo || 0).toFixed(2)}\n\nAhora puedes usar /depositar para solicitar una recarga.`
      });
    } catch (e) {
      console.error('[WA REGISTRO] error:', e);
      registrationStates.delete(key);
      await sock.sendMessage(remoteJid, { text: `❌ No se pudo completar el registro.\n\n${String(e?.message || e)}\n\nSi ya estás registrado con el comercial, usa /saldo o /depositar.` });
    }
    return;
  }

  if (command === '/jugar') {
    const ahora = Date.now();
    const ultimoJugar = jugarCooldowns.get(key) || 0;
    if (ahora - ultimoJugar < JUGAR_COOLDOWN_MS) return;
    jugarCooldowns.set(key, ahora);

    activeBettingChats.add(key);
    waIdentityAliases.set(aliasRemoteKey, senderJid);
    waIdentityAliases.set(aliasSenderKey, senderJid);
    programarSalidaAutomaticaWhatsApp(sock, db, comercialId, senderJid, remoteJid, key);

    try {
      const prefPrevia = await obtenerPreferenciaWhatsApp(
        db,
        comercialId,
        senderJid
      );

      const valida = prefPrevia?.loteria_id && prefPrevia?.sorteo_id
        ? await sorteoSigueValido(
            db,
            prefPrevia.loteria_id,
            prefPrevia.sorteo_id
          )
        : null;

      if (valida) {
        await sock.sendMessage(remoteJid, {
          text:
            `▶️ *Sesión reanudada*\\n\\n` +
            `🎲 ${valida.loteriaNombre}\\n` +
            `🎰 ${valida.sorteoNombre}\\n` +
            `⏰ ${formatoHora(valida.hora_apertura)}-${formatoHora(valida.hora_cierre)}\\n\\n` +
            `Ya puedes escribir tu jugada.\\n\\n` +
            `Para cambiar: /loterias o /sorteos`
        });

        return;
      }

      // La selección anterior ya no es utilizable (inactiva, inconsistente
      // o fuera de horario). En ese caso sí limpiamos la preferencia y
      // mostramos nuevamente el menú.
      await reiniciarSesionWhatsApp(db, comercialId, senderJid);
    } catch (e) {
      activeBettingChats.delete(key);
      cancelarSalidaAutomatica(key);
      console.error(
        `No se pudo preparar sesión WhatsApp ${comercialId}/${senderJid}:`,
        e
      );
      return sock.sendMessage(remoteJid, {
        text: '❌ No pude iniciar una sesión de juego segura. Inténtalo nuevamente.'
      });
    }

    await sendMainMenu(sock, remoteJid, interactiveJid);
    return;
  }

  if (command === '/salir') {
    activeBettingChats.delete(key);
    cancelarSalidaAutomaticaWhatsApp(key);
    waIdentityAliases.delete(aliasRemoteKey);
    waIdentityAliases.delete(aliasSenderKey);
    await reiniciarSesionWhatsApp(db, comercialId, senderJid).catch(() => {});
    await sock.sendMessage(remoteJid, { text: '✅ Modo jugada desactivado y selección borrada.\n\nCuando quieras jugar de nuevo escribe /jugar.' });
    return;
  }

  if (command === '/saldo') { await enviarEstadoCliente(sock, remoteJid, db, comercialId, senderJid); return; }
  if (command === '/depositar' || command === '/recargar') return;

  // Cualquier interacción válida dentro del modo jugada mantiene viva la
  // sesión, incluidos los menús /loterias, /sorteos y sus selecciones.
  if (activeBettingChats.has(key)) {
    programarSalidaAutomaticaWhatsApp(sock, db, comercialId, senderJid, remoteJid, key);
  }

  if (command === '/loterias' || command === '/loteria') { await enviarSeleccionLoterias(sock, remoteJid, db, interactiveJid); return; }
  const loteriaMatch = command.match(/^\/loteria\s+(\d+)$/);
  if (loteriaMatch) {
    const loteriaId = Number(loteriaMatch[1]);
    const { data: loteria } = await db.from('loterias').select('id,nombre').eq('id', loteriaId).eq('activo', true).maybeSingle();
    if (!loteria) return sock.sendMessage(remoteJid, { text: '❌ Lotería no encontrada o inactiva. Usa /loterias.' });
    const guardar = guardarPreferenciaWhatsApp(db, comercialId, senderJid, { loteria_id: loteria.id, sorteo_id: null });
    const menuSorteos = enviarSeleccionSorteos(sock, remoteJid, db, loteria.id, interactiveJid, loteria);
    await Promise.all([guardar, menuSorteos]);
    return;
  }

  if (command === '/sorteos') {
    const pref = await obtenerPreferenciaWhatsApp(db, comercialId, senderJid);
    if (!pref?.loteria_id) return sock.sendMessage(remoteJid, { text: '🎲 Primero selecciona una lotería con /loterias.' });
    await enviarSeleccionSorteos(sock, remoteJid, db, pref.loteria_id, interactiveJid);
    return;
  }

  const sorteoMatch = command.match(/^\/sorteo\s+(\d+)$/);
  if (sorteoMatch) {
    const pref = await obtenerPreferenciaWhatsApp(db, comercialId, senderJid);
    if (!pref?.loteria_id) return sock.sendMessage(remoteJid, { text: '🎲 Primero selecciona una lotería con /loterias.' });
    const sorteoId = Number(sorteoMatch[1]);
    const { data: sorteo } = await db.from('sorteos').select('id,nombre,hora_apertura,hora_cierre,activo,loteria_id').eq('id', sorteoId).eq('loteria_id', pref.loteria_id).eq('activo', true).maybeSingle();
    if (!sorteo) return sock.sendMessage(remoteJid, { text: '❌ Sorteo no encontrado para la lotería seleccionada. Usa /sorteos.' });
    const guardar = guardarPreferenciaWhatsApp(db, comercialId, senderJid, { loteria_id: pref.loteria_id, sorteo_id: sorteo.id, moneda: pref.moneda || 'cup' });
    const { data: loteria } = await db.from('loterias').select('nombre').eq('id', pref.loteria_id).maybeSingle();
    await guardar;
    await sendConfirmationMenu(sock, remoteJid, loteria?.nombre || String(pref.loteria_id), sorteo.nombre, formatoHora(sorteo.hora_apertura) + '-' + formatoHora(sorteo.hora_cierre), interactiveJid);
    return;
  }

  if (command === '/estado') { await enviarEstadoCliente(sock, remoteJid, db, comercialId, senderJid); return; }
  if (!activeBettingChats.has(key)) {
    console.log('ℹ️ WA ' + comercialId + ': mensaje ignorado fuera de sesión jid=' + remoteJid + ' sender=' + senderJid + ' text=' + JSON.stringify(texto.slice(0, 100)));
    return;
  }

  // Cada interacción mantiene viva la sesión; si el cliente se queda inactivo,
  // el temporizador ejecutará la misma limpieza que /salir.
  programarSalidaAutomaticaWhatsApp(sock, db, comercialId, senderJid, remoteJid, key);

  const { data: inserted, error } = await db.from('whatsapp_inbox').insert([{ comercial_telegram_id: comercialId, message_id: String(message.key.id), remote_jid: remoteJid, sender_jid: senderJid || null, sender_name: senderName(message) || null, texto }]).select('id').single();
  if (error) { if (String(error.message || '').toLowerCase().includes('duplicate')) return; console.error('WhatsApp inbox error:', error); return; }  await db.from('whatsapp_comercial_session').update({ ultimo_mensaje_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('comercial_telegram_id', comercialId);

  try {
    const r = await procesarJugadaWhatsApp({ comercialId, texto, senderJid, alternateJid: remoteJid });
    await db.from('whatsapp_inbox').update({ procesado: true, bet_ids: r.bets.map(b => b.id), error: null }).eq('id', inserted.id);
    const b = r.bets[0];
    const advertenciaTotal = r.hayDiferenciaTotal
      ? `\n\n⚠️ *DIFERENCIA DETECTADA*\n💳 Total indicado: $${r.totalDeclarado.toFixed(2)}\n🧮 Total calculado: $${r.total.toFixed(2)}\n📊 Diferencia: $${Math.abs(r.diferenciaTotal).toFixed(2)}\n\nLa jugada fue registrada por el total calculado: $${r.total.toFixed(2)}.`
      : '';
    const resumen = `👤 ${b.nombre}\n🧾 ${r.textoOriginal}\n\n💵 Total: $${r.total.toFixed(2)}${advertenciaTotal}\n💰 Saldo restante: $${b.saldoDespues.toFixed(2)}\n🎲 ${r.loteriaNombre}\n🎰 ${r.sorteo}`;
    await sock.sendMessage(remoteJid, { text: `✅ Jugada recibida y registrada.\n\n${resumen}` });
    // Las jugadas originadas en WhatsApp se notifican al comercial por su
    // propio WhatsApp. No deben generar avisos duplicados en Telegram.
    // Esta notificación es secundaria. Nunca debe bloquear el procesamiento
    // de la siguiente jugada del cliente si WhatsApp tiene un problema de sesión,
    // cifrado o entrega al chat propio del comercial.
    notificarComercialJugadaWhatsApp(sock, db, comercialId, b.id)
      .catch(e => console.error('[WA JUGADA] notificación secundaria falló:', e?.message || e));
  } catch (err) {
    const errorTexto = String(err?.message || err);

    if (err?.code === 'INSUFFICIENT_BALANCE') {
      const pendingMarker = codificarPendienteSaldo({
        loteriaId: Number(err.loteriaId),
        sorteoId: Number(err.sorteoId),
        total: Number(err.totalRequerido || 0),
        saldoDisponible: Number(err.saldoDisponible || 0),
        faltante: Number(err.faltante || 0)
      });

      await db.from('whatsapp_inbox').update({
        error: pendingMarker,
        procesado: false,
        bet_ids: []
      }).eq('id', inserted.id);

      await enviarOpcionesRecargaWhatsApp(
        sock,
        remoteJid,
        inserted.id,
        Number(err.totalRequerido || 0),
        Number(err.saldoDisponible || 0),
        Number(err.faltante || 0)
      );
      return;
    }

    await db.from('whatsapp_inbox').update({ error: errorTexto }).eq('id', inserted.id);
    await sock.sendMessage(remoteJid, { text: `⚠️ La jugada NO fue registrada.\n\n${errorTexto}` });
    // No enviamos cada mensaje rechazado a Telegram: el cliente ya recibe
    // el motivo directamente por WhatsApp y Telegram queda reservado para
    // la gestión de conexión/QR.
  }
}

async function conectarComercial(db, comercialId, force = false) {
  const id = Number(comercialId);
  if (!Number.isFinite(id)) throw new Error('comercialId inválido');

  const existing = sockets.get(id);
  if (existing && !force) return existing;
  if (connecting.has(id)) return connecting.get(id);

  if (force) {
    const timer = reconnectTimers.get(id);
    if (timer) { clearTimeout(timer); reconnectTimers.delete(id); }

    if (existing) {
      try { existing.end?.(new Error('reconnect')); } catch (_) {}
      sockets.delete(id);
    }

    // /wa_conectar significa "volver a vincular".
    // Si quedó una credencial inválida después de un 401, no debemos cargarla
    // otra vez y esperar que el mismo QR repare una sesión revocada.
    // Limpiamos SOLO la sesión de este comercial antes de crear el socket nuevo.
    const { error: resetError } = await db
      .from('whatsapp_comercial_session')
      .update({
        estado: 'esperando_qr',
        creds: null,
        keys: null,
        telefono: null,
        ultimo_qr: null,
        ultimo_error: null,
        updated_at: new Date().toISOString()
      })
      .eq('comercial_telegram_id', id);

    if (resetError) {
      throw new Error(`No se pudo reiniciar la sesión de WhatsApp: ${resetError.message}`);
    }

    console.log(`🧹 WA ${id}: sesión reiniciada manualmente; se generará un QR nuevo.`);
  }

  const generation = (socketGenerations.get(id) || 0) + 1;
  socketGenerations.set(id, generation);

  const promise = (async () => {
    const makeWASocket = require('@whiskeysockets/baileys').default;

    // Igual que en lib/whatsapp-sender.js (ver wa-instance-lock.js): sin este
    // lock, un redeploy de Render puede dejar la instancia vieja todavía
    // sosteniendo el socket de ESTE comercial mientras la instancia nueva
    // abre otro con las mismas credenciales. Dos sockets Baileys escribiendo
    // sobre el mismo estado Signal corrompen las claves de sync y provocan
    // el ciclo "conecta -> Connection Failure -> 401 -> QR nuevo" que nunca
    // se estabiliza aunque el QR se escanee correctamente.
    let lock = locks.get(id);
    if (!lock) { lock = crearLockSesionWhatsapp(db, `commercial:${id}`); locks.set(id, lock); }
    await lock.esperarYAdquirir();

    if (socketGenerations.get(id) !== generation) {
      await lock.liberar().catch(() => {});
      return sockets.get(id) || null;
    }

    let authState;
    try {
      authState = await useSupabaseAuthState(db, `commercial:${id}`);
    } catch (error) {
      await lock.liberar().catch(() => {});
      throw error;
    }

    authStates.set(id, authState);
    const { state, saveCreds } = authState;

    if (socketGenerations.get(id) !== generation) {
      await lock.liberar().catch(() => {});
      return sockets.get(id) || null;
    }

    let sock;
    try {
      // Baileys 6.7.x puede recibir mensajes propios con addressingMode=LID
      // que intenta descifrar usando la sesión LID equivocada y termina en:
      // "Bad MAC" / "No matching sessions found for message".
      // Este bot solo necesita mensajes ENTRANTES de clientes/comerciales;
      // los mensajes enviados por el propio WhatsApp no deben entrar al
      // pipeline de jugadas. Ignoramos únicamente el JID del propio usuario
      // antes de que Baileys intente descifrarlo.
      const mismoUsuarioWhatsApp = (jid, propio) => {
        const normalizar = value => String(value || '')
          .trim()
          .replace(/:\\d+(?=@)/, '');
        const a = normalizar(jid);
        const b = normalizar(propio);
        return Boolean(a && b && a === b);
      };

      sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: jid => {
          const propioPn = state?.creds?.me?.id;
          const propioLid = state?.creds?.me?.lid;
          const ignorar = mismoUsuarioWhatsApp(jid, propioPn)
            || mismoUsuarioWhatsApp(jid, propioLid);

          if (ignorar) {
            console.log(
              `🛡️ WA ${id}: ignorando mensaje propio antes del descifrado jid=${jid}`
            );
          }

          return ignorar;
        }
      });
    } catch (error) {
      await lock.liberar().catch(() => {});
      throw error;
    }

    sock.__lotoComercialId = id;
    sockets.set(id, sock);

    // Si otra instancia adquiere el lease porque este proceso perdió la
    // renovación, este socket DEBE cerrarse inmediatamente. Mantenerlo vivo
    // después de perder el lock permitiría que dos sockets escribieran la
    // misma sesión Signal y volveríamos al patrón Bad MAC / connectionReplaced.
    lock.setOnLost(() => {
      console.error(`🚨 WA ${id}: se perdió el lock distribuido; cerrando socket para evitar doble sesión.`);
      try { sock.end(new Error('WhatsApp session lock lost')); } catch (_) {}
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      if (socketGenerations.get(id) !== generation || sockets.get(id) !== sock) return;

      const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

      // Este log permite distinguir:
      // QR generado -> QR escaneado/registro -> open -> close.
      // Sin esto, un fallo 401 después del escaneo parece simplemente que
      // "el QR no funcionó".
      if (connection || isNewLogin || receivedPendingNotifications) {
        const code = lastDisconnect?.error?.output?.statusCode
          ?? lastDisconnect?.error?.data?.statusCode
          ?? lastDisconnect?.error?.statusCode
          ?? null;
        console.log(
          `📡 WA ${id}: connection.update connection=${connection || '—'}` +
          ` isNewLogin=${Boolean(isNewLogin)}` +
          ` pending=${Boolean(receivedPendingNotifications)}` +
          ` code=${code ?? '—'}`
        );
      }

      if (qr) {
        // Si Baileys ya tiene credenciales registradas/usuario identificado,
        // un QR posterior pertenece a una fase de reconstrucción del socket y
        // no debe volver a presentarse al comercial como si estuviera sin vincular.
        const yaRegistrado = Boolean(state?.creds?.registered || state?.creds?.me || sock.user?.id);
        if (yaRegistrado) {
          console.log(`🛡️ WA ${id}: QR ignorado porque la sesión ya está registrada (${sock.user?.id || 'creds registrados'}).`);
          await saveStatus(db, id, {
            estado: 'conectado',
            ultimo_qr: null,
            telefono: sock.user?.id || null,
            ultimo_error: null
          });
        } else {
          console.log(`📲 WA ${id}: QR nuevo generado; guardando y enviando el más reciente.`);
          await sendQr(id, qr).catch(e => console.error(`QR ${id}:`, e));
        }
      }

      if (connection === 'open') {
        if (socketGenerations.get(id) !== generation || sockets.get(id) !== sock) return;

        const telefono = sock.user?.id || null;
        console.log(`✅ WA ${id}: conexión OPEN. Usuario=${telefono || 'desconocido'}`);

        // Evita repetir el aviso de conexión en Telegram cada vez que Baileys
        // reconstruye/reconecta el socket con la misma sesión.
        const { data: estadoAnterior } = await db.from('whatsapp_comercial_session')
          .select('estado,telefono')
          .eq('comercial_telegram_id', id)
          .maybeSingle();

        qrLastSentAt.delete(Number(id));
        await saveStatus(db, id, {
          estado: 'conectado',
          ultimo_qr: null,
          telefono,
          ultimo_error: null
        });

        const yaEstabaConectado = estadoAnterior?.estado === 'conectado'
          && String(estadoAnterior?.telefono || '') === String(telefono || '');

        if (!yaEstabaConectado) {
          await telegramText(id, `✅ WhatsApp conectado${telefono ? `: ${telefono}` : ''}. Ya puedes recibir jugadas.`);
        }

        // Despierta inmediatamente el outbox al quedar disponible un socket comercial.
        try {
          const sender = require('./lib/whatsapp-sender');
          await sender.vaciarOutboxWhatsapp(db);
        } catch (outboxError) {
          console.error('[WA TRANSPORTE] Error vaciando outbox tras conectar comercial:', outboxError?.message || outboxError);
        }
      }

      if (connection === 'close') {
        if (socketGenerations.get(id) !== generation || sockets.get(id) !== sock) return;

        const error = lastDisconnect?.error;
        const code = error?.output?.statusCode
          ?? error?.data?.statusCode
          ?? error?.statusCode
          ?? null;
        const loggedOut = code === DisconnectReason.loggedOut;
        const errorText = String(error?.message || error || '');
        const isConflict401 =
          loggedOut &&
          /conflict|connectionreplaced|stream errored/i.test(errorText);

        console.error(
          `❌ WA ${id}: conexión CLOSED code=${code ?? 'desconocido'}` +
          ` reason=${errorText || 'sin detalle'}` +
          ` conflict401=${isConflict401}`
        );

        // El socket ya murió. El lock no puede seguir renovándose mientras
        // no exista un socket activo: si no lo liberamos, este mismo proceso
        // conserva el lease y durante un redeploy la instancia nueva puede
        // quedar esperando indefinidamente mientras la vieja sigue viva.
        await lock?.liberar().catch(err =>
          console.error(`⚠️ WA ${id}: no se pudo liberar el lock tras cerrar el socket:`, err?.message || err)
        );

        // 401 + "conflict" NO significa que el teléfono haya desvinculado
        // la cuenta. Significa que WhatsApp expulsó este socket porque existe
        // otra conexión con las mismas credenciales (por ejemplo, una
        // instancia vieja de Render durante un deploy). En ese caso JAMÁS
        // debemos borrar creds/keys: hacerlo convierte un conflicto temporal
        // en un logout permanente y obliga a escanear QR otra vez.
        if (isConflict401) {
          await saveStatus(db, id, {
            estado: 'conectando',
            ultimo_qr: null,
            ultimo_error: `401 conflict: ${errorText}`
          }).catch(() => {});

          sockets.delete(id);

          if (!reconnectTimers.has(id)) {
            const timer = setTimeout(() => {
              reconnectTimers.delete(id);
              if (socketGenerations.get(id) !== generation) return;
              conectarComercial(db, id).catch(e =>
                console.error(`reconnect WA ${id} tras conflict:`, e)
              );
            }, 5000);
            reconnectTimers.set(id, timer);
          }
          return;
        }

        if (loggedOut) {
          // 401 significa que WhatsApp revocó la sesión. No debemos conservar
          // creds/keys inválidos y volver a arrancar con ellos: eso provoca
          // un ciclo 401 -> QR -> registro fallido -> 401.
          //
          // Importante: solo limpiamos la sesión del comercial actual; nunca
          // la sesión global ni la de otro comercial.
          const { error: clearError } = await db
            .from('whatsapp_comercial_session')
            .update({
              estado: 'desconectado',
              creds: null,
              keys: null,
              ultimo_qr: null,
              telefono: null,
              ultimo_error: `401 loggedOut: ${error?.message || 'Connection Failure'}`,
              updated_at: new Date().toISOString()
            })
            .eq('comercial_telegram_id', id);

          if (clearError) {
            console.error(`❌ WA ${id}: no se pudieron limpiar creds/keys tras 401:`, clearError);
          } else {
            console.log(`🧹 WA ${id}: sesión comercial eliminada tras loggedOut (401).`);
          }
        } else {
          await saveStatus(db, id, {
            estado: 'conectando',
            ultimo_error: String(error?.message || error || '')
          });
        }

        sockets.delete(id);

        if (loggedOut) {
          await telegramText(
            id,
            '⚠️ WhatsApp revocó la sesión anterior (401). La sesión fue limpiada. Usa /wa_conectar para generar un QR nuevo y vuelve a escanearlo.'
          ).catch(() => {});
          return;
        }

        if (!reconnectTimers.has(id)) {
          const timer = setTimeout(() => {
            reconnectTimers.delete(id);
            if (socketGenerations.get(id) !== generation) return;
            conectarComercial(db, id).catch(e => console.error(`reconnect WA ${id}:`, e));
          }, 3000);
          reconnectTimers.set(id, timer);
        }
      }
    });

    sock.ev.on('messages.upsert', async event => {
      if (socketGenerations.get(id) !== generation || sockets.get(id) !== sock) return;
      if (event.requestId) return;

      for (const message of event.messages || []) {        try {
          // Los mensajes propios enviados desde el teléfono pueden llegar
          // como "append" durante sincronizaciones/reconstrucciones de sesión.
          // No procesamos historial ajeno, pero sí permitimos comandos propios
          // dentro de grupos aunque el tipo del evento no sea "notify".
          const ownMessage = await mensajeEsPropio(sock, message);
          const remoteJid = String(message?.key?.remoteJid || '').trim();
          const isGroup = remoteJid.endsWith('@g.us');
          if (event.type !== 'notify' && !(ownMessage && isGroup)) continue;
          // Diagnóstico mínimo: confirma que Baileys está entregando el mensaje
          // antes de entrar al parser/comandos.
          const jid = String(message?.key?.remoteJid || '').trim();
          const fromMe = Boolean(message?.key?.fromMe);
          const preview = textFromMessageAnyChat(message).slice(0, 120);
          const key = message?.key || {};
          const identity = {
            remoteJid: key.remoteJid || null,
            remoteJidAlt: key.remoteJidAlt || null,
            participant: key.participant || null,
            participantAlt: key.participantAlt || null,
            senderPn: key.senderPn || null,
            participantPn: key.participantPn || null,
            senderAlt: key.senderAlt || null,
            recipientAlt: key.recipientAlt || null,
            addressingMode: key.addressingMode || null
          };
          console.log(
            `📩 WA ${id}: message received jid=${jid || 'N/A'} fromMe=${fromMe} text=${JSON.stringify(preview)}`
          );
          if (jid.endsWith('@lid') || Object.values(identity).some(v => String(v || '').endsWith('@lid'))) {
            console.log(`🔎 WA LID identity ${id}: ${JSON.stringify(identity)}`);
            try {
              const mapping = sock?.signalRepository?.lidMapping;
              if (jid.endsWith('@lid') && mapping?.getPNForLID) {
                const pn = await mapping.getPNForLID(jid);
                console.log(`🔎 WA LID mapping ${id}: ${jid} -> ${pn || 'NO_MAPPING'}`);
              }
            } catch (mappingError) {
              console.warn(`⚠️ WA LID mapping lookup ${id} failed:`, mappingError?.message || mappingError);
            }
          }

          await recibirMensaje(db, sock, id, message);
        } catch (error) {
          console.error(
            `❌ Error procesando mensaje WhatsApp del comercial ${id}:`,
            error
          );

          // No dejamos que una excepción de un mensaje rompa el procesamiento
          // de los siguientes eventos messages.upsert.
          try {
            const remoteJid = String(message?.key?.remoteJid || '').trim();
            if (remoteJid && remoteJid !== 'status@broadcast') {
              await sock.sendMessage(remoteJid, {
                text: '⚠️ No pude procesar este mensaje. Inténtalo nuevamente.'
              });
            }
          } catch (sendError) {
            console.error(
              `❌ Tampoco se pudo enviar el error al WhatsApp ${id}:`,
              sendError
            );
          }
        }
      }
    });

    return sock;
  })();

  connecting.set(id, promise);
  try {
    return await promise;
  } finally {
    if (connecting.get(id) === promise) connecting.delete(id);
  }
}

async function enviarMensajePorDestino(db, destinoId, texto) {
  const destino = String(destinoId || '').trim();
  if (!destino) throw new Error('Destino WhatsApp vacío.');

  // Si el destino pertenece a un comercial, usamos exactamente su socket.
  // Para grupos públicos sin comercial asociado usamos cualquier socket
  // comercial conectado como emisor. Así nunca se abre una segunda sesión
  // Baileys solo para publicar resultados.
  let comercialId = null;
  try {
    const grupos = await listarGruposResultadosComerciales(db);
    const grupo = (grupos || []).find(g => g?.activo && String(g.destino_id || '').trim() === destino);
    if (grupo) comercialId = Number(grupo.comercial_telegram_id);
  } catch (error) {
    console.warn('[WA TRANSPORTE] No se pudo resolver comercial del destino:', error?.message || error);
  }

  let sock = comercialId != null ? sockets.get(comercialId) : null;
  if (!sock) {
    for (const candidato of sockets.values()) {
      if (candidato?.user?.id) { sock = candidato; break; }
    }
  }
  if (!sock?.user?.id) {
    throw new Error('No hay ningún WhatsApp comercial conectado para enviar el destino ' + destino);
  }
  await sock.sendMessage(destino, { text: String(texto || '') });
  return true;
}

async function desconectarComercial(db, id) {
  const numericId = Number(id);
  const timer = reconnectTimers.get(numericId);
  if (timer) { clearTimeout(timer); reconnectTimers.delete(numericId); }
  socketGenerations.set(numericId, (socketGenerations.get(numericId) || 0) + 1);
  const sock = sockets.get(numericId);
  if (sock) { try { sock.logout(); } catch (_) { try { sock.end?.(); } catch (_) {} } sockets.delete(numericId); }
  for (const key of activeBettingChats) {
    if (key.startsWith('' + numericId + ':')) {
      activeBettingChats.delete(key);
      cancelarSalidaAutomaticaWhatsApp(key);
    }
  }
  for (const alias of [...waIdentityAliases.keys()]) {
    if (alias.startsWith('' + numericId + ':')) waIdentityAliases.delete(alias);
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

  bot.command('lista', async ctx => enviarListaJugadas(bot, db, ctx));
  bot.command('jugadas', async ctx => enviarListaJugadas(bot, db, ctx));

  bot.command('wa_conectar', async ctx => {
    const role = await commercialRole(db, ctx.from.id);
    if (!['comercial','admin'].includes(role)) return ctx.reply('⛔ Solo un comercial puede conectar su WhatsApp.');
    await ctx.reply('📲 Preparando tu conexión de WhatsApp. En unos segundos recibirás el QR aquí.');
    try { await conectarComercial(db, ctx.from.id, true); } catch (e) { console.error(e); await ctx.reply(`❌ No se pudo iniciar WhatsApp: ${e.message}`); }
  });

  bot.command('wa_qr', async ctx => {
    const role = await commercialRole(db, ctx.from.id);
    if (!['comercial','admin'].includes(role)) return ctx.reply('⛔ Solo un comercial puede usar este comando.');
    const { data } = await db.from('whatsapp_comercial_session').select('ultimo_qr,estado,telefono').eq('comercial_telegram_id', ctx.from.id).maybeSingle();
    if (data?.estado === 'conectado') return ctx.reply(`✅ WhatsApp ya está conectado${data.telefono ? ` (${data.telefono})` : ''}. No hay ningún QR pendiente.`);
    if (!data?.ultimo_qr) return ctx.reply('ℹ️ No hay un QR pendiente. Usa /wa_conectar.');
    await sendQr(ctx.from.id, data.ultimo_qr, { force: true });
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
    await desconectarComercial(db, ctx.from.id);
    await ctx.reply('✅ WhatsApp desconectado.');
  });

  bot.command('wa_comerciales', async ctx => {
    if (!admins().includes(Number(ctx.from.id))) return ctx.reply('⛔ Solo admin.');
    const { data } = await db.from('users').select('telegram_id,username,first_name').eq('role','comercial').order('telegram_id');
    if (!data?.length) return ctx.reply('No hay comerciales definidos.');
    const ids = data.map(x => x.telegram_id);
    const { data: sessions } = await db.from('whatsapp_comercial_session').select('comercial_telegram_id,estado,telefono').in('comercial_telegram_id', ids);
    const map = new Map((sessions || []).map(x => [Number(x.comercial_telegram_id), x]));
    return ctx.reply(data.map(x => { const s = map.get(Number(x.telegram_id)); return `👤 ${x.first_name || x.username || x.telegram_id}\nID: ${x.telegram_id}\nWhatsApp: ${s?.estado || 'sin configurar'}${s?.telefono ? `\n${s.telefono}` : ''}`; }).join('\n\n'));
  });

  const { data: comerciales } = await db.from('users').select('telegram_id').eq('role','comercial');
  for (const c of comerciales || []) conectarComercial(db, c.telegram_id).catch(e => console.error(`No se pudo restaurar WhatsApp del comercial ${c.telegram_id}:`, e));
  console.log(`✅ WhatsApp multi-comercial listo (${(comerciales || []).length} comerciales)`);
}

module.exports = { registrarWhatsappComerciales, conectarComercial, desconectarComercial, procesarJugadaWhatsApp, enviarMensajePorDestino };
