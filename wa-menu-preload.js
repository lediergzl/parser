// Menú interactivo de WhatsApp para LotoPro.
// Se instala a nivel de Module._load para que funcione aunque otros preloads
// carguen Baileys antes/después y aunque Baileys exponga default como getter.
const Module = require('module');

console.log('[WA MENU] preload cargado');

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
    params?.id || params?.selectedId || params?.rowId || params?.selected_row_id || ''
  );
}

function adaptarRespuestaInteractiva(message) {
  const id = rowIdFromIncoming(message);
  if (!id) return false;
  console.log(`[WA MENU] respuesta interactiva: ${id}`);
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

async function sendNativeFlow(baileys, originalSend, sock, jid, bodyText, buttons, fallbackText) {
  try {
    const { proto, generateWAMessageFromContent } = baileys;
    if (typeof generateWAMessageFromContent !== 'function') throw new Error('generateWAMessageFromContent no disponible');
    if (!proto?.Message?.InteractiveMessage) throw new Error('InteractiveMessage no disponible en Baileys');

    const nativeButtons = buttons.map(button => ({
      name: button.name,
      buttonParamsJson: JSON.stringify(button.params || {})
    }));

    const content = {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: {
            body: { text: bodyText },
            footer: { text: 'LotoPro' },
            nativeFlowMessage: { buttons: nativeButtons, messageParamsJson: '' }
          }
        }
      }
    };

    const generated = generateWAMessageFromContent(jid, content, {
      userJid: sock?.user?.id,
      upload: sock?.waUploadToServer
    });
    if (!generated?.key?.id || !generated?.message) throw new Error('Baileys no generó el mensaje interactivo');
    await sock.relayMessage(jid, generated.message, { messageId: generated.key.id });
    console.log(`[WA MENU] interactivo enviado a ${jid}`);
    return true;
  } catch (error) {
    console.error(`[WA MENU] ERROR nativeFlow para ${jid}:`, error?.stack || error?.message || error);
    try {
      await originalSend(jid, { text: fallbackText || bodyText });
      console.log(`[WA MENU] fallback texto enviado a ${jid}`);
    } catch (fallbackError) {
      console.error('[WA MENU] fallback también falló:', fallbackError?.stack || fallbackError);
    }
    return false;
  }
}

function installMenuPatch(baileys) {
  if (!baileys || baileys.__lotoProMenuPatched) return baileys;

  const originalMake = baileys.default || baileys.makeWASocket;
  if (typeof originalMake !== 'function') {
    console.error('[WA MENU] Baileys cargó sin makeWASocket. keys:', Object.keys(baileys || {}).slice(0, 30).join(','));
    return baileys;
  }

  const patchedMake = function (...args) {
    const sock = originalMake(...args);
    const originalSend = sock?.sendMessage?.bind(sock);
    const originalOn = sock?.ev?.on?.bind(sock.ev);
    if (!originalSend || !originalOn) {
      console.error('[WA MENU] socket sin sendMessage/ev.on');
      return sock;
    }

    sock.sendMessage = async function (jid, content, options) {
      const text = norm(content?.text);
      if (text.startsWith('🎰 Modo jugada activado.')) {
        console.log(`[WA MENU] interceptando /jugar para ${jid}`);
        return sendNativeFlow(baileys, originalSend, sock, jid,
          '🎰 LOTOPRO\n\n¿Qué deseas hacer?',
          [
            { name: 'quick_reply', params: { display_text: '🎲 Seleccionar lotería', id: '/loterias' } },
            { name: 'quick_reply', params: { display_text: '🎯 Seleccionar sorteo', id: '/sorteos' } },
            { name: 'quick_reply', params: { display_text: '💰 Mi saldo', id: '/saldo' } },
            { name: 'quick_reply', params: { display_text: '💳 Recargar saldo', id: '/depositar' } },
            { name: 'quick_reply', params: { display_text: '❌ Salir', id: '/salir' } }
          ],
          '🎰 LOTOPRO\n\n🎲 Seleccionar lotería: /loterias\n🎯 Seleccionar sorteo: /sorteos\n💰 Mi saldo: /saldo\n💳 Recargar saldo: /depositar\n❌ Salir: /salir'
        );
      }

      if (text.includes('🎲 LOTERÍAS DISPONIBLES')) {
        const rows = parseLoterias(text);
        if (rows.length) return sendNativeFlow(baileys, originalSend, sock, jid,
          'Selecciona la lotería con la que deseas jugar:',
          [{ name: 'single_select', params: { title: 'Seleccionar lotería', sections: [{ title: 'Loterías disponibles', rows }] } }],
          `${text}\n\nSelecciona escribiendo /loteria ID`
        );
      }

      if (text.includes('Sorteos disponibles:')) {
        const rows = parseSorteos(text);
        if (rows.length) return sendNativeFlow(baileys, originalSend, sock, jid,
          'Selecciona el sorteo que deseas jugar:',
          [{ name: 'single_select', params: { title: 'Seleccionar sorteo', sections: [{ title: 'Sorteos disponibles', rows }] } }],
          `${text}\n\nSelecciona escribiendo /sorteo ID`
        );
      }

      return originalSend(jid, content, options);
    };

    sock.ev.on = function (event, listener) {
      if (event !== 'messages.upsert' || typeof listener !== 'function') return originalOn(event, listener);
      return originalOn(event, async payload => {
        for (const message of payload?.messages || []) {
          if (!message?.key?.fromMe) adaptarRespuestaInteractiva(message);
        }
        return listener(payload);
      });
    };

    console.log('[WA MENU] parche interactivo instalado en socket');
    return sock;
  };

  try { baileys.default = patchedMake; } catch (_) {}
  try { if (typeof baileys.makeWASocket === 'function') baileys.makeWASocket = patchedMake; } catch (_) {}
  try { Object.defineProperty(baileys, '__lotoProMenuPatched', { value: true, configurable: true }); } catch (_) { baileys.__lotoProMenuPatched = true; }
  console.log('[WA MENU] makeWASocket parcheado');
  return baileys;
}

const originalLoad = Module._load;
if (!Module.__lotoProMenuLoadHook) {
  Module.__lotoProMenuLoadHook = true;
  Module._load = function(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request === '@whiskeysockets/baileys') return installMenuPatch(loaded);
    return loaded;
  };
}

// Carga inmediata para verificar y parchear el módulo en este proceso.
try { installMenuPatch(require('@whiskeysockets/baileys')); } catch (e) { console.error('[WA MENU] instalación inicial falló:', e?.stack || e); }
