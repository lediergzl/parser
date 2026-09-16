// ============================================================================
// premios.js — Persistencia y notificación de premios.
// La detección/cálculo de ganadores vive en ganadores.js.
// ============================================================================
const { PAYOUT_MULTIPLIERS, obtenerGanadoresDelResultado } = require('./ganadores.js');
const bus = require('./lib/event-bus');

function obtenerTelegramId(bet) {
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

async function obtenerContextoResultado(supabase, resultado) {
  const contexto = {
    loteriaNombre: resultado?.loteriaNombre || resultado?.loteria_nombre || null,
    nombreSorteo: resultado?.nombreSorteo || resultado?.sorteoNombre || resultado?.sorteo_nombre || null,
  };

  if (!contexto.loteriaNombre && resultado?.loteria_id != null) {
    const { data } = await supabase.from('loterias').select('nombre').eq('id', resultado.loteria_id).maybeSingle();
    contexto.loteriaNombre = data?.nombre ? String(data.nombre).trim() : null;
  }

  if (!contexto.nombreSorteo && resultado?.sorteo_id != null) {
    const { data } = await supabase.from('sorteos').select('nombre').eq('id', resultado.sorteo_id).maybeSingle();
    contexto.nombreSorteo = data?.nombre ? String(data.nombre).trim() : null;
  }

  return contexto;
}

async function notificarPremioTelegram(bet, premio, resultado, supabase, contextoResultado = {}) {
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
  const posicion = premio.tipo_jugada === 'corrido' && premio.posicion_resultado != null
    ? `\n📍 *Posición del corrido:* ${premio.posicion_resultado}`
    : '';
  const loteria = contextoResultado.loteriaNombre || resultado?.loteriaNombre || resultado?.loteria_nombre || (resultado?.loteria_id != null ? `#${resultado.loteria_id}` : 'Lotería');
  const sorteo = contextoResultado.nombreSorteo || resultado?.nombreSorteo || resultado?.sorteoNombre || resultado?.sorteo_nombre || (resultado?.sorteo_id != null ? `#${resultado.sorteo_id}` : 'Sorteo');
  const texto = [
    '🎉 *¡PREMIO DETECTADO!*','',
    `🎰 *Lotería:* ${loteria}`,
    `🎟️ *Sorteo:* ${sorteo}`,
    `📅 *Fecha:* ${resultado.fecha}`,
    ...(jugador ? [`👤 *Jugador:* ${jugador}`] : []),
    `🎯 *Tipo:* ${tipo}`,
    `🔢 *Ganador:* ${numero}${posicion}`,
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

async function buscarPremioExistente(supabase, ganador) {
  let query = supabase.from('premios').select('*')
    .eq('bet_id', ganador.bet.id)
    .eq('numeros_ganadores', ganador.numeros_ganadores)
    .eq('tipo_jugada', ganador.tipo_jugada);

  if (ganador.tipo_jugada === 'corrido') {
    query = query.eq('posicion_resultado', ganador.posicion_resultado);
  } else {
    query = query.is('posicion_resultado', null);
  }

  return query.maybeSingle();
}

const ganadoresNotificados = new Set();

function claveGanador(resultado, ganador) {
  return [
    resultado?.id ?? '-',
    ganador?.bet?.id ?? '-',
    ganador?.tipo_jugada ?? '-',
    ganador?.numeros_ganadores ?? '-',
    ganador?.posicion_resultado ?? '-'
  ].join(':');
}

async function emitirPremioWhatsapp({ premio, resultado, bet, jugador, contextoResultado }) {
  const clave = claveGanador(resultado, { bet, tipo_jugada: premio?.tipo_jugada, numeros_ganadores: premio?.numeros_ganadores, posicion_resultado: premio?.posicion_resultado });
  if (ganadoresNotificados.has(clave)) return;
  ganadoresNotificados.add(clave);

  bus.emit('premio:detectado', {
    premio,
    resultado,
    bet,
    jugador,
    loteriaNombre: contextoResultado?.loteriaNombre || resultado?.loteriaNombre,
    nombreSorteo: contextoResultado?.nombreSorteo || resultado?.nombreSorteo,
  });
}

async function detectarPremios(supabase, resultado) {
  const contextoResultado = await obtenerContextoResultado(supabase, resultado);
  const obtenido = await obtenerGanadoresDelResultado(supabase, resultado);
  if (!obtenido.ok) {
    console.error('❌ No se pudieron obtener los ganadores:', obtenido.error);
    return { ok:false, ganadores:[], registrados:[], error:obtenido.error };
  }
  const registrados = [];
  for (const ganador of obtenido.ganadores) {
    const bet = ganador.bet, tipo = ganador.tipo_jugada, numero = ganador.numeros_ganadores;
    const { data: existe, error: existeError } = await buscarPremioExistente(supabase, ganador);
    if (existeError) { console.error(`❌ Error comprobando premio para bet #${bet.id}:`, existeError.message || existeError); continue; }

    if (existe) {
      console.log(`↩️ Premio ya registrado: bet #${bet.id} ${tipo} ${numero}${tipo === 'corrido' ? ` posición ${ganador.posicion_resultado}` : ''}`);
      let jugador = null;
      try { jugador = await obtenerNombreJugador(supabase, bet); } catch (_) {}
      await emitirPremioWhatsapp({ premio: existe, resultado, bet, jugador, contextoResultado });
      continue;
    }

    const { data: premioInsertado, error: premioError } = await supabase.from('premios').insert([{
      bet_id:bet.id, resultado_id:resultado.id, numeros_ganadores:numero, tipo_jugada:tipo,
      posicion_resultado: ganador.tipo_jugada === 'corrido' ? ganador.posicion_resultado : null,
      monto_apostado:ganador.monto_apostado, monto_unitario:ganador.monto_unitario,
      monto_premio:ganador.monto_premio, estado:ganador.monto_premio != null ? 'confirmado' : 'detectado'
    }]).select('*').single();
    if (premioError) { console.error(`❌ Error registrando premio para bet #${bet.id}:`, premioError.message || premioError); continue; }
    registrados.push(premioInsertado);

    let jugador = null;
    try { jugador = await obtenerNombreJugador(supabase, bet); } catch (_) {}

    await emitirPremioWhatsapp({ premio: premioInsertado, resultado, bet, jugador, contextoResultado });
    await notificarPremioTelegram(bet,premioInsertado,resultado,supabase,contextoResultado);
  }
  console.log(`🏆 Ganadores obtenidos: ${obtenido.ganadores.length}; premios nuevos registrados: ${registrados.length}.`);
  return { ok:true, ganadores:obtenido.ganadores, registrados };
}

module.exports = { detectarPremios, PAYOUT_MULTIPLIERS, notificarPremioTelegram, obtenerGanadoresDelResultado };
