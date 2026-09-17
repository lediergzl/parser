// Menú interactivo de WhatsApp para LotoPro.
// Convierte las respuestas de botones/listas a los comandos que ya entiende
// whatsapp-comerciales.js y reemplaza los mensajes de selección por UI interactiva.
const baileys = require('@whiskeysockets/baileys');
const originalMakeWASocket = baileys.default;

function norm(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}

function rowIdFromIncoming(message) {
  const m = message?.message || {};
  return norm(
    m?.buttonsResponseMessage?.selectedButtonId ||
    m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m?.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

function textFromIncoming(message) {
  const m = message?.message || {};
  return norm(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '');
}

function adaptarRespuestaInteractiva(message) {
  const id = rowIdFromIncoming(message);
  if (!id) return false;
  message.message = { conversation: id };
  return true;
}

function parseLoterias(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\.\s+(.+)$/);
    if (m) rows.push({ id: `/loteria ${m[1]}`, title: m[2].slice(0, 24), description: `Seleccionar ${m[2]}` });
  }
  return rows;
}

function parseSorteos(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\.\s+(.+?)(?:\s+—\s+(.+))?$/);
    if (m) rows.push({ id: `/sorteo ${m[1]}`, title: m[2].slice(0, 24), description: m[3] ? m[3].slice(0, 50) : 'Seleccionar sorteo' });
  }
  return rows;
}

async function sendList(originalSend, jid, title, description, rows) {
  if (!rows.length) return false;
  const sections = [{ title, rows: rows.slice(0, 100) }];
  try {
    await originalSend(jid, {
      text: description,
      title,
      footer: 'LotoPro',
      buttonText: 'Seleccionar',
      sections
    });
    return true;
  } catch (error) {
    console.warn('[WA MENU] No se pudo enviar lista interactiva:', error?.message || error);
    return false;
  }
}

async function sendMainMenu(originalSend, jid) {
  const buttons = [
    { buttonId: '/loterias', buttonText: { displayText: '🎲 Seleccionar lotería' }, type: 1 },
    { buttonId: '/saldo', buttonText: { displayText: '💰 Mi saldo' }, type: 1 },
    { buttonId: '/depositar', buttonText: { displayText: '💳 Recargar saldo' }, type: 1 }
  ];
  try {
    await originalSend(jid, {
      text: '🎰 *LOTO PRO*\n\nSelecciona una opción para continuar.\n\nLa selección de lotería y sorteo se reinicia al comenzar una nueva sesión.',
      footer: 'Sesión de juego: 30 minutos',
      buttons,
      headerType: 1
    });
    return true;
  } catch (error) {
    console.warn('[WA MENU] No se pudo enviar menú de botones:', error?.message || error);
    try {
      await originalSend(jid, { text: '🎰 LOTO PRO\n\n🎲 Seleccionar lotería: /loterias\n💰 Mi saldo: /saldo\n💳 Recargar: /depositar\n\nEscribe /salir para terminar la sesión.' });
    } catch (_) {}
    return false;
  }
}

if (typeof originalMakeWASocket === 'function' && !originalMakeWASocket.__lotoProMenuPatch) {
  const patchedMakeWASocket = function (...args) {
    const sock = originalMakeWASocket(...args);
    const originalSend = sock?.sendMessage?.bind(sock);
    const originalOn = sock?.ev?.on?.bind(sock.ev);
    if (!originalSend || !originalOn) return sock;

    sock.sendMessage = async function (jid, content, options) {
      const text = norm(content?.text);

      if (text.startsWith('🎰 Modo jugada activado.')) {
        return sendMainMenu(originalSend, jid);
      }

      if (text.includes('🎲 LOTERÍAS DISPONIBLES')) {
        const rows = parseLoterias(text);
        if (await sendList(originalSend, jid, '🎲 Loterías disponibles', 'Selecciona la lotería con la que deseas jugar:', rows)) return;
      }

      if (text.includes('Sorteos disponibles:')) {
        const rows = parseSorteos(text);
        if (await sendList(originalSend, jid, '🎰 Sorteos disponibles', 'Selecciona el sorteo que deseas jugar:', rows)) return;
      }

      return originalSend(jid, content, options);
    };

    sock.ev.on = function (event, listener) {
      if (event !== 'messages.upsert' || typeof listener !== 'function') return originalOn(event, listener);
      const wrapped = async payload => {
        for (const message of payload?.messages || []) {
          if (message?.key?.fromMe) continue;
          adaptarRespuestaInteractiva(message);
        }
        return listener(payload);
      };
      return originalOn(event, wrapped);
    };

    return sock;
  };

  Object.assign(patchedMakeWASocket, originalMakeWASocket);
  patchedMakeWASocket.__lotoProMenuPatch = true;
  baileys.default = patchedMakeWASocket;
}
