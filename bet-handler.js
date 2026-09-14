// Flujo de apuestas de Telegram.
// Se carga desde bet-bootstrap.js después de que bootstrap.js haya creado
// la instancia de Telegraf y registrado el catálogo.

const { createClient } = require('@supabase/supabase-js');

function fmtMoney(value) { return Number(value || 0).toFixed(2); }

async function replyLong(ctx, text, options = {}) {
  const MAX = 3900;
  const contenido = String(text || '');
  if (contenido.length <= MAX) { await ctx.reply(contenido, options); return; }
  const partes = [];
  let restante = contenido;
  while (restante.length > MAX) {
    let corte = restante.lastIndexOf('\n', MAX);
    if (corte < 1000) corte = restante.lastIndexOf(' ', MAX);
    if (corte < 1) corte = MAX;
    partes.push(restante.slice(0, corte));
    restante = restante.slice(corte).replace(/^\s+/, '');
  }
  if (restante) partes.push(restante);
  for (let i = 0; i < partes.length; i++) await ctx.reply(partes[i], { ...options });
}

function fechaCuba() {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const y = partes.find(p => p.type === 'year')?.value;
  const m = partes.find(p => p.type === 'month')?.value;
  const d = partes.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function horaMinutosCuba() {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number(partes.find(p => p.type === 'hour')?.value || 0);
  const m = Number(partes.find(p => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}

function detectarNumerosAmbiguos(texto) {
  const encontrados = [];
  const regex = /(^|[^\d])([0-9]{4})(?=$|[^\d])/g;
  let match;
  while ((match = regex.exec(String(texto || ''))) !== null) {
    const antes = String(texto || '').slice(0, match.index + match[1].length);
    if (/\b(?:con|a)\s*$/i.test(antes)) continue;
    encontrados.push(match[2]);
  }
  return [...new Set(encontrados)];
}

async function obtenerContextoUsuario(supabase, telegramId) {
  const { data: pref, error: prefError } = await supabase.from('user_preferences').select('loteria_id,sorteo_id,moneda').eq('telegram_id', telegramId).maybeSingle();
  if (prefError) throw prefError;
  if (!pref?.loteria_id || !pref?.sorteo_id) return { ok: false, message: '🎲 Primero selecciona una *lotería y un sorteo* con /start.' };
  const { data: sorteo, error: sorteoError } = await supabase.from('sorteos').select('id,nombre,loteria_id,hora_apertura,hora_cierre,activo').eq('id', pref.sorteo_id).eq('loteria_id', pref.loteria_id).maybeSingle();
  if (sorteoError) throw sorteoError;
  if (!sorteo || !sorteo.activo) return { ok: false, message: '❌ El sorteo seleccionado ya no está activo. Usa /start para seleccionar otro.' };
  const ahora = horaMinutosCuba();
  if (sorteo.hora_apertura && sorteo.hora_cierre) {
    const [ah, am] = String(sorteo.hora_apertura).slice(0, 5).split(':').map(Number);
    const [ch, cm] = String(sorteo.hora_cierre).slice(0, 5).split(':').map(Number);
    const apertura = ah * 60 + am, cierre = ch * 60 + cm;
    if (ahora < apertura) return { ok: false, message: `⏰ El sorteo *${sorteo.nombre}* aún no ha abierto.\nHorario: ${String(sorteo.hora_apertura).slice(0,5)} - ${String(sorteo.hora_cierre).slice(0,5)} (Cuba).` };
    if (ahora >= cierre) return { ok: false, message: `⏰ El sorteo *${sorteo.nombre}* ya cerró.\nHorario: ${String(sorteo.hora_apertura).slice(0,5)} - ${String(sorteo.hora_cierre).slice(0,5)} (Cuba).` };
  }
  return { ok: true, pref, sorteo };
}

async function validarLimites(supabase, loteriaId, sorteoId, fecha, detalles) {
  const { data: limites, error: limitesError } = await supabase.from('limits').select('tipo,monto_maximo').or(`loteria_id.eq.${loteriaId},loteria_id.is.null`).or(`sorteo_id.eq.${sorteoId},sorteo_id.is.null`);
  if (limitesError) throw limitesError;
  if (!limites?.length) return null;
  const limitesMap = {};
  for (const l of limites) limitesMap[l.tipo] = Number(l.monto_maximo);
  const { data: bets, error: betsError } = await supabase.from('bets').select('detalle').eq('loteria_id', loteriaId).eq('sorteo_id', sorteoId).eq('fecha_apuesta', fecha);
  if (betsError) throw betsError;
  const acumulado = {};
  for (const bet of bets || []) {
    try {
      const rows = JSON.parse(bet.detalle || '[]');
      for (const d of rows) {
        const tipo = (d.tipo === 'candado' || d.tipo === 'candado_global') ? 'parle' : d.tipo;
        const monto = Number(d.monto_unitario || 0);
        if (!monto) continue;
        for (const num of d.numeros || []) { const key = `${tipo}:${String(num)}`; acumulado[key] = (acumulado[key] || 0) + monto; }
      }
    } catch (_) {}
  }
  for (const d of detalles) {
    const tipo = (d.tipo === 'candado' || d.tipo === 'candado_global') ? 'parle' : d.tipo;
    const limite = limitesMap[tipo], monto = Number(d.monto_unitario || 0);
    if (!limite || !monto) continue;
    for (const num of d.numeros || []) {
      const key = `${tipo}:${String(num)}`, anterior = acumulado[key] || 0;
      if (anterior + monto > limite) return { numero: String(num), tipo, anterior, actual: monto, limite };
      acumulado[key] = anterior + monto;
    }
  }
  return null;
}

function normalizarDetalles(resultado) {
  return (resultado.jugadas || []).flatMap(j => j.jugadas_detalle || []).map(d => ({ tipo: d.tipo, numeros: d.numeros || [], pares: d.pares || null, combinaciones: d.combinaciones || '', monto: Number(d.monto || 0), monto_unitario: Number(d.monto_unitario || 0), linea: d.linea || null }));
}

function mensajeResultado(resultado, contexto) {
  let texto = `🧾 *Jugada calculada*\n\n`;
  texto += `🎰 ${contexto.loteriaNombre} — ${contexto.sorteo.nombre}\n`;
  texto += `💵 Moneda: ${String(contexto.moneda).toUpperCase()}\n\n`;
  texto += resultado.detalleTexto || '';
  texto += `\n💰 *TOTAL: $${fmtMoney(resultado.totalGeneral)}*`;
  return texto;
}

async function registrarFlujoApuesta(bot) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try { global.Tracer?.disableTrace?.(); } catch (_) {}

  bot.command('jugar', async (ctx) => {
    await ctx.reply('✍️ *Registrar jugada*\n\nEscribe ahora la jugada directamente, por ejemplo:\n`00 01 02 con 10`\n\nEl bot calculará el total, verificará límites y saldo antes de guardar.', { parse_mode: 'Markdown' });
  });

  bot.on('text', async (ctx) => {
    const texto = String(ctx.message?.text || '').trim();
    if (!texto || texto.startsWith('/')) return;
    try {
      const contexto = await obtenerContextoUsuario(supabase, ctx.from.id);
      if (!contexto.ok) { await ctx.reply(contexto.message, { parse_mode: 'Markdown' }); return; }

      const ambiguos = detectarNumerosAmbiguos(texto);
      if (ambiguos.length) {
        await ctx.reply(`⚠️ *Jugada requiere atención humana*\n\nSe detectó un número ambiguo de 4 cifras: *${ambiguos.join(', ')}*.\n\nEl bot no puede determinar de forma segura su interpretación.\n\n❌ *No se calculó ni se descontó saldo.*\n\nPor favor, solicita atención humana para confirmar la jugada.`, { parse_mode: 'Markdown' });
        return;
      }

      const { data: loteria, error: loteriaError } = await supabase.from('loterias').select('nombre').eq('id', contexto.pref.loteria_id).maybeSingle();
      if (loteriaError) throw loteriaError;
      const Engine = global.Engine, Preprocesador = global.Preprocesador, Utils = global.Utils, Expansion = global.Expansion;
      if (!Engine?.calcular || !Preprocesador?.preprocesarJugada || !Utils?.limpiarMonto || !Expansion) throw new Error('Motor LotoPro no disponible en el proceso del bot');

      const resultado = Engine.calcular({ rawInput: texto, loteriaId: contexto.pref.loteria_id, sorteoId: contexto.pref.sorteo_id }, { Expansion, limpiarMonto: Utils.limpiarMonto, preprocesarJugada: Preprocesador.preprocesarJugada, obtenerTimestampLocal: () => new Date().toISOString() });
      if (!resultado?.ok || !resultado.certified) {
        const errores = (resultado?.errors || []).map(e => `${e.line ? `Línea ${e.line}: ` : ''}${e.message || e.reason || 'Error de procesamiento'}`).join('\n');
        await replyLong(ctx, `❌ *No se puede guardar la jugada.*\n\n${resultado?.message || 'El motor detectó un error.'}${errores ? `\n\n• ${errores}` : ''}`, { parse_mode: 'Markdown' });
        return;
      }

      const total = Number(resultado.totalGeneral || 0);
      if (!Number.isFinite(total) || total <= 0) { await ctx.reply('❌ El total calculado no es válido. Revisa la jugada e inténtalo nuevamente.'); return; }
      const detalles = normalizarDetalles(resultado), fecha = fechaCuba();
      const limite = await validarLimites(supabase, contexto.pref.loteria_id, contexto.pref.sorteo_id, fecha, detalles);
      if (limite) {
        await ctx.reply(`🚫 *Límite excedido*\n\nNúmero: ${limite.numero}\nTipo: ${limite.tipo}\nAcumulado anterior: $${fmtMoney(limite.anterior)}\nEsta jugada: $${fmtMoney(limite.actual)}\nLímite: $${fmtMoney(limite.limite)}\n\nLa jugada no fue guardada.`, { parse_mode: 'Markdown' });
        return;
      }

      const { data: rpcData, error: rpcError } = await supabase.rpc('registrar_apuesta', { p_telegram_id: ctx.from.id, p_loteria_id: contexto.pref.loteria_id, p_sorteo_id: contexto.pref.sorteo_id, p_fecha: fecha, p_input_raw: texto, p_total: total, p_detalle: JSON.stringify(detalles), p_moneda: contexto.pref.moneda || 'cup' });
      if (rpcError) {
        const code = String(rpcError.message || '');
        if (code.includes('INSUFFICIENT_BALANCE')) {
          const { data: saldoUsuario, error: saldoError } = await supabase.from('users').select('saldo').eq('telegram_id', ctx.from.id).maybeSingle();
          if (saldoError) throw saldoError;
          const saldoDisponible = Number(saldoUsuario?.saldo || 0);
          const faltante = Math.max(0, total - saldoDisponible);

          const { data: existente } = await supabase.from('pending_bets').select('id,status').eq('user_telegram_id', ctx.from.id).eq('status', 'awaiting_balance').eq('original_input', texto).maybeSingle();
          let pendingId = existente?.id;
          if (!pendingId) {
            const { data: pending, error: pendingError } = await supabase.from('pending_bets').insert([{
              user_telegram_id: ctx.from.id, chat_id: ctx.chat.id, loteria_id: contexto.pref.loteria_id, sorteo_id: contexto.pref.sorteo_id,
              moneda: contexto.pref.moneda || 'cup', original_input: texto, ambiguous_numbers: [], status: 'awaiting_balance',
              error_message: `Saldo insuficiente. Total requerido: ${total}. Saldo disponible: ${saldoDisponible}. Faltante: ${faltante}.`
            }]).select('id').single();
            if (pendingError) throw pendingError;
            pendingId = pending.id;
          }
          await ctx.reply(`💰 *Saldo insuficiente*\n\nTotal de la jugada: *$${fmtMoney(total)}*\nSaldo disponible: *$${fmtMoney(saldoDisponible)}*\n❗ *Te faltan: $${fmtMoney(faltante)}*\n\nTu jugada quedó guardada como pendiente *#${pendingId}*.\n\nDeposita al menos el monto faltante. Cuando la recarga sea confirmada, recibirás botones para decidir si deseas procesarla.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Depositar saldo', callback_data: 'menu_depositar' }],[{ text: '📋 Ver jugada pendiente', callback_data: `balance_view_${pendingId}` }]] } });
          return;
        }
        if (code.includes('USER_NOT_FOUND')) { await ctx.reply('❌ Tu usuario todavía no está registrado. Envía /start e inténtalo de nuevo.'); return; }
        throw rpcError;
      }

      const fila = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      const saldoDespues = Number(fila?.saldo_despues || 0);
      const contextoTexto = { loteriaNombre: loteria?.nombre || 'Lotería', sorteo: contexto.sorteo, moneda: contexto.pref.moneda || 'cup' };
      await replyLong(ctx, `${mensajeResultado(resultado, contextoTexto)}\n\n✅ *Jugada guardada correctamente.*\n💰 Saldo restante: *$${fmtMoney(saldoDespues)}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('❌ Error procesando jugada:', err && err.stack ? err.stack : err);
      try { await ctx.reply('❌ Ocurrió un error al procesar la jugada. No se guardó ningún cargo. Intenta nuevamente.'); } catch (replyError) { console.error('❌ No se pudo enviar el mensaje de error a Telegram:', replyError && replyError.stack ? replyError.stack : replyError); }
    }
  });

  console.log('✅ Flujo de jugadas registrado');
}

module.exports = { registrarFlujoApuesta };