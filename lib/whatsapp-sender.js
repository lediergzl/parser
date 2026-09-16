const bus = require('./event-bus');
const { useSupabaseAuthState } = require('./wa-session-store');
const { yaEntregadaPorWhatsapp } = require('./jugadas-store');

let sock = null;
let ready = false;
let suscrito = false;
let ultimoQr = null;
let qrEnviado = false;

function fmtMoney(value) {
  return Number(value || 0).toFixed(2);
}

function resolverDestino(jugada) {
  return jugada?.destino?.id || process.env.WA_GROUP_ID || null;
}

// Mismo formato que la notificación por Cloud API (whatsapp.js), para que el
// comercial vea el mismo mensaje sin importar por cuál vía llegue.
function formatearJugada(j) {
  return [
    '🎰 NUEVA JUGADA PROCESADA',
    '',
    `🆔 Apuesta: #${j.betId ?? '-'}`,
    `👤 Jugador: ${j.cliente || j.telegramId || '-'}`,
    `🎰 Lotería: ${j.loteriaNombre || 'Lotería'}`,
    `🕒 Sorteo: ${j.sorteoNombre || 'Sorteo'}`,
    `📅 Fecha: ${j.fecha || '-'}`,
    '',
    '📝 Jugada:',
    String(j.rawText || j.raw_text || ''),
    '',
    `💰 Total: $${fmtMoney(j.monto)}`,
    `💵 Moneda: ${String(j.moneda || 'cup').toUpperCase()}`,
    `💳 Saldo restante: $${fmtMoney(j.saldoDespues)}`,
    '',
    '✅ Registrada correctamente.'
  ].join('\n');
}

function obtenerAdminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(Number.isFinite);
}

async function enviarQrAlAdministrador(qr) {
  const adminIds = obtenerAdminIds();
  const bot = global.__LOTO_BOT__;
  if (!bot?.telegram?.sendPhoto || !adminIds.length) {
    console.warn('⚠️ No se pudo enviar el QR de WhatsApp: bot Telegram o ADMIN_IDS no disponibles.');
    return false;
  }

  // El QR que entrega Baileys es texto. Render no es un lugar fiable para
  // escanearlo desde el log: el terminal lo deforma/escala y puede quedar
  // ilegible. Lo convertimos en una imagen PNG grande antes de enviarlo.
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&margin=24&format=png&data=${encodeURIComponent(qr)}`;

  try {
    const response = await fetch(qrUrl);
    if (!response.ok) throw new Error(`QR generator HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('El generador QR devolvió una imagen vacía.');

    const caption = [
      '📲 *QR DE WHATSAPP*',
      '',
      'Escanea esta imagen desde WhatsApp → Dispositivos vinculados.',
      '⏱️ Este QR es temporal. Si aparece otro QR, usa el más reciente.',
      '',
      '⚠️ No uses el QR mostrado en los logs de Render.'
    ].join('\n');

    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendPhoto(
          adminId,
          { source: buffer, filename: 'whatsapp-qr.png' },
          { caption, parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error(`❌ No se pudo enviar el QR de WhatsApp al admin ${adminId}:`, error?.message || error);
      }
    }

    qrEnviado = true;
    console.log('✅ QR de WhatsApp generado como PNG y enviado a los administradores de Telegram.');
    return true;
  } catch (error) {
    console.error('❌ No se pudo generar/enviar el QR de WhatsApp como imagen:', error?.message || error);
    return false;
  }
}

async function conectarWhatsapp(supabase) {
  const makeWASocket = require('@whiskeysockets/baileys').default;
  const { DisconnectReason } = require('@whiskeysockets/baileys');

  const { state, saveCreds } = await useSupabaseAuthState(supabase);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && qr !== ultimoQr) {
      ultimoQr = qr;
      qrEnviado = false;
      console.log('📲 Nuevo QR de WhatsApp recibido. Se enviará como imagen al administrador de Telegram.');
      enviarQrAlAdministrador(qr).catch(err =>
        console.error('❌ Error procesando QR de WhatsApp:', err && err.stack ? err.stack : err));
    }

    if (connection === 'open') {
      ready = true;
      ultimoQr = null;
      qrEnviado = false;
      console.log('✅ WhatsApp (Baileys) conectado.');
    }

    if (connection === 'close') {
      ready = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️  Conexión de WhatsApp cerrada.', shouldReconnect ? 'Reconectando...' : 'Sesión cerrada, hay que re-escanear el QR.');
      if (shouldReconnect) {
        setTimeout(() => {
          conectarWhatsapp(supabase).catch(err =>
            console.error('❌ Error reconectando WhatsApp:', err && err.stack ? err.stack : err));
        }, 3000);
      }
    }
  });

  // La suscripción se registra una sola vez, aunque haya reconexiones.
  if (!suscrito) {
    suscrito = true;
    bus.on('jugada:procesada', async (jugada) => {
      const destinoId = resolverDestino(jugada);
      if (!destinoId) {
        console.log('ℹ️ WA_GROUP_ID no configurado y la jugada no trae destino; se omite el envío por Baileys.');
        return;
      }
      if (!ready) {
        console.log(`⚠️  WhatsApp no está listo; la jugada #${jugada?.betId ?? '-'} no se envió por Baileys.`);
        return;
      }
      try {
        if (await yaEntregadaPorWhatsapp(supabase, jugada?.betId)) return;
        await sock.sendMessage(destinoId, { text: formatearJugada(jugada) });
        bus.emit('jugada:enviada_wa', { betId: jugada?.betId, destinoId });
        console.log(`✅ Jugada #${jugada?.betId ?? '-'} enviada por WhatsApp (Baileys).`);
      } catch (err) {
        console.error('❌ Error enviando a WhatsApp (Baileys):', err && err.stack ? err.stack : err);
      }
    });
  }

  return sock;
}

function estaListo() {
  return ready;
}

module.exports = { conectarWhatsapp, estaListo, formatearJugada };
