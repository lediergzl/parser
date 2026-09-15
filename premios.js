// ============================================================================
// premios.js — Detección, cálculo y notificación de jugadas ganadoras.
// Compartido por banca.js (bot Telegraf) y userbot-resultados.js (proceso
// que escucha a @boliterostop_bot), para no duplicar la lógica.
//
// Uso:
//   const { detectarPremios, PAYOUT_MULTIPLIERS } = require('./premios.js');
//   await detectarPremios(supabase, resultadoRow);
// ============================================================================

const PAYOUT_MULTIPLIERS = {
  fijo: 80,
  corrido: 30,
  centena: 500,
  centena_global: 500,
  parle: 1000,
  parle_global: 1000,
};

function obtenerTelegramId(bet) {
  const candidatos = [
    bet?.telegram_id,
    bet?.user_telegram_id,
    bet?.usuario_telegram_id,
    bet?.chat_id,
    bet?.user_id,
  ];
  for (const valor of candidatos) {
    if (valor !== null && valor !== undefined && String(valor).trim() !== '') {
      return String(valor).trim();
    }
  }
  return null;
}

function nombreTipo(tipo) {
  return ({
    fijo: 'Fijo',
    corrido: 'Corrido',
    centena: 'Centena',
    centena_global: 'Centena global',
    parle: 'Parle',
    parle_global: 'Parle global',
    candado: 'Candado',
    candado_global: 'Candado global',
  })[tipo] || String(tipo || 'Jugada');
}

function fmtMoney(value) {
  return Number(value || 0).toFixed(2);
}

async function notificarPremioTelegram(bet, premio, resultado) {
  const bot = global.__LOTO_BOT__;
  if (!bot?.telegram?.sendMessage) {
    console.warn('⚠️ Premio detectado pero el bot Telegram no está disponible en global.__LOTO_BOT__.');
    return false;
  }

  const chatId = obtenerTelegramId(bet);
  if (!chatId) {
    console.warn(`⚠️ Premio #${premio?.id || 'N/D'} detectado para bet #${bet?.id || 'N/D'}, pero no se encontró Telegram ID en la apuesta.`);
    return false;
  }

  const numero = String(premio.numeros_ganadores || '').replace(/-/g, ' × ');
  const tipo = nombreTipo(premio.tipo_jugada);
  const montoPremio = Number(premio.monto_premio);
  const premioTexto = Number.isFinite(montoPremio) && premio.monto_premio !== null
    ? `$${fmtMoney(montoPremio)}`
    : 'pendiente de confirmación';

  const texto = [
    '🎉 *¡PREMIO DETECTADO!*',
    '',
    `🎰 *Sorteo:* ${resultado.loteria_id} / ${resultado.sorteo_id}`,
    `📅 *Fecha:* ${resultado.fecha}`,
    `🎯 *Tipo:* ${tipo}`,
    `🔢 *Número ganador:* ${numero}`,
    `💵 *Monto apostado:* $${fmtMoney(premio.monto_unitario)}`,
    `🏆 *Premio:* ${premioTexto}`,
    '',
    `🧾 *Apuesta:* #${bet.id}`,
    premio.monto_premio === null
      ? '⚠️ Este premio requiere confirmación manual.'
      : '✅ Premio calculado automáticamente.',
  ].join('\n');

  try {
    await bot.telegram.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
    console.log(`📤 Premio #${premio.id || 'N/D'} enviado por Telegram a ${chatId}.`);
    return true;
  } catch (error) {
    console.error(`❌ No se pudo enviar el premio #${premio.id || 'N/D'} a Telegram (${chatId}):`, error?.message || error);
    return false;
  }
}

/**
 * Cruza el resultado de un sorteo contra las jugadas (bets) de esa
 * lotería/sorteo/fecha y registra en `premios` cada línea ganadora.
 * Después de insertar un premio nuevo, lo notifica al usuario por Telegram.
 * La comprobación previa de existencia evita volver a notificar el mismo
 * premio cuando el userbot recibe varias veces el mismo resultado.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id:number, loteria_id:number, sorteo_id:number, fecha:string,
 *           numero_ganado: { fijo?:string, corrido?:string, centena?:string } }} resultado
 */
async function detectarPremios(supabase, resultado) {
  const { fijo, corrido, centena } = resultado.numero_ganado || {};
  if (!fijo && !corrido && !centena) return;

  const centenaCorta = centena ? String(centena).slice(-2) : null;
  const paresGanadores = new Set();
  if (fijo && corrido) paresGanadores.add([fijo, corrido].sort().join('-'));
  if (fijo && centenaCorta) paresGanadores.add([fijo, centenaCorta].sort().join('-'));
  if (corrido && centenaCorta) paresGanadores.add([corrido, centenaCorta].sort().join('-'));

  const { data: bets, error } = await supabase.from('bets').select('*')
    .eq('loteria_id', resultado.loteria_id)
    .eq('sorteo_id', resultado.sorteo_id)
    .eq('fecha_apuesta', resultado.fecha);
  if (error || !bets) return;

  for (const bet of bets) {
    let detalle;
    try { detalle = JSON.parse(bet.detalle); } catch (e) { continue; }
    if (!Array.isArray(detalle)) continue;

    for (const d of detalle) {
      const nums = (d.numeros || []).map(String);
      let match = false;
      let numerosGanadores = '';

      if (['fijo', 'corrido'].includes(d.tipo)) {
        if (fijo && nums.includes(fijo)) { match = true; numerosGanadores = fijo; }
        else if (corrido && nums.includes(corrido)) { match = true; numerosGanadores = corrido; }
      } else if (['centena', 'centena_global'].includes(d.tipo)) {
        if (centena && nums.includes(centena)) { match = true; numerosGanadores = centena; }
      } else if (['parle', 'parle_global', 'candado', 'candado_global'].includes(d.tipo)) {
        for (const p of (d.pares || [])) {
          const key = [String(p[0]).padStart(2, '0'), String(p[1]).padStart(2, '0')].sort().join('-');
          if (paresGanadores.has(key)) { match = true; numerosGanadores = key; break; }
        }
      }

      if (!match) continue;

      const { data: existe } = await supabase.from('premios').select('id')
        .eq('bet_id', bet.id).eq('numeros_ganadores', numerosGanadores).eq('tipo_jugada', d.tipo)
        .maybeSingle();
      if (existe) continue;

      const montoUnitario = Number(d.monto_unitario) || 0;
      const multiplicador = PAYOUT_MULTIPLIERS[d.tipo] || null;
      const montoPremio = multiplicador != null ? +(montoUnitario * multiplicador).toFixed(2) : null;

      const { data: premioInsertado, error: premioError } = await supabase.from('premios').insert([{
        bet_id: bet.id,
        resultado_id: resultado.id,
        numeros_ganadores: numerosGanadores,
        tipo_jugada: d.tipo,
        monto_apostado: d.monto,
        monto_unitario: montoUnitario,
        monto_premio: montoPremio,
        estado: montoPremio != null ? 'confirmado' : 'detectado',
      }]).select('*').single();

      if (premioError) {
        console.error(`❌ Error registrando premio para bet #${bet.id}:`, premioError.message || premioError);
        continue;
      }

      await notificarPremioTelegram(bet, premioInsertado, resultado);
    }
  }
}

module.exports = { detectarPremios, PAYOUT_MULTIPLIERS, notificarPremioTelegram };
