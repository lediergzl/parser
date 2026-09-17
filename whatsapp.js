// Integración de compatibilidad con el flujo Telegram → WhatsApp.
//
// IMPORTANTE:
// El envío real de jugadas de Telegram se realiza exclusivamente mediante
// el evento `jugada:procesada` y el módulo `lib/whatsapp-sender.js`.
//
// Este módulo conserva su export para no romper imports existentes, pero NO
// realiza ningún envío directo a WHATSAPP_COMMERCIAL_TO. Ese destino global
// pertenecía al flujo antiguo y podía provocar mensajes duplicados o enviados
// a un destinatario distinto del configurado con /wa_destino.

async function enviarJugadaAlComercial() {
  console.log('🛡️ Envío directo legacy a WhatsApp bloqueado: usar únicamente el flujo jugada:procesada → whatsapp-sender.');
  return { ok: false, skipped: true, reason: 'legacy_direct_whatsapp_disabled' };
}

module.exports = { enviarJugadaAlComercial };
