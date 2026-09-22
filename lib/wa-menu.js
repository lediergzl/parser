const { proto, generateWAMessageFromContent } = require('@whiskeysockets/baileys');

const businessProfileCache = new Map();
const businessProfilePending = new Map();
const BUSINESS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function normalizarJidParaConsulta(jid) {
  const value = String(jid || '').trim();
  return value.endsWith('@s.whatsapp.net') ? value : value;
}

// Lectura SOLO de caché, sin disparar ninguna consulta de red. Se usa en el
// camino caliente de sendNative para no bloquear cada transición de menú
// con un round-trip a los servidores de WhatsApp.
function isBusinessCacheado(jid, alternateJid = null) {
  const candidatos = [alternateJid, jid]
    .map(normalizarJidParaConsulta)
    .filter(v => v && v.endsWith('@s.whatsapp.net'));
  if (!candidatos.length) return false;
  const cached = businessProfileCache.get(candidatos[0]);
  if (!cached || (Date.now() - cached.at) >= BUSINESS_CACHE_TTL_MS) return false;
  return cached.isBusiness;
}

async function detectarWhatsAppBusiness(sock, jid, alternateJid = null) {
  const candidatos = [alternateJid, jid]
    .map(normalizarJidParaConsulta)
    .filter(v => v && v.endsWith('@s.whatsapp.net'));
  if (!candidatos.length || typeof sock?.getBusinessProfile !== 'function') return false;

  const target = candidatos[0];
  const cached = businessProfileCache.get(target);
  if (cached && (Date.now() - cached.at) < BUSINESS_CACHE_TTL_MS) return cached.isBusiness;

  const pending = businessProfilePending.get(target);
  if (pending) return pending;

  const lookup = (async () => {
    try {
      const profile = await sock.getBusinessProfile(target);
      const isBusiness = Boolean(profile && typeof profile === 'object');
      businessProfileCache.set(target, { isBusiness, at: Date.now() });
      console.log('[WA MENU] tipo de cliente', { target, isBusiness });
      return isBusiness;
    } catch (error) {
      console.warn('[WA MENU] no se pudo consultar perfil Business', target, error?.message || error);
      return false;
    } finally {
      businessProfilePending.delete(target);
    }
  })();

  businessProfilePending.set(target, lookup);
  return lookup;
}

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

  // WhatsApp Business puede no renderizar native-flow aunque el relay sea aceptado.
  // Si el destinatario tiene perfil Business, usamos el mismo contenido pero como texto.
  //
  // La detección en sí (getBusinessProfile) es un round-trip a los servidores de
  // WhatsApp. Antes se esperaba (await) en CADA transición de menú, añadiendo esa
  // latencia a cada tap del cliente. Ahora solo se consulta la caché (síncrono) y,
  // si no hay resultado cacheado todavía, se dispara la consulta en segundo plano
  // para tenerla lista en el próximo mensaje, sin bloquear este.
  const isBusiness = isBusinessCacheado(target, interactiveJid);
  detectarWhatsAppBusiness(sock, target, interactiveJid).catch(() => {});
  if (isBusiness) {
    await sock.sendMessage(replyJid || target, { text: fallbackText });
    console.log('[WA MENU] cliente Business detectado: menú plano enviado', {
      target,
      reply: replyJid
    });
    return true;
  }

  // SEGURIDAD/COMPATIBILIDAD: algunos clientes de WhatsApp aceptan el
  // relay del Native Flow pero no consiguen descifrar/renderizar el mensaje.
  // En esos chats queda "Esperando el mensaje" y el cliente parece bloqueado.
  // El menú plano es completamente compatible y, además, contiene los mismos
  // comandos que procesaría un botón. Dejamos el Native Flow desactivado por
  // defecto para que ningún cliente quede bloqueado por un mensaje interactivo.
  if (String(process.env.WA_NATIVE_MENU || '').trim().toLowerCase() !== 'true') {
    await sock.sendMessage(replyJid || target, { text: fallbackText });
    console.log('[WA MENU] menú plano enviado (Native Flow desactivado)', {
      target,
      reply: replyJid
    });
    return true;
  }

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

    // Native Flow debe viajar como interactiveMessage dentro de viewOnceMessage.
    // No lo envolvemos como documentWithCaptionMessage: ese contenedor es para
    // documentos con caption y puede hacer que WhatsApp acepte el relay pero no
    // renderice el menú interactivo.
    if (normalized?.interactiveMessage) {
      fullMsg.message = {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2
            },
            interactiveMessage: normalized.interactiveMessage
          }
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

  const texto = `🎲 LOTERÍAS DISPONIBLES\n\n${(loterias || []).map(l => `${l.id}. ${l.nombre}`).join('\n')}\n\nSelecciona una lotería:`;
  const directButtons = (loterias || []).slice(0, 3).map(l => ({
    name: 'quick_reply',
    params: { display_text: String(l.nombre).slice(0, 20), id: `/loteria ${l.id}` }
  }));

  // Hasta 3 opciones: botones directos, sin el paso intermedio
  // "Seleccionar lotería" -> abrir lista -> seleccionar.
  if ((loterias || []).length <= 3 && directButtons.length) {
    return sendNative(sock, jid, texto, directButtons, texto, interactiveJid);
  }

  return sendNative(sock, jid, 'Selecciona la lotería con la que deseas jugar:', [
    { name: 'single_select', params: { title: 'Seleccionar lotería', sections: [{ title: 'Loterías disponibles', rows }] } }
  ], texto + '\n\nSelecciona escribiendo /loteria ID', interactiveJid);
}

async function sendDrawMenu(sock, jid, loteria, sorteos, interactiveJid = null) {
  const rows = (sorteos || []).map(s => ({
    id: `/sorteo ${s.id}`,
    title: String(s.nombre).slice(0, 24),
    description: `${String(s.hora_apertura || '').slice(0,5)}-${String(s.hora_cierre || '').slice(0,5)}`
  }));
  if (!rows.length) return sock.sendMessage(jid, { text: `⚠️ ${loteria?.nombre || 'La lotería'} no tiene sorteos activos.` });

  const texto = `🎰 ${loteria?.nombre || 'Lotería'}\n\nSelecciona el sorteo:`;
  const directButtons = (sorteos || []).slice(0, 3).map(s => ({
    name: 'quick_reply',
    params: { display_text: String(s.nombre).slice(0, 20), id: `/sorteo ${s.id}` }
  }));

  // Hasta 3 sorteos: selección directa.
  if ((sorteos || []).length <= 3 && directButtons.length) {
    return sendNative(sock, jid, texto, directButtons, texto, interactiveJid);
  }

  return sendNative(sock, jid, texto, [
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
