const bus = require('./event-bus');
const { useSupabaseAuthState } = require('./wa-session-store');
const { yaEntregadaPorWhatsapp } = require('./jugadas-store');

let sock = null;
let ready = false;
let suscrito = false;
let ultimoQr = null;

function fmtMoney(value) {
  return Number(value || 0).toFixed(2);
}

function resolverDestino(jugada) {
  return jugada?.destino?.id || process.env.WA_GROUP_ID || null;
}

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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function qrMatrix(qrText) {
  // qrcode-terminal 0.12.0 ya trae el generador QR completo como vendor
  // interno. Lo usamos directamente para obtener la matriz, sin imprimirla
  // y sin enviar el token QR a ningún servicio externo.
  const QRCode = require('qrcode-terminal/vendor/QRCode');
  const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  const qr = new QRCode(0, QRErrorCorrectLevel.M);
  qr.addData(qrText);
  qr.make();
  if (!Array.isArray(qr.modules) || !qr.modules.length) {
    throw new Error('El generador QR no produjo una matriz válida.');
  }
  return qr.modules;
}

function qrMatrixToPng(matrix, scale = 8) {
  const width = matrix.length;
  if (!width || matrix.some(row => !Array.isArray(row) || row.length !== width)) {
    throw new Error('La matriz QR generada tiene dimensiones inválidas.');
  }

  // Quiet zone de 4 módulos alrededor del QR, requerida para una lectura fiable.
  const quiet = 4;
  const modules = width + quiet * 2;
  const imageSize = modules * scale;
  const scanlines = [];

  for (let moduleY = -quiet; moduleY < width + quiet; moduleY++) {
    const raw = Buffer.alloc(1 + imageSize * 3);
    raw[0] = 0; // PNG filter: None

    for (let pixelX = 0; pixelX < imageSize; pixelX++) {
      const moduleX = Math.floor(pixelX / scale) - quiet;
      const dark = moduleY >= 0 && moduleY < width && moduleX >= 0 && moduleX < width
        ? matrix[moduleY][moduleX] === true
        : false;
      const value = dark ? 0 : 255;
      const offset = 1 + pixelX * 3;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }

    for (let sy = 0; sy < scale; sy++) scanlines.push(raw);
  }

  const rawImage = Buffer.concat(scanlines);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(imageSize, 0);
  ihdr.writeUInt32BE(imageSize, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', require('zlib').deflateSync(rawImage, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function qrTerminalToPng(qrText, scale = 8) {
  return qrMatrixToPng(qrMatrix(qrText), scale);
}

async function enviarQrAlAdministrador(qr) {
  const adminIds = obtenerAdminIds();
  const bot = global.__LOTO_BOT__;
  if (!bot?.telegram?.sendPhoto || !adminIds.length) {
    console.warn('⚠️ No se pudo enviar el QR de WhatsApp: bot Telegram o ADMIN_IDS no disponibles.');
    return false;
  }

  try {
    const buffer = qrTerminalToPng(qr, 8);
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

    console.log('✅ QR de WhatsApp generado como PNG local y enviado a los administradores de Telegram.');
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
      console.log('📲 Nuevo QR de WhatsApp recibido. Se enviará como imagen al administrador de Telegram.');
      enviarQrAlAdministrador(qr).catch(err =>
        console.error('❌ Error procesando QR de WhatsApp:', err && err.stack ? err.stack : err));
    }

    if (connection === 'open') {
      ready = true;
      ultimoQr = null;
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
