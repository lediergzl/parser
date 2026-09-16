// Registro de /pendientes sin depender del orden de los handlers de texto.
// Se carga como preload y espera a que bet-bootstrap.js cree el bot.
const { createClient } = require('@supabase/supabase-js');

function registrar(bot) {
  if (!bot || global.__LOTO_PENDING_LIST_REGISTERED__) return;
  global.__LOTO_PENDING_LIST_REGISTERED__ = true;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  function escaparMarkdown(texto) {
    return String(texto || '').replace(/([_*`\[\]])/g, '\\$1');
  }

  async function cargarPendientes(userId) {
    const { data, error } = await supabase
      .from('pending_bets')
      .select('id,original_input,status,loteria_id,sorteo_id,created_at')
      .eq('user_telegram_id', userId)
      .in('status', ['awaiting_balance', 'pending'])
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function mostrarPendientes(ctx) {
    try {
      const pendientes = await cargarPendientes(ctx.from.id);
      if (!pendientes.length) {
        await ctx.reply('✅ No tienes jugadas pendientes ni en revisión humana.');
        return;
      }

      for (const p of pendientes) {
        const esRevision = p.status === 'pending';
        const estado = esRevision ? '⚠️ EN REVISIÓN HUMANA' : '💰 PENDIENTE POR SALDO';
        const texto = [
          `📋 *Jugada #${p.id}*`,
          '',
          estado,
          `🎰 Lotería: ${p.loteria_id}`,
          `🎲 Sorteo: ${p.sorteo_id}`,
          `📝 Jugada: \`${escaparMarkdown(p.original_input)}\``,
          '',
          esRevision
            ? 'El bot no la ha calculado ni cobrado. Está esperando una interpretación segura.'
            : 'La jugada está guardada y espera saldo suficiente.'
        ].join('\n');

        const botones = esRevision
          ? [[{ text: `🔎 Ver revisión #${p.id}`, callback_data: `review_view_user_${p.id}` }]]
          : [[{ text: `🔎 Ver jugada #${p.id}`, callback_data: `balance_view_${p.id}` }], [{ text: '💵 Bajar monto', callback_data: `balance_adjust_${p.id}` }, { text: '❌ Cancelar', callback_data: `balance_cancel_${p.id}` }]];

        await ctx.reply(texto, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: botones } });
      }
    } catch (err) {
      console.error('❌ Error consultando jugadas pendientes:', err && err.stack ? err.stack : err);
      await ctx.reply('❌ No se pudieron consultar tus jugadas pendientes.');
    }
  }

  bot.command('pendientes', mostrarPendientes);
  bot.command('mis_jugadas', mostrarPendientes);
  console.log('✅ /pendientes disponible para consultar jugadas pendientes y en revisión');
}

function esperarBot() {
  if (global.__LOTO_BOT__) {
    registrar(global.__LOTO_BOT__);
    return;
  }
  setTimeout(esperarBot, 100);
}

esperarBot();

module.exports = { registrar };
