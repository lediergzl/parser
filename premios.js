// ============================================================================
// premios.js — Persistencia y notificación de premios.
// La detección/cálculo de ganadores vive en ganadores.js.
// ============================================================================
const { PAYOUT_MULTIPLIERS, obtenerGanadoresDelResultado } = require('./ganadores.js');

function obtenerTelegramId(bet) {
  // Una apuesta comercial NO tiene Telegram del jugador.
  // Para notificar, usamos únicamente el Telegram del comercial responsable.
  const candidatos = [bet?.comercial_telegram_id, bet?.telegram_id, bet?.user_telegram_id];
  for (const valor of candidatos) {
    if (valor !== null && valor !== undefined && String(valor).trim() !== '') return String(valor).trim();
  }
  return null;
}

function nombreTipo(tipo) {
  return ({ fijo:'Fijo', rango:'Fijo', corrido:'Corrido', centena:'Centena', centena_global:'Centena global', parle:'Parle', parle_global:'Parle global', candado:'Candado', candado_combinaciones:'Candado', candado_global:'Candado global' })[tipo] || String(tipo || 'Jugada');
}
function fmtMoney(value) { return Number(value || 0).toFixed(2); }

async function obtenerNombreJugador(supabase, bet) {
  if (!bet?.cliente_banca_id) return null;
  const { data, error } = await supabase.from('clientes_banca').select('nombre').eq('id', bet.cliente_banca_id).maybeSingle();
  if (error) {
    console.warn(`⚠️ No se pudo obtener el nombre del cliente de banca para bet #${bet.id}:`, error.message || error);
    return null;
  }
  return data?.nombre ? String(data.nombre).trim() : null;
}

async function notificarPremioTelegram(bet, premio, resultado, supabase) {
  const bot = global.__LOTO_BOT__;
  if (!bot?.telegram?.sendMessage) {
    console.warn('⚠️ Premio detectado pero el bot Telegram no está disponible en global.__LOTO_BOT__.');
    return false;
  }
  const chatId = obtenerTelegramId(bet);
  if (!chatId) {
    console.warn(`⚠️ Premio #${premio?.id || 'N/D'} detectado para bet #${bet?.id || 'N/D'}, pero no se encontró Telegram del comercial/usuario.`);
    return false;
  }

  const jugador = await obtenerNombreJugador(supabase, bet);
  const numero = String(premio.numeros_ganadores || '').replace(/-/g, ' × ');
  const tipo = nombreTipo(premio.tipo_jugada);
  const montoPremio = Number(premio.monto_premio);
  const premioTexto = Number.isFinite(montoPremio) && premio.monto_premio !== null ? `$${fmtMoney(montoPremio)}` : 'pendiente de confirmación';
  const texto = [
    '🎉 *¡PREMIO DETECTADO!*','',
    `🎰 *Lotería:* ${resultado.loteria_id}`,
    `🎟️ *Sorteo:* ${resultado.sorteo_id}`,
    `📅 *Fecha:* ${resultado.fecha}`,
    ...(jugador ? [`👤 *Jugador:* ${jugador}`] : []),
    `🎯 *Tipo:* ${tipo}`,
    `🔢 *Ganador:* ${numero}`,
    `💵 *Apostado:* $${fmtMoney(premio.monto_unitario)}`,
    `🏆 *Premio:* ${premioTexto}`,'',
    `🧾 *Apuesta:* #${bet.id}`,
    premio.monto_premio === null ? '⚠️ Este premio requiere confirmación manual.' : '✅ Premio calculado automáticamente.'
  ].join('\n');
  try {
    await bot.telegram.sendMessage(chatId, texto, { parse_mode:'Markdown' });
    console.log(`📤 Premio #${premio.id || 'N/D'} enviado al responsable de la apuesta #${bet.id}.`);
    return true;
  } catch (error) {
    console.error(`❌ No se pudo enviar el premio #${premio.id || 'N/D'} a Telegram:`, error?.message || error);
    return false;
  }
}

async function detectarPremios(supabase, resultado) {
  const obtenido = await obtenerGanadoresDelResultado(supabase, resultado);
  if (!obtenido.ok) {
    console.error('❌ No se pudieron obtener los ganadores:', obtenido.error);
    return { ok:false, ganadores:[], registrados:[], error:obtenido.error };
  }
  const registrados = [];
  for (const ganador of obtenido.ganadores) {
    const bet = ganador.bet, tipo = ganador.tipo_jugada, numero = ganador.numeros_ganadores;
    const { data: existe, error: existeError } = await supabase.from('premios').select('id').eq('bet_id',bet.id).eq('numeros_ganadores',numero).eq('tipo_jugada',tipo).maybeSingle();
    if (existeError) { console.error(`❌ Error comprobando premio para bet #${bet.id}:`, existeError.message || existeError); continue; }
    if (existe) { console.log(`↩️ Premio ya registrado: bet #${bet.id} ${tipo} ${numero}`); continue; }
    const { data: premioInsertado, error: premioError } = await supabase.from('premios').insert([{
      bet_id:bet.id, resultado_id:resultado.id, numeros_ganadores:numero, tipo_jugada:tipo,
      monto_apostado:ganador.monto_apostado, monto_unitario:ganador.monto_unitario,
      monto_premio:ganador.monto_premio, estado:ganador.monto_premio != null ? 'confirmado' : 'detectado'
    }]).select('*').single();
    if (premioError) { console.error(`❌ Error registrando premio para bet #${bet.id}:`, premioError.message || premioError); continue; }
    registrados.push(premioInsertado);
    await notificarPremioTelegram(bet,premioInsertado,resultado,supabase);
  }
  console.log(`🏆 Ganadores obtenidos: ${obtenido.ganadores.length}; premios nuevos registrados: ${registrados.length}.`);
  return { ok:true, ganadores:obtenido.ganadores, registrados };
}

module.exports = { detectarPremios, PAYOUT_MULTIPLIERS, notificarPremioTelegram, obtenerGanadoresDelResultado };
