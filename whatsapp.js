// Integración opcional con WhatsApp Business Cloud API.
// Si las variables de WhatsApp no están configuradas, no interfiere
// con el procesamiento normal de las apuestas.

function whatsappConfigurado() {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_COMMERCIAL_TO
  );
}

function normalizarNumero(numero) {
  return String(numero || '').replace(/\D/g, '');
}

async function enviarJugadaAlComercial({
  betId,
  telegramId,
  loteriaNombre,
  sorteoNombre,
  fecha,
  inputRaw,
  total,
  moneda,
  saldoDespues
}) {
  if (!whatsappConfigurado()) {
    console.log('ℹ️ WhatsApp no configurado; se omite notificación al comercial.');
    return { ok: false, skipped: true };
  }

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = normalizarNumero(process.env.WHATSAPP_COMMERCIAL_TO);
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';

  if (!to) {
    console.error('❌ WHATSAPP_COMMERCIAL_TO no contiene un número válido.');
    return { ok: false, skipped: true };
  }

  const texto = [
    '🎰 NUEVA JUGADA PROCESADA',
    '',
    `🆔 Apuesta: #${betId}`,
    `👤 Cliente Telegram: ${telegramId}`,
    `🎰 Lotería: ${loteriaNombre || 'Lotería'}`,
    `🕒 Sorteo: ${sorteoNombre || 'Sorteo'}`,
    `📅 Fecha: ${fecha}`,
    '',
    '📝 Jugada:',
    String(inputRaw || ''),
    '',
    `💰 Total: $${Number(total || 0).toFixed(2)}`,
    `💵 Moneda: ${String(moneda || 'cup').toUpperCase()}`,
    `💳 Saldo restante: $${Number(saldoDespues || 0).toFixed(2)}`,
    '',
    '✅ Registrada correctamente.'
  ].join('\n');

  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: texto }
    })
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`❌ WhatsApp no pudo enviar la jugada (${response.status}):`, body);
    return { ok: false, error: body, status: response.status };
  }

  console.log(`✅ Jugada #${betId} enviada al WhatsApp del comercial.`);
  return { ok: true, data: body };
}

module.exports = { enviarJugadaAlComercial };
