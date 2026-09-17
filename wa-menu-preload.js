// Menú interactivo de WhatsApp para LotoPro.
// Usa nativeFlowMessage (single_select / quick_reply) porque los botones/listas
// legacy pueden ser ignorados por versiones actuales de WhatsApp.
const baileys = require('@whiskeysockets/baileys');
const originalMakeWASocket = baileys.default;

function norm(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}

function parseNativeFlowParams(value) {
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function rowIdFromIncoming(message) {
  const m = message?.message || {};
  const native = m?.interactiveResponseMessage?.nativeFlowResponseMessage;
  const params = parseNativeFlowParams(native?.paramsJson);
  return norm(
    m?.buttonsResponseMessage?.selectedButtonId ||
    m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m?.templateButtonReplyMessage?.selectedId ||
    params?.id ||
    params?.selectedId ||
    params?.rowId ||
    ''
  );
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

async function sendNativeFlow(originalSend, sock, jid, bodyText, buttons, fallbackText) {
  try {
    const { proto, generateWAMessageFromContent } = baileys;
    if (typeof generateWAMessageFromContent !== 'function' || !proto?.Message?.InteractiveMessage) {
      throw new Error('nativeFlow no disponible en esta versión de Baileys');
    }

    const nativeButtons = buttons.map(button => ({
      name: button.name,
      buttonParamsJson: JSON.stringify(button.params || {})
    }));

    const interactiveMessage = proto.Message.InteractiveMessage.create({
      body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
      footer: proto.Message.InteractiveMessage.Footer.create({ text: 'LotoPro' }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: nativeButtons,
        messageParamsJson: ''
      })
    });

    const generated = generateWAMessageFromContent(jid, { interactiveMessage }, {});
    await sock.relayMessage(jid, generated.message, { messageId: generated.key.id });
    return true;
  } catch (error) {
    console.warn('[WA MENU] nativeFlow no disponible/no enviado:', error?.message || error);
    try {
      await originalSend(jid, { text: fallbackText || bodyText });
      return false;
    } catch (fallbackError) {
      console.error('[WA MENU] tampoco se pudo enviar fallback:', fallbackError?.message || fallbackError);
      return false;
    }
  }
}

async function sendList(originalSend, sock, jid, title, description, rows) {
  if (!rows.length) return false;
  const sectionRows = rows.slice(0, 100).map(row => ({
    title: row.title,
    description: row.description,
    id: row.id
  }));

  const params = {
    title: 'Seleccionar',
    sections: [{ title, rows: sectionRows }]
  };

  return sendNativeFlow(
    originalSend,
    sock,
    jid,
    description,
    [{ name: 'single_select', params }],
    `${description}\n\n${rows.map((r, i) => `${i + 1}. ${r.title} — escribe ${r.id}`).join('\n')}`
  );
}

async function sendMainMenu(originalSend, sock, jid) {
  const buttons = [
    { name: 'quick_reply', params: { display_text: '🎲 Seleccionar lotería', id: '/loterias' } },
    { name: 'quick_reply', params: { display_text: '💰 Mi saldo', id: '/saldo' } },
    { name: 'quick_reply', params: { display_text: '💳 Recargar saldo', id: '/depositar' } },
    { name: 'quick_reply', params: { display_text: '❌ Salir', id: '/salir' } }
  ];

  return sendNativeFlow(
    originalSend,
    sock,
    jid,
    '🎰 LOTO PRO\n\nSelecciona una opción para continuar.',
    buttons,
    '🎰 LOTO PRO\n\n🎲 Seleccionar lotería: /loterias\n💰 Mi saldo: /saldo\n💳 Recargar: /depositar\n❌ Salir: /salir'
  );
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
        return sendMainMenu(originalSend, sock, jid);
      }

      if (text.includes('🎲 LOTERÍAS DISPONIBLES')) {
        const rows = parseLoterias(text);
        if (await sendList(originalSend, sock, jid, '🎲 Loterías disponibles', 'Selecciona la lotería con la que deseas jugar:', rows)) return;
        return;
      }

      if (text.includes('Sorteos disponibles:')) {
        const rows = parseSorteos(text);
        if (await sendList(originalSend, sock, jid, '🎰 Sorteos disponibles', 'Selecciona el sorteo que deseas jugar:', rows)) return;
        return;
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

    console.log('[WA MENU] parche interactivo instalado');
    return sock;
  };

  Object.assign(patchedMakeWASocket, originalMakeWASocket);
  patchedMakeWASocket.__lotoProMenuPatch = true;
  baileys.default = patchedMakeWASocket;
}
