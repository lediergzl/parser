// Preload para normalizar mensajes entrantes LID -> PN antes de que
// whatsapp-comerciales.js los procese.
//
// Regla importante: no reemplazamos un LID que ya esté registrado en
// clientes_banca. Solo usamos el PN cuando el LID no está registrado y
// existe exactamente un cliente registrado con ese PN. Así no rompemos
// clientes antiguos que fueron guardados con @lid.

const { createClient } = require('@supabase/supabase-js');
const baileys = require('@whiskeysockets/baileys');
const originalMakeWASocket = baileys.default;

const jidDecisionCache = new Map();

function supa() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );
}

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

  if (remoto.endsWith('@g.us')) return;

  const lid = participante.endsWith('@lid')
    ? participante
    : remoto.endsWith('@lid')
      ? remoto
      : '';

  if (!lid) return;

  let pn = normalizarPN(key.remoteJidAlt || key.participantAlt);

  if (!pn) {
    const mapping = sock?.signalRepository?.lidMapping;
    if (!mapping?.getPNForLID) return;

    try {
      pn = normalizarPN(await mapping.getPNForLID(lid));
    } catch (error) {
      console.warn(`[WA LID] Mapping no disponible para ${lid}:`, error?.message || error);
      return;
    }
  }

  if (!pn) return;

  const decision = await resolverJidRegistrado(lid, pn);

  // Si el LID ya existe en clientes_banca, lo conservamos.
  if (decision === 'lid') return;

  // Solo cambiamos a PN cuando hay un único cliente registrado con ese PN.
  if (decision === 'pn') {
    if (remoto.endsWith('@lid')) key.remoteJid = pn;
    if (participante.endsWith('@lid')) key.participant = pn;
    if (remoto.endsWith('@lid') && !key.remoteJidAlt) key.remoteJidAlt = lid;
    if (participante.endsWith('@lid') && !key.participantAlt) key.participantAlt = lid;
    console.log(`[WA LID] Resuelto para cliente registrado: ${lid} -> ${pn}`);
  }
}

async function resolverJidRegistrado(lid, pn) {
  const cacheKey = `${lid}|${pn}`;
  if (jidDecisionCache.has(cacheKey)) return jidDecisionCache.get(cacheKey);

  try {
    const db = supa();
    const { data, error } = await db
      .from('clientes_banca')
      .select('id,comercial_telegram_id,whatsapp_jid')
      .or(`whatsapp_jid.eq.${lid},whatsapp_jid.eq.${pn}`)
      .limit(100);

    if (error) throw error;

    const rows = data || [];
    const hayLid = rows.some(row => String(row.whatsapp_jid || '').trim() === lid);
    if (hayLid) {
      jidDecisionCache.set(cacheKey, 'lid');
      return 'lid';
    }

    const pnRows = rows.filter(row => String(row.whatsapp_jid || '').trim() === pn);
    const decision = pnRows.length === 1 ? 'pn' : 'none';
    jidDecisionCache.set(cacheKey, decision);
    return decision;
  } catch (error) {
    // Nunca bloqueamos una jugada por un fallo auxiliar de resolución LID.
    console.warn('[WA LID] No se pudo consultar clientes_banca:', error?.message || error);
    return 'none';
  }
}

function normalizarPN(jid) {
  const value = String(jid || '').trim();
  const match = value.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  return match ? `${match[1]}@s.whatsapp.net` : '';
}
