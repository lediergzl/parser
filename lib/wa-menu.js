const { proto, generateWAMessageFromContent } = require('@whiskeysockets/baileys');

function parseParams(value) {
  try { return JSON.parse(typeof value === 'string' ? value : JSON.stringify(value || {})); } catch (_) { return null; }
}

function getInteractiveId(message) {
  const m = message?.message || {};
  const native = m?.interactiveResponseMessage?.nativeFlowResponseMessage;
  const params = parseParams(native?.paramsJson);
  return String(
    m?.buttonsResponseMessage?.selectedButtonId ||
    m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m?.templateButtonReplyMessage?.selectedId ||
    params?.id || params?.selectedId || params?.rowId || params?.selected_row_id || ''
  ).trim();
}

function adaptIncomingInteractive(message) {
  const id = getInteractiveId(message);
  if (!id) return '';
  message.message = { conversation: id };
  return id;
}

async function sendNative(sock, jid, bodyText, buttons, fallbackText = bodyText) {
  // Los mensajes entrantes actuales pueden llegar con un LID (@lid). En
  // Baileys 6.x el relay de InteractiveMessage puede aceptar el envío sin
  // que el cliente termine mostrando el mensaje. Para LID usamos primero
  // un mensaje de texto normal, que es el canal más compatible.
  if (String(jid || '').endsWith('@lid')) {
    try {
      await sock.sendMessage(jid, { text: fallbackText });
      console.log(`[WA MENU] texto enviado a LID ${jid}`);
      return true;
    } catch (error) {
      console.error(`[WA MENU] ERROR enviando texto a LID ${jid}:`, error?.stack || error?.message || error);
      return false;
    }
  }

  try {
    if (!proto?.Message?.InteractiveMessage || typeof generateWAMessageFromContent !== 'function') throw new Error('InteractiveMessage no disponible');
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
    if (!generated?.key?.id || !generated?.message) throw new Error('No se pudo generar el mensaje interactivo');
    await sock.relayMessage(jid, generated.message, { messageId: generated.key.id });
    console.log(`[WA MENU] interactivo enviado a ${jid}`);
    return true;
  } catch (error) {
    console.error(`[WA MENU] ERROR para ${jid}:`, error?.stack || error?.message || error);
    try { await sock.sendMessage(jid, { text: fallbackText }); } catch (fallbackError) { console.error('[WA MENU] fallback falló:', fallbackError?.message || fallbackError); }
    return false;
  }
}

async function sendMainMenu(sock, jid) {
  const fallback = [
    '🎰 LOTOPRO',
    '',
    '¿Qué deseas hacer?',
    '',
    '🎲 Seleccionar lotería → /loterias',
    '🎯 Seleccionar sorteo → /sorteos',
    '💰 Mi saldo → /saldo',
    '💳 Recargar saldo → /depositar',
    '❌ Salir → /salir',
    '',
    'Escribe uno de los comandos anteriores para continuar.'
  ].join('\n');

  return sendNative(sock, jid, '🎰 LOTOPRO\n\n¿Qué deseas hacer?', [
    { name: 'quick_reply', params: { display_text: '🎲 Seleccionar lotería', id: '/loterias' } },
    { name: 'quick_reply', params: { display_text: '🎯 Seleccionar sorteo', id: '/sorteos' } },
    { name: 'quick_reply', params: { display_text: '💰 Mi saldo', id: '/saldo' } },
    { name: 'quick_reply', params: { display_text: '💳 Recargar saldo', id: '/depositar' } },
    { name: 'quick_reply', params: { display_text: '❌ Salir', id: '/salir' } }
  ], fallback);
}

async function sendLotteryMenu(sock, jid, loterias) {
  const rows = (loterias || []).map(l => ({ id: `/loteria ${l.id}`, title: String(l.nombre).slice(0, 24), description: `Seleccionar ${String(l.nombre).slice(0, 50)}` }));
  if (!rows.length) return sock.sendMessage(jid, { text: '⚠️ No hay loterías activas disponibles.' });
  return sendNative(sock, jid, 'Selecciona la lotería con la que deseas jugar:', [
    { name: 'single_select', params: { title: 'Seleccionar lotería', sections: [{ title: 'Loterías disponibles', rows }] } }
  ], `🎲 LOTERÍAS DISPONIBLES\n\n${(loterias || []).map(l => `${l.id}. ${l.nombre}`).join('\n')}\n\nSelecciona escribiendo /loteria ID`);
}

async function sendDrawMenu(sock, jid, loteria, sorteos) {
  const rows = (sorteos || []).map(s => ({
    id: `/sorteo ${s.id}`,
    title: String(s.nombre).slice(0, 24),
    description: `${String(s.hora_apertura || '').slice(0,5)}-${String(s.hora_cierre || '').slice(0,5)}`
  }));
  if (!rows.length) return sock.sendMessage(jid, { text: `⚠️ ${loteria?.nombre || 'La lotería'} no tiene sorteos activos.` });
  return sendNative(sock, jid, `🎰 ${loteria?.nombre || 'Lotería'}\n\nSelecciona el sorteo que deseas jugar:`, [
    { name: 'single_select', params: { title: 'Seleccionar sorteo', sections: [{ title: 'Sorteos disponibles', rows }] } }
  ], `🎰 ${loteria?.nombre || 'Lotería'}\n\n${(sorteos || []).map(s => `${s.id}. ${s.nombre} — ${String(s.hora_apertura || '').slice(0,5)}-${String(s.hora_cierre || '').slice(0,5)}`).join('\n')}\n\nSelecciona escribiendo /sorteo ID`);
}

async function sendConfirmationMenu(sock, jid, loteriaNombre, sorteoNombre, hora) {
  return sendNative(sock, jid, `✅ Selección lista\n\n🎲 ${loteriaNombre}\n🎰 ${sorteoNombre}\n⏰ ${hora}\n\nYa puedes enviar tu jugada.`, [
    { name: 'quick_reply', params: { display_text: '🎲 Cambiar lotería', id: '/loterias' } },
    { name: 'quick_reply', params: { display_text: '🎯 Cambiar sorteo', id: '/sorteos' } },
    { name: 'quick_reply', params: { display_text: '💰 Mi saldo', id: '/saldo' } },
    { name: 'quick_reply', params: { display_text: '❌ Salir', id: '/salir' } }
  ], `✅ Sorteo seleccionado: ${sorteoNombre}\n⏰ Horario: ${hora}\n\nYa puedes enviar tu jugada.\n\nPara cambiar: /loterias o /sorteos\nPara salir: /salir`);
}

module.exports = { adaptIncomingInteractive, sendMainMenu, sendLotteryMenu, sendDrawMenu, sendConfirmationMenu };
