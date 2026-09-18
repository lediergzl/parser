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

async function sendNative(sock, jid, bodyText, buttons, fallbackText = bodyText, interactiveJid = null) {
  const replyJid = String(jid || '').trim();
  const target = String(interactiveJid || replyJid).trim();
  if (!target) return false;

  try {
    const baileys = require('@whiskeysockets/baileys');
    const generate = baileys.generateWAMessageFromContent;
    const normalize = baileys.normalizeMessageContent;
    const isJidGroup = baileys.isJidGroup || baileys.WABinary?.isJidGroup;
    const generateMessageIDV2 = baileys.generateMessageIDV2 || baileys.generateMessageID;

    if (typeof generate !== 'function' || typeof normalize !== 'function') {
      throw new Error('Internals de Baileys no disponibles para interactiveMessage');
    }

    const nativeButtons = (buttons || []).map(button => ({
      name: String(button.name || ''),
      buttonParamsJson: JSON.stringify(button.params || {})
    }));

    const content = {
      interactiveMessage: {
        body: { text: String(bodyText || '') },
        footer: { text: 'LotoPro' },
        nativeFlowMessage: {
          buttons: nativeButtons,
          messageParamsJson: ''
        }
      }
    };

    const userJid = sock?.authState?.creds?.me?.id || sock?.user?.id;
    const fullMsg = generate(target, content, {
      logger: sock?.logger,
      userJid,
      messageId: typeof generateMessageIDV2 === 'function' ? generateMessageIDV2(userJid) : undefined,
      timestamp: new Date(),
      upload: sock?.waUploadToServer
    });

    if (!fullMsg?.key?.id || !fullMsg?.message) {
      throw new Error('No se pudo generar el mensaje interactivo');
    }

    const normalized = normalize(fullMsg.message);
    const firstButtonName = normalized?.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name;

    const specialized = [
      'mpm',
      'cta_catalog',
      'send_location',
      'call_permission_request',
      'wa_payment_transaction_details',
      'automated_greeting_message_view_catalog'
    ];

    let bizNode;
    if (specialized.includes(firstButtonName)) {
      bizNode = {
        tag: 'biz',
        attrs: {},
        content: [{
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{
            tag: 'native_flow',
            attrs: { v: '2', name: firstButtonName }
          }]
        }]
      };
    } else {
      bizNode = {
        tag: 'biz',
        attrs: {},
        content: [{
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{
            tag: 'native_flow',
            attrs: { v: '9', name: 'mixed' }
          }]
        }]
      };
    }

    const additionalNodes = [bizNode];
    const privateChat = typeof isJidGroup === 'function'
      ? !isJidGroup(target)
      : !target.endsWith('@g.us');

    if (privateChat) {
      additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    }

    // El parche MD usado por helpers actuales de Baileys evita que ciertos
    // clientes rechacen el interactiveMessage como tipo no compatible.
    if (normalized?.interactiveMessage) {
      fullMsg.message = {
        documentWithCaptionMessage: {
          message: fullMsg.message
        }
      };
    }

    await sock.relayMessage(target, fullMsg.message, {
      messageId: fullMsg.key.id,
      additionalNodes
    });

    console.log('[WA MENU] interactivo enviado', {
      target,
      reply: replyJid,
      id: fullMsg.key.id,
      privateChat,
      firstButtonName
    });

    return true;
  } catch (error) {
    console.error('[WA MENU] ERROR interactivo target=' + target + ' reply=' + replyJid + ':', error?.stack || error?.message || error);

    try {
      await sock.sendMessage(replyJid || target, { text: fallbackText });
      console.log('[WA MENU] fallback texto enviado a ' + (replyJid || target));
    } catch (fallbackError) {
      console.error('[WA MENU] fallback falló:', fallbackError?.message || fallbackError);
    }
    return false;
  }
}

