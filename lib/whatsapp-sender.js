const bus = require('./event-bus');
const { useSupabaseAuthState } = require('./wa-session-store');
const { yaEntregadaPorWhatsapp } = require('./jugadas-store');

let sock = null;
let ready = false;
let suscrito = false;

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

async function conectarWhatsapp(supabase) {
  const makeWASocket = require('@whiskeysockets/baileys').default;
  const { DisconnectReason } = require('@whiskeysockets/baileys');
  const qrcode = require('qrcode-terminal');

  const { state, saveCreds } = await useSupabaseAuthState(supabase);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📲 Escanea este QR para vincular WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      ready = true;
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
