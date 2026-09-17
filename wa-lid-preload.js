// Preload para normalizar mensajes entrantes LID -> PN antes de que
// whatsapp-comerciales.js los procese.
// No cambia la sesión de WhatsApp ni la base de datos. Usa primero los
// JID alternativos que entrega Baileys y, si faltan, consulta el mapping
// local signalRepository.lidMapping.

const baileys = require('@whiskeysockets/baileys');
const originalMakeWASocket = baileys.default;

if (typeof originalMakeWASocket === 'function' && !originalMakeWASocket.__lotoProLidPatch) {
  const patchedMakeWASocket = function (...args) {
    const sock = originalMakeWASocket(...args);
    const originalOn = sock?.ev?.on?.bind(sock.ev);

    if (!originalOn) return sock;

    sock.ev.on = function (event, listener) {
      if (event !== 'messages.upsert' || typeof listener !== 'function') {
        return originalOn(event, listener);
      }

      const wrapped = async payload => {
        try {
          for (const message of payload?.messages || []) {
            await normalizarJidEntrante(sock, message);
          }
        } catch (error) {
          console.warn('[WA LID] No se pudo resolver un JID LID:', error?.message || error);
        }
        return listener(payload);
      };

      return originalOn(event, wrapped);
    };

    return sock;
  };

  Object.assign(patchedMakeWASocket, originalMakeWASocket);
  patchedMakeWASocket.__lotoProLidPatch = true;
  baileys.default = patchedMakeWASocket;
}

async function normalizarJidEntrante(sock, message) {
  const key = message?.key;
  if (!key || key.fromMe) return;

  const remoto = String(key.remoteJid || '').trim();
  const participante = String(key.participant || '').trim();

  // Los grupos se ignoran por el propio sistema comercial.
  if (remoto.endsWith('@g.us')) return;

  // Para un chat privado, remoteJidAlt es el PN cuando Baileys pudo
  // resolverlo directamente.
  const alternativo = String(key.remoteJidAlt || key.participantAlt || '').trim();
  const pnDirecto = normalizarPN(alternativo);
  if (pnDirecto) {
    if (remoto.endsWith('@lid')) key.remoteJid = pnDirecto;
    if (participante.endsWith('@lid')) key.participant = pnDirecto;
    return;
  }

  const lid = participante.endsWith('@lid') ? participante : remoto.endsWith('@lid') ? remoto : '';
  if (!lid) return;

  const mapping = sock?.signalRepository?.lidMapping;
  if (!mapping?.getPNForLID) return;

  try {
    const pn = await mapping.getPNForLID(lid);
    const pnNormalizado = normalizarPN(pn);
    if (!pnNormalizado) return;

    if (remoto.endsWith('@lid')) key.remoteJid = pnNormalizado;
    if (participante.endsWith('@lid')) key.participant = pnNormalizado;

    // Conservamos el LID como referencia alternativa para diagnóstico.
    if (remoto.endsWith('@lid') && !key.remoteJidAlt) key.remoteJidAlt = remoto;
    if (participante.endsWith('@lid') && !key.participantAlt) key.participantAlt = participante;

    console.log(`[WA LID] Resuelto ${lid} -> ${pnNormalizado}`);
  } catch (error) {
    console.warn(`[WA LID] Mapping no disponible para ${lid}:`, error?.message || error);
  }
}

function normalizarPN(jid) {
  const value = String(jid || '').trim();
  const match = value.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  return match ? `${match[1]}@s.whatsapp.net` : '';
}
