// Conserva jugadas rechazadas solo por saldo insuficiente y las ofrece
// nuevamente cuando se confirma una recarga.
const { createClient } = require('@supabase/supabase-js');

async function registrarPendientesPorSaldo(bot) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const inicio = new Date().toISOString();
  const notificados = new Set();

  async function enviarOpciones(userId, pending) {
    const keyboard = {
      inline_keyboard: [
        [{ text: `✅ Procesar jugada #${pending.id}`, callback_data: `balance_process_${pending.id}` }],
        [{ text: '❌ Cancelar jugada pendiente', callback_data: `balance_cancel_${pending.id}` }]
      ]
    };
    await bot.telegram.sendMessage(
      userId,
      `💰 *Saldo confirmado*\n\nTu recarga ya fue confirmada. La jugada #${pending.id} que quedó pendiente por saldo insuficiente sigue guardada:\n\n\`${pending.original_input}\`\n\nPuedes decidir ahora si deseas procesarla. No se volverá a cobrar hasta que pulses *Procesar jugada*.`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  bot.action(/^balance_process_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase.from('pending_bets').select('*').eq('id', pendingId).eq('status', 'awaiting_balance').eq('user_telegram_id', ctx.from.id).maybeSingle();
    if (error) return ctx.reply('❌ No se pudo cargar la jugada pendiente.');
    if (!pending) return ctx.reply('ℹ️ Esta jugada ya no está pendiente por saldo.');

    const { data: user, error: userError } = await supabase.from('users').select('saldo').eq('telegram_id', ctx.from.id).maybeSingle();
    if (userError) return ctx.reply('❌ No se pudo comprobar el saldo.');
    if (!user) return ctx.reply('❌ Usuario no encontrado.');

    // Volvemos a ejecutar el flujo normal como el usuario original.
    // bet-handler.js vuelve a calcular, validar límites y cobrar de forma atómica.
    await ctx.reply('⏳ Procesando tu jugada pendiente. Se volverá a verificar saldo, límites y horario...');
    await bot.handleUpdate({
      update_id: (global.__LOTO_BALANCE_UPDATE_ID__ = (global.__LOTO_BALANCE_UPDATE_ID__ || 2000000) + 1),
      message: {
        message_id: Math.floor(Date.now() / 1000),
        date: Math.floor(Date.now() / 1000),
        chat: { id: pending.chat_id, type: 'private' },
        from: { id: pending.user_telegram_id, is_bot: false, first_name: 'Usuario' },
        text: pending.original_input
      }
    });

    // Si el flujo normal creó la apuesta, solo entonces cerramos la pendiente.
    const { data: bet, error: betError } = await supabase.from('bets')
      .select('id')
      .eq('user_telegram_id', pending.user_telegram_id)
      .eq('input_raw', pending.original_input)
      .eq('loteria_id', pending.loteria_id)
      .eq('sorteo_id', pending.sorteo_id)
      .gte('created_at', new Date(Date.now() - 30000).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (betError) {
      console.error('❌ Error verificando apuesta pendiente:', betError);
      return;
    }
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
      const { data: deposits, error } = await supabase.from('deposit_requests')
        .select('id,user_telegram_id,amount,status,updated_at')
        .eq('status', 'approved')
        .gte('updated_at', inicio)
        .order('updated_at', { ascending: true })
        .limit(50);
      if (error) throw error;
      for (const deposit of deposits || []) {
        if (notificados.has(deposit.id)) continue;
        const { data: pendientes, error: pendingError } = await supabase.from('pending_bets')
          .select('id,original_input,chat_id,loteria_id,sorteo_id,moneda')
          .eq('user_telegram_id', deposit.user_telegram_id)
          .eq('status', 'awaiting_balance')
          .order('created_at', { ascending: true })
          .limit(10);
        if (pendingError) throw pendingError;
        for (const pending of pendientes || []) {
          await enviarOpciones(deposit.user_telegram_id, pending);
        }
        notificados.add(deposit.id);
      }
    } catch (err) {
      console.error('❌ Error revisando recargas confirmadas:', err && err.stack ? err.stack : err);
    }
  }

  setInterval(revisarRecargasConfirmadas, 5000);
  console.log('✅ Control de jugadas pendientes por saldo registrado');
}

module.exports = { registrarPendientesPorSaldo };
