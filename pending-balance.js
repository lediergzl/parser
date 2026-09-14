// Conserva jugadas rechazadas solo por saldo insuficiente y permite
// procesarlas, cancelarlas o reducir su monto sin perder la jugada original.
const { createClient } = require('@supabase/supabase-js');

async function registrarPendientesPorSaldo(bot) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const inicio = new Date().toISOString();
  const notificados = new Set();
  const ajustesEnCurso = new Map();

  function fmtMoney(value) { return Number(value || 0).toFixed(2); }

  function normalizarConectorPegado(texto) {
    return String(texto || '').replace(/(\d)a\s+(?=\$?\d+(?:[.,]\d+)?)/gi, '$1 a ');
  }

  function extraerMontos(texto) {
    const normalizado = normalizarConectorPegado(texto);
    const regex = /\b(?:con|a|de|parle|candado|p|c)\s+\$?\s*(\d+(?:[.,]\d+)?)\b/gi;
    const encontrados = [];
    let match;
    while ((match = regex.exec(normalizado)) !== null) encontrados.push(match[1]);
    return encontrados;
  }

  function reemplazarMontos(texto, nuevoMonto) {
    const normalizado = normalizarConectorPegado(texto);
    return normalizado.replace(
      /(\b(?:con|a|de|parle|candado|p|c)\s+\$?\s*)\d+(?:[.,]\d+)?\b/gi,
      `$1${nuevoMonto}`
    );
  }

  async function calcularTotal(texto, pending) {
    const Engine = global.Engine;
    const Expansion = global.Expansion;
    const Preprocesador = global.Preprocesador;
    const Utils = global.Utils;
    if (!Engine?.calcular || !Preprocesador?.preprocesarJugada || !Utils?.limpiarMonto || !Expansion) {
      throw new Error('Motor LotoPro no disponible para ajustar la jugada');
    }
    return Engine.calcular(
      { rawInput: texto, loteriaId: pending.loteria_id, sorteoId: pending.sorteo_id },
      {
        Expansion,
        limpiarMonto: Utils.limpiarMonto,
        preprocesarJugada: Preprocesador.preprocesarJugada,
        obtenerTimestampLocal: () => new Date().toISOString()
      }
    );
  }

  async function enviarOpciones(userId, pending) {
    const keyboard = { inline_keyboard: [
      [{ text: `✅ Procesar jugada #${pending.id}`, callback_data: `balance_process_${pending.id}` }],
      [{ text: '💵 Bajar monto de la jugada', callback_data: `balance_adjust_${pending.id}` }],
      [{ text: '❌ Cancelar jugada pendiente', callback_data: `balance_cancel_${pending.id}` }]
    ]};
    await bot.telegram.sendMessage(userId, `💰 *Saldo confirmado*\n\nTu recarga ya fue confirmada. La jugada #${pending.id} que quedó pendiente por saldo insuficiente sigue guardada:\n\n\`${pending.original_input}\`\n\nPuedes procesarla, bajar el monto o cancelarla. No se cobrará nada hasta que elijas una opción.`, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  bot.action(/^balance_view_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase.from('pending_bets').select('id,original_input,status').eq('id', pendingId).eq('user_telegram_id', ctx.from.id).maybeSingle();
    if (error) return ctx.reply('❌ No se pudo cargar la jugada pendiente.');
    if (!pending || pending.status !== 'awaiting_balance') return ctx.reply('ℹ️ Esta jugada ya no está pendiente por saldo.');
    await ctx.reply(`📋 *Jugada pendiente #${pending.id}*\n\n\`${pending.original_input}\`\n\nPuedes conservarla, bajar el monto o cancelarla.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💵 Bajar monto de la jugada', callback_data: `balance_adjust_${pending.id}` }],[{ text: '❌ Cancelar jugada pendiente', callback_data: `balance_cancel_${pending.id}` }]] } });
  });

  bot.action(/^balance_adjust_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase.from('pending_bets').select('id,original_input,status').eq('id', pendingId).eq('user_telegram_id', ctx.from.id).maybeSingle();
    if (error) return ctx.reply('❌ No se pudo cargar la jugada pendiente.');
    if (!pending || pending.status !== 'awaiting_balance') return ctx.reply('ℹ️ Esta jugada ya no está pendiente por saldo.');

    const montos = extraerMontos(pending.original_input);
    const distintos = [...new Set(montos.map(m => Number(String(m).replace(',', '.')).toFixed(8)))];
    if (distintos.length !== 1) {
      return ctx.reply('✏️ Esta jugada contiene varios montos diferentes. Para evitar modificar una parte incorrectamente, envía la jugada completa con los montos que deseas usar. La jugada pendiente original seguirá guardada hasta que una nueva jugada sea procesada correctamente.', { parse_mode: 'Markdown' });
    }

    ajustesEnCurso.set(ctx.from.id, pending.id);
    await ctx.reply(`💵 *Bajar monto de la jugada #${pending.id}*\n\nMonto actual: *$${fmtMoney(Number(montos[0].replace(',', '.')))}*\n\nEscribe ahora el *nuevo monto por jugada* (ejemplo: \`0.50\`).\n\nLa jugada original no se perderá ni se cobrará mientras haces el ajuste.`, { parse_mode: 'Markdown' });
  });

  bot.on('text', async (ctx, next) => {
    const pendingId = ajustesEnCurso.get(ctx.from.id);
    if (!pendingId) return next();

    ajustesEnCurso.delete(ctx.from.id);
    const textoMonto = String(ctx.message?.text || '').trim().replace(',', '.').replace(/^\$/, '');
    const monto = Number(textoMonto);
    if (!Number.isFinite(monto) || monto <= 0 || monto > 1000000) {
      await ctx.reply('❌ Monto no válido. Debe ser un número mayor que 0. Ejemplo: `0.50`.', { parse_mode: 'Markdown' });
      return;
    }

    const { data: pending, error: pendingError } = await supabase.from('pending_bets').select('*').eq('id', pendingId).eq('user_telegram_id', ctx.from.id).eq('status', 'awaiting_balance').maybeSingle();
    if (pendingError) { await ctx.reply('❌ No se pudo cargar la jugada pendiente.'); return; }
    if (!pending) { await ctx.reply('ℹ️ Esta jugada ya no está pendiente por saldo.'); return; }

    try {
      const nuevoInput = reemplazarMontos(pending.original_input, textoMonto);
      const resultado = await calcularTotal(nuevoInput, pending);
      if (!resultado?.ok || !resultado.certified) {
        const errores = (resultado?.errors || []).map(e => `${e.line ? `Línea ${e.line}: ` : ''}${e.message || e.reason || 'Error de procesamiento'}`).join('\n');
        await ctx.reply(`❌ El nuevo monto produjo una jugada inválida.${errores ? `\n\n${errores}` : ''}`, { parse_mode: 'Markdown' });
        return;
      }

      const total = Number(resultado.totalGeneral || 0);
      const { data: user, error: userError } = await supabase.from('users').select('saldo').eq('telegram_id', ctx.from.id).maybeSingle();
      if (userError) throw userError;
      if (!user) { await ctx.reply('❌ Usuario no encontrado.'); return; }
      const saldo = Number(user.saldo || 0);

      if (!Number.isFinite(total) || total <= 0) {
        await ctx.reply('❌ El total calculado no es válido.');
        return;
      }

      if (total > saldo + 0.000001) {
        const falta = total - saldo;
        await ctx.reply(`❌ Ese monto todavía supera tu saldo.\n\nTotal de la nueva jugada: *$${fmtMoney(total)}*\nSaldo disponible: *$${fmtMoney(saldo)}*\nTe faltan: *$${fmtMoney(falta)}*\n\nLa jugada original sigue guardada como pendiente. Pulsa *Bajar monto* e intenta con un monto menor.`, { parse_mode: 'Markdown' });
        return;
      }

      const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const detalles = (resultado.jugadas || []).flatMap(j => j.jugadas_detalle || []).map(d => ({ tipo: d.tipo, numeros: d.numeros || [], pares: d.pares || null, combinaciones: d.combinaciones || '', monto: Number(d.monto || 0), monto_unitario: Number(d.monto_unitario || 0), linea: d.linea || null }));
      const { data: limites, error: limitesError } = await supabase.from('limits').select('tipo,monto_maximo').or(`loteria_id.eq.${pending.loteria_id},loteria_id.is.null`).or(`sorteo_id.eq.${pending.sorteo_id},sorteo_id.is.null`);
      if (limitesError) throw limitesError;
      if (limites?.length) {
        const mapa = {};
        for (const l of limites) mapa[l.tipo] = Number(l.monto_maximo);
        for (const d of detalles) {
          const tipo = (d.tipo === 'candado' || d.tipo === 'candado_global') ? 'parle' : d.tipo;
          const limite = mapa[tipo];
          if (!limite) continue;
          for (const numero of d.numeros || []) {
            if (Number(d.monto_unitario || 0) > limite) {
              await ctx.reply(`🚫 El nuevo monto excede el límite configurado para ${tipo} en el número ${numero}.`, { parse_mode: 'Markdown' });
              return;
            }
          }
        }
      }

      await ctx.reply(`⏳ Procesando la jugada ajustada #${pending.id} por *$${fmtMoney(total)}*...`, { parse_mode: 'Markdown' });
      await bot.handleUpdate({
        update_id: (global.__LOTO_BALANCE_ADJUST_UPDATE_ID__ = (global.__LOTO_BALANCE_ADJUST_UPDATE_ID__ || 3000000) + 1),
        message: {
          message_id: Math.floor(Date.now() / 1000), date: Math.floor(Date.now() / 1000),
          chat: { id: pending.chat_id, type: 'private' },
          from: { id: pending.user_telegram_id, is_bot: false, first_name: 'Usuario' },
          text: nuevoInput
        }
      });

      const { data: bet, error: betError } = await supabase.from('bets').select('id')
        .eq('user_telegram_id', pending.user_telegram_id).eq('input_raw', nuevoInput)
        .eq('loteria_id', pending.loteria_id).eq('sorteo_id', pending.sorteo_id)
        .gte('created_at', new Date(Date.now() - 30000).toISOString())
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (betError) throw betError;

      if (bet) {
        await supabase.from('pending_bets').update({ status: 'processed', corrected_input: nuevoInput, reviewed_by: ctx.from.id, reviewed_at: new Date(), updated_at: new Date(), error_message: `Jugada ajustada de monto. Original: ${pending.original_input}` }).eq('id', pending.id).eq('status', 'awaiting_balance');
        await ctx.reply(`✅ *Jugada ajustada y guardada.*\n\nOriginal: \`${pending.original_input}\`\nNueva: \`${nuevoInput}\`\nTotal cobrado: *$${fmtMoney(total)}*`, { parse_mode: 'Markdown' });
        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
      } else {
        await ctx.reply('⚠️ No pude confirmar el registro de la jugada ajustada. La jugada pendiente original se conserva sin cambios.');
      }
    } catch (err) {
      console.error('❌ Error ajustando jugada pendiente:', err && err.stack ? err.stack : err);
      await ctx.reply('❌ Ocurrió un error al ajustar la jugada. La jugada pendiente original se conserva sin cambios.');
    }
  });

  bot.action(/^balance_process_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase.from('pending_bets').select('*').eq('id', pendingId).eq('status', 'awaiting_balance').eq('user_telegram_id', ctx.from.id).maybeSingle();
    if (error) return ctx.reply('❌ No se pudo cargar la jugada pendiente.');
    if (!pending) return ctx.reply('ℹ️ Esta jugada ya no está pendiente por saldo.');

    const { data: user, error: userError } = await supabase.from('users').select('saldo').eq('telegram_id', ctx.from.id).maybeSingle();
    if (userError) return ctx.reply('❌ No se pudo comprobar el saldo.');
    if (!user) return ctx.reply('❌ Usuario no encontrado.');

    await ctx.reply('⏳ Procesando tu jugada pendiente. Se volverá a verificar saldo, límites y horario...');
    await bot.handleUpdate({
      update_id: (global.__LOTO_BALANCE_UPDATE_ID__ = (global.__LOTO_BALANCE_UPDATE_ID__ || 2000000) + 1),
      message: {
        message_id: Math.floor(Date.now() / 1000), date: Math.floor(Date.now() / 1000),
        chat: { id: pending.chat_id, type: 'private' },
        from: { id: pending.user_telegram_id, is_bot: false, first_name: 'Usuario' },
        text: pending.original_input
      }
    });

    const { data: bet, error: betError } = await supabase.from('bets').select('id')
      .eq('user_telegram_id', pending.user_telegram_id).eq('input_raw', pending.original_input)
      .eq('loteria_id', pending.loteria_id).eq('sorteo_id', pending.sorteo_id)
      .gte('created_at', new Date(Date.now() - 30000).toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (betError) { console.error('❌ Error verificando apuesta pendiente:', betError); return; }
    if (bet) {
      await supabase.from('pending_bets').update({ status: 'processed', reviewed_at: new Date(), updated_at: new Date() }).eq('id', pending.id).eq('status', 'awaiting_balance');
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
    }
  });

  bot.action(/^balance_cancel_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase.from('pending_bets').select('id').eq('id', pendingId).eq('status', 'awaiting_balance').eq('user_telegram_id', ctx.from.id).maybeSingle();
    if (error) return ctx.reply('❌ No se pudo cargar la jugada pendiente.');
    if (!pending) return ctx.reply('ℹ️ La jugada ya fue atendida.');
    await supabase.from('pending_bets').update({ status: 'rejected', reviewed_by: ctx.from.id, reviewed_at: new Date(), updated_at: new Date(), error_message: 'Cancelada por el usuario después de recarga' }).eq('id', pendingId).eq('status', 'awaiting_balance');
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
    await ctx.reply('❌ Jugada pendiente cancelada. No se realizó ningún cobro adicional.');
  });

  async function revisarRecargasConfirmadas() {
    try {
      const { data: deposits, error } = await supabase.from('deposit_requests').select('id,user_telegram_id,amount,status,updated_at').eq('status', 'approved').gte('updated_at', inicio).order('updated_at', { ascending: true }).limit(50);
      if (error) throw error;
      for (const deposit of deposits || []) {
        if (notificados.has(deposit.id)) continue;
        const { data: pendientes, error: pendingError } = await supabase.from('pending_bets').select('id,original_input,chat_id,loteria_id,sorteo_id,moneda').eq('user_telegram_id', deposit.user_telegram_id).eq('status', 'awaiting_balance').order('created_at', { ascending: true }).limit(10);
        if (pendingError) throw pendingError;
        for (const pending of pendientes || []) await enviarOpciones(deposit.user_telegram_id, pending);
        notificados.add(deposit.id);
      }
    } catch (err) { console.error('❌ Error revisando recargas confirmadas:', err && err.stack ? err.stack : err); }
  }

  setInterval(revisarRecargasConfirmadas, 5000);
  console.log('✅ Control de jugadas pendientes por saldo registrado');
}

module.exports = { registrarPendientesPorSaldo };
