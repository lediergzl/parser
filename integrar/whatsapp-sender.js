const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const bus = require('./event-bus');
const { useSupabaseAuthState } = require('./wa-session-store');

let sock = null;
let ready = false;

function formatearJugada(j) {
  // Ajusta este formato a como realmente quieras que se vea el mensaje.
  return (
    `🎲 *Nueva jugada*\n` +
    `Cliente: ${j.cliente || '-'}\n` +
    `Banca: ${j.banca || '-'}\n` +
    `Números: ${JSON.stringify(j.numeros)}\n` +
    `Monto: ${j.monto ?? '-'}\n`
  );
}

async function conectarWhatsapp(supabase) {
  const { state, saveCreds } = await useSupabaseAuthState(supabase);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escanea este QR para vincular WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      ready = true;
      console.log('WhatsApp conectado.');
    }

    if (connection === 'close') {
      ready = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada.', shouldReconnect ? 'Reconectando...' : 'Sesión cerrada, hay que re-escanear QR.');
      if (shouldReconnect) conectarWhatsapp(supabase);
    }
  });

  // Escucha las jugadas que emite el parser de Telegram y las reenvía.
  bus.on('jugada:procesada', async (jugada) => {
    if (!ready || !jugada?.destino?.id) return;
    try {
      await sock.sendMessage(jugada.destino.id, { text: formatearJugada(jugada) });
    } catch (err) {
      console.error('Error enviando a WhatsApp:', err);
    }
  });

  return sock;
}

function estaListo() {
  return ready;
}

module.exports = { conectarWhatsapp, estaListo };