async function sendMainMenu(sock, jid, interactiveJid = null) {
  const fallback = [
    '🎰 LOTOPRO', '', '¿Qué deseas hacer?', '',
    '🎲 Seleccionar lotería → /loterias',
    '🎯 Seleccionar sorteo → /sorteos',
    '💰 Mi saldo → /saldo',
    '💳 Recargar saldo → /depositar',
    '❌ Salir → /salir', '',
    'Escribe uno de los comandos anteriores para continuar.'
  ].join('\n');

  return sendNative(sock, jid, '🎰 LOTOPRO\n\n¿Qué deseas hacer?', [
    { name: 'quick_reply', params: { display_text: '🎲 Seleccionar lotería', id: '/loterias' } },
    { name: 'quick_reply', params: { display_text: '🎯 Seleccionar sorteo', id: '/sorteos' } },
    { name: 'quick_reply', params: { display_text: '💰 Mi saldo', id: '/saldo' } },
    { name: 'quick_reply', params: { display_text: '💳 Recargar saldo', id: '/depositar' } },
    { name: 'quick_reply', params: { display_text: '❌ Salir', id: '/salir' } }
  ], fallback, interactiveJid);
}

async function sendLotteryMenu(sock, jid, loterias, interactiveJid = null) {
  const rows = (loterias || []).map(l => ({
    id: `/loteria ${l.id}`,
    title: String(l.nombre).slice(0, 24),
    description: `Seleccionar ${String(l.nombre).slice(0, 50)}`
  }));
  if (!rows.length) return sock.sendMessage(jid, { text: '⚠️ No hay loterías activas disponibles.' });
  return sendNative(sock, jid, 'Selecciona la lotería con la que deseas jugar:', [
    { name: 'single_select', params: { title: 'Seleccionar lotería', sections: [{ title: 'Loterías disponibles', rows }] } }
  ], `🎲 LOTERÍAS DISPONIBLES\n\n${(loterias || []).map(l => `${l.id}. ${l.nombre}`).join('\n')}\n\nSelecciona escribiendo /loteria ID`, interactiveJid);
}

async function sendDrawMenu(sock, jid, loteria, sorteos, interactiveJid = null) {
  const rows = (sorteos || []).map(s => ({
    id: `/sorteo ${s.id}`,
    title: String(s.nombre).slice(0, 24),
    description: `${String(s.hora_apertura || '').slice(0,5)}-${String(s.hora_cierre || '').slice(0,5)}`
  }));
  if (!rows.length) return sock.sendMessage(jid, { text: `⚠️ ${loteria?.nombre || 'La lotería'} no tiene sorteos activos.` });
  return sendNative(sock, jid, `🎰 ${loteria?.nombre || 'Lotería'}\n\nSelecciona el sorteo que deseas jugar:`, [
    { name: 'single_select', params: { title: 'Seleccionar sorteo', sections: [{ title: 'Sorteos disponibles', rows }] } }
  ], `🎰 ${loteria?.nombre || 'Lotería'}\n\n${(sorteos || []).map(s => `${s.id}. ${s.nombre} — ${String(s.hora_apertura || '').slice(0,5)}-${String(s.hora_cierre || '').slice(0,5)}`).join('\n')}\n\nSelecciona escribiendo /sorteo ID`, interactiveJid);
}

async function sendConfirmationMenu(sock, jid, loteriaNombre, sorteoNombre, hora, interactiveJid = null) {
  return sendNative(sock, jid, `✅ Selección lista\n\n🎲 ${loteriaNombre}\n🎰 ${sorteoNombre}\n⏰ ${hora}\n\nYa puedes enviar tu jugada.`, [
    { name: 'quick_reply', params: { display_text: '🎲 Cambiar lotería', id: '/loterias' } },
    { name: 'quick_reply', params: { display_text: '🎯 Cambiar sorteo', id: '/sorteos' } },
    { name: 'quick_reply', params: { display_text: '💰 Mi saldo', id: '/saldo' } },
    { name: 'quick_reply', params: { display_text: '❌ Salir', id: '/salir' } }
  ], `✅ Sorteo seleccionado: ${sorteoNombre}\n⏰ Horario: ${hora}\n\nYa puedes enviar tu jugada.\n\nPara cambiar: /loterias o /sorteos\nPara salir: /salir`, interactiveJid);
}

module.exports = { adaptIncomingInteractive, sendNative, sendMainMenu, sendLotteryMenu, sendDrawMenu, sendConfirmationMenu };
