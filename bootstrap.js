// Bootstrap de arranque para Render.
// index.js crea Express y Telegraf; aquí capturamos ambas instancias,
// registramos los callbacks del menú y arrancamos el servidor.

console.log('🔎 Bootstrap LotoPro iniciando...');
console.log('🔎 Node:', process.version);
console.log('🔎 SUPABASE_URL:', !!process.env.SUPABASE_URL);
console.log('🔎 SUPABASE_SERVICE_ROLE_KEY:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log('🔎 TELEGRAM_BOT_TOKEN:', !!process.env.TELEGRAM_BOT_TOKEN);
console.log('🔎 ADMIN_IDS:', !!process.env.ADMIN_IDS);

process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION DURANTE EL ARRANQUE:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ UNHANDLED REJECTION DURANTE EL ARRANQUE:');
  console.error(reason && reason.stack ? reason.stack : reason);
  process.exitCode = 1;
});

const expressModulePath = require.resolve('express');
const realExpress = require('express');
const wrappedExpress = function (...args) {
  const app = realExpress(...args);
  app.use(realExpress.json());
  global.__LOTO_APP__ = app;
  return app;
};
Object.assign(wrappedExpress, realExpress);
require.cache[expressModulePath].exports = wrappedExpress;

const telegrafModulePath = require.resolve('telegraf');
const realTelegrafModule = require('telegraf');
const RealTelegraf = realTelegrafModule.Telegraf;
class CapturedTelegraf extends RealTelegraf {
  constructor(...args) {
    super(...args);
    global.__LOTO_BOT__ = this;
  }
}
require.cache[telegrafModulePath].exports = {
  ...realTelegrafModule,
  Telegraf: CapturedTelegraf
};

function fmtMoney(value) {
  return Number(value || 0).toFixed(2);
}

async function registerMenuCallbacks(bot) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
  const depositStates = new Map();
  global.__LOTO_DEPOSIT_STATES__ = depositStates;

  const answer = async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
  };

  const mainKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎲 Seleccionar Lotería/Sorteo', callback_data: 'menu_loterias' }],
        [{ text: '💵 Cambiar Moneda', callback_data: 'menu_moneda' }],
        [{ text: '📋 Mis Jugadas', callback_data: 'menu_mis_jugadas' }],
        [{ text: '💰 Depositar', callback_data: 'menu_depositar' }],
        [{ text: '📜 Historial', callback_data: 'menu_historial' }],
        [{ text: '⚙️ Ayuda', callback_data: 'menu_ayuda' }]
      ]
    }
  };

  bot.action('menu_loterias', async (ctx) => {
    await answer(ctx);
    try {
      const { data, error } = await supabase.from('loterias').select('id,nombre').eq('activo', true).order('id');
      if (error) throw error;
      if (!data?.length) {
        return ctx.editMessageText('🎲 *Loterías*\n\nNo hay loterías activas configuradas.', { parse_mode: 'Markdown', ...mainKeyboard });
      }
      const keyboard = data.map(l => [{ text: `🎰 ${l.nombre}`, callback_data: `loteria_${l.id}` }]);
      keyboard.push([{ text: '🏠 Menú principal', callback_data: 'menu_principal' }]);
      await ctx.editMessageText('🎲 *Selecciona una lotería:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      console.error('menu_loterias:', err);
      await ctx.editMessageText('❌ No se pudieron cargar las loterías.', mainKeyboard);
    }
  });

  bot.action(/^loteria_(\d+)$/, async (ctx) => {
    await answer(ctx);
    try {
      const loteriaId = Number(ctx.match[1]);
      const { data: loteria, error: le } = await supabase.from('loterias').select('id,nombre').eq('id', loteriaId).single();
      if (le || !loteria) throw new Error('Lotería no encontrada');
      const { data: sorteos, error } = await supabase.from('sorteos').select('id,nombre,hora_apertura,hora_cierre').eq('loteria_id', loteriaId).eq('activo', true).order('hora_apertura');
      if (error) throw error;
      if (!sorteos?.length) {
        return ctx.editMessageText(`🎰 *${loteria.nombre}*\n\nNo hay sorteos activos configurados.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_loterias' }],[{ text: '🏠 Menú principal', callback_data: 'menu_principal' }]] } });
      }
      const keyboard = sorteos.map(s => {
        const horario = s.hora_apertura && s.hora_cierre ? ` (${String(s.hora_apertura).slice(0,5)}-${String(s.hora_cierre).slice(0,5)})` : '';
        return [{ text: `🕒 ${s.nombre}${horario}`, callback_data: `sorteo_${s.id}` }];
      });
      keyboard.push([{ text: '⬅️ Volver', callback_data: 'menu_loterias' }]);
      await ctx.editMessageText(`🎰 *${loteria.nombre}*\n\nSelecciona el sorteo:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      console.error('loteria callback:', err);
      await ctx.editMessageText('❌ No se pudieron cargar los sorteos.', mainKeyboard);
    }
  });

  bot.action(/^sorteo_(\d+)$/, async (ctx) => {
    await answer(ctx);
    try {
      const sorteoId = Number(ctx.match[1]);
      const { data: sorteo, error } = await supabase.from('sorteos').select('id,nombre,loteria_id').eq('id', sorteoId).single();
      if (error || !sorteo) throw new Error('Sorteo no encontrado');
      const { data: loteria } = await supabase.from('loterias').select('nombre').eq('id', sorteo.loteria_id).single();
      const { data: pref } = await supabase.from('user_preferences').select('moneda').eq('telegram_id', ctx.from.id).maybeSingle();
      const moneda = pref?.moneda || 'cup';
      const { error: saveError } = await supabase.from('user_preferences').upsert({ telegram_id: ctx.from.id, loteria_id: sorteo.loteria_id, sorteo_id: sorteo.id, moneda, updated_at: new Date() }, { onConflict: 'telegram_id' });
      if (saveError) throw saveError;
      await ctx.editMessageText(`✅ *Sorteo seleccionado*\n\n🎰 ${loteria?.nombre || 'Lotería'}\n🕒 ${sorteo.nombre}\n💵 Moneda: ${moneda.toUpperCase()}\n\nYa puedes continuar.`, { parse_mode: 'Markdown', ...mainKeyboard });
    } catch (err) {
      console.error('sorteo callback:', err);
      await ctx.editMessageText('❌ No se pudo guardar el sorteo seleccionado.', mainKeyboard);
    }
  });

  bot.action('menu_moneda', async (ctx) => {
    await answer(ctx);
    await ctx.editMessageText('💵 *Selecciona la moneda:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🇨🇺 CUP', callback_data: 'moneda_cup' }, { text: '💵 USD', callback_data: 'moneda_usd' }],[{ text: '⬅️ Volver', callback_data: 'menu_principal' }]] } });
  });

  for (const moneda of ['cup', 'usd']) {
    bot.action(`moneda_${moneda}`, async (ctx) => {
      await answer(ctx);
      try {
        const { data: current } = await supabase.from('user_preferences').select('loteria_id,sorteo_id').eq('telegram_id', ctx.from.id).maybeSingle();
        const { error } = await supabase.from('user_preferences').upsert({ telegram_id: ctx.from.id, loteria_id: current?.loteria_id || null, sorteo_id: current?.sorteo_id || null, moneda, updated_at: new Date() }, { onConflict: 'telegram_id' });
        if (error) throw error;
        await ctx.editMessageText(`✅ Moneda cambiada a *${moneda.toUpperCase()}*.`, { parse_mode: 'Markdown', ...mainKeyboard });
      } catch (err) {
        console.error('moneda callback:', err);
        await ctx.editMessageText('❌ No se pudo cambiar la moneda.', mainKeyboard);
      }
    });
  }

  bot.action('menu_mis_jugadas', async (ctx) => {
    await answer(ctx);
    try {
      const { data: bets, error } = await supabase.from('bets').select('id,fecha_apuesta,total_apuesta,moneda,created_at,sorteos(nombre)').eq('user_telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(10);
      if (error) throw error;
      if (!bets?.length) return ctx.editMessageText('📋 *Mis Jugadas*\n\nNo tienes jugadas registradas todavía.', { parse_mode: 'Markdown', ...mainKeyboard });
      const lines = bets.map((b, i) => `${i + 1}. ${b.fecha_apuesta} — ${b.sorteos?.nombre || 'Sorteo'} — $${fmtMoney(b.total_apuesta)} ${String(b.moneda || 'cup').toUpperCase()}`);
      await ctx.editMessageText(`📋 *Mis Jugadas*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...mainKeyboard });
    } catch (err) {
      console.error('mis jugadas:', err);
      await ctx.editMessageText('❌ No se pudieron cargar tus jugadas.', mainKeyboard);
    }
  });

  bot.action('menu_historial', async (ctx) => {
    await answer(ctx);
    try {
      const { data: bets, error } = await supabase.from('bets').select('fecha_apuesta,total_apuesta,moneda,sorteos(nombre)').eq('user_telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(20);
      if (error) throw error;
      if (!bets?.length) return ctx.editMessageText('📜 *Historial*\n\nNo hay movimientos de apuestas registrados.', { parse_mode: 'Markdown', ...mainKeyboard });
      const total = bets.reduce((s, b) => s + Number(b.total_apuesta || 0), 0);
      const lines = bets.slice(0, 12).map(b => `• ${b.fecha_apuesta} — ${b.sorteos?.nombre || 'Sorteo'} — $${fmtMoney(b.total_apuesta)} ${String(b.moneda || 'cup').toUpperCase()}`);
      await ctx.editMessageText(`📜 *Historial*\n\n${lines.join('\n')}\n\n💵 Total mostrado: $${fmtMoney(total)}`, { parse_mode: 'Markdown', ...mainKeyboard });
    } catch (err) {
      console.error('historial:', err);
      await ctx.editMessageText('❌ No se pudo cargar el historial.', mainKeyboard);
    }
  });

  bot.action('menu_depositar', async (ctx) => {
    await answer(ctx);
    depositStates.set(ctx.from.id, { step: 'method' });
    await ctx.editMessageText(
      '💰 *Recargar saldo*\n\nSelecciona el método de pago que vas a utilizar:',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '📲 Transfermóvil', callback_data: 'deposit_method_transfermovil' }],
          [{ text: '💳 EnZona', callback_data: 'deposit_method_enzona' }],
          [{ text: '🏠 Menú principal', callback_data: 'menu_principal' }]
        ] }
      }
    );
  });

  for (const method of ['transfermovil', 'enzona']) {
    bot.action(`deposit_method_${method}`, async (ctx) => {
      await answer(ctx);
      depositStates.set(ctx.from.id, { step: 'amount', paymentMethod: method });
      await ctx.editMessageText(
        `💰 *Recarga por ${method === 'transfermovil' ? 'Transfermóvil' : 'EnZona'}*\n\nEscribe ahora el monto que deseas recargar.\n\nEjemplo: \`1000\`\n\nDespués te pediré el comprobante.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'deposit_cancel' }]] } }
      );
    });
  }

  bot.action('deposit_cancel', async (ctx) => {
    await answer(ctx);
    depositStates.delete(ctx.from.id);
    await ctx.editMessageText('❌ Recarga cancelada.', { ...mainKeyboard });
  });

  bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const state = depositStates.get(userId);
    if (!state) return next();
    const text = String(ctx.message?.text || '').trim();
    if (!text || text.startsWith('/')) return next();

    if (state.step === 'amount') {
      const amount = Number(text.replace(',', '.').replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) {
        await ctx.reply('❌ Monto inválido. Escribe solamente un monto positivo, por ejemplo: 1000');
        return;
      }
      if (amount > 100000000) {
        await ctx.reply('❌ El monto indicado es demasiado alto.');
        return;
      }
      state.amount = Math.round(amount * 100) / 100;
      state.step = 'proof';
      depositStates.set(userId, state);
      await ctx.reply(`💰 *Monto:* $${fmtMoney(state.amount)}\n💳 *Método:* ${state.paymentMethod === 'transfermovil' ? 'Transfermóvil' : 'EnZona'}\n\n📎 Ahora envía la *captura o comprobante* de la transferencia como foto o documento.\n\nTambién puedes escribir el número de referencia si no tienes archivo.`, { parse_mode: 'Markdown' });
      return;
    }

    if (state.step === 'proof') {
      await crearSolicitudDeposito(ctx, state, null, text);
      return;
    }
  });

  bot.on('photo', async (ctx, next) => {
    const state = depositStates.get(ctx.from.id);
    if (!state || state.step !== 'proof') return next();
    const photos = ctx.message.photo || [];
    const fileId = photos.length ? photos[photos.length - 1].file_id : null;
    await crearSolicitudDeposito(ctx, state, fileId, null);
  });

  bot.on('document', async (ctx, next) => {
    const state = depositStates.get(ctx.from.id);
    if (!state || state.step !== 'proof') return next();
    const fileId = ctx.message.document?.file_id || null;
    await crearSolicitudDeposito(ctx, state, fileId, null);
  });

  async function crearSolicitudDeposito(ctx, state, proofFileId, referenceText) {
    try {
      const { data: request, error } = await supabase.from('deposit_requests').insert([{
        user_telegram_id: ctx.from.id,
        amount: state.amount,
        payment_method: state.paymentMethod,
        proof_file_id: proofFileId,
        admin_notes: referenceText ? `Referencia enviada por usuario: ${referenceText}` : null,
        status: 'pending'
      }]).select().single();
      if (error) throw error;

      depositStates.delete(ctx.from.id);
      await ctx.reply(`✅ *Solicitud de recarga enviada*\n\n💰 Monto: $${fmtMoney(state.amount)}\n💳 Método: ${state.paymentMethod === 'transfermovil' ? 'Transfermóvil' : 'EnZona'}\n🧾 Solicitud #${request.id}\n\n⏳ Queda pendiente de aprobación. Te avisaré cuando el administrador acredite el saldo.`, { parse_mode: 'Markdown' });

      const user = ctx.from;
      for (const adminId of adminIds) {
        try {
          const texto = `💰 *Nueva solicitud de recarga*\n\n🧾 Solicitud: #${request.id}\n👤 Usuario: ${user.first_name || ''} ${user.last_name || ''}\n🆔 Telegram: ${user.id}\n💵 Monto: $${fmtMoney(state.amount)}\n💳 Método: ${state.paymentMethod === 'transfermovil' ? 'Transfermóvil' : 'EnZona'}${referenceText ? `\n🔖 Referencia: ${referenceText}` : ''}`;
          await bot.telegram.sendMessage(adminId, texto, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Aprobar', callback_data: `deposit_approve_${request.id}` }, { text: '❌ Rechazar', callback_data: `deposit_reject_${request.id}` }]] } });
          if (proofFileId) await bot.telegram.sendPhoto(adminId, proofFileId, { caption: `Comprobante de solicitud #${request.id}` });
        } catch (notifyErr) {
          console.error('No se pudo notificar al administrador:', notifyErr);
        }
      }
    } catch (err) {
      console.error('crearSolicitudDeposito:', err);
      await ctx.reply('❌ No se pudo registrar la solicitud de recarga. Intenta nuevamente.');
    }
  }

  bot.action(/^deposit_approve_(\d+)$/, async (ctx) => {
    await answer(ctx);
    if (!adminIds.includes(ctx.from.id)) return ctx.answerCbQuery('No autorizado').catch(() => {});
    const requestId = Number(ctx.match[1]);
    try {
      const { data: req, error: reqError } = await supabase.from('deposit_requests').select('*').eq('id', requestId).single();
      if (reqError || !req) throw new Error('Solicitud no encontrada');
      if (req.status !== 'pending') {
        return ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      }
      const { data: user, error: userError } = await supabase.from('users').select('saldo').eq('telegram_id', req.user_telegram_id).single();
      if (userError || !user) throw new Error('Usuario no encontrado');
      const nuevoSaldo = Number(user.saldo || 0) + Number(req.amount || 0);
      const { error: updateReqError } = await supabase.from('deposit_requests').update({ status: 'approved', admin_notes: `Aprobado por ${ctx.from.id}`, updated_at: new Date() }).eq('id', requestId).eq('status', 'pending');
      if (updateReqError) throw updateReqError;
      const { error: balanceError } = await supabase.from('users').update({ saldo: nuevoSaldo, updated_at: new Date() }).eq('telegram_id', req.user_telegram_id);
      if (balanceError) throw balanceError;
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.reply(`✅ Solicitud #${requestId} aprobada. Saldo acreditado: $${fmtMoney(req.amount)}.`);
      try { await bot.telegram.sendMessage(req.user_telegram_id, `🎉 *Recarga aprobada*\n\n💰 Se acreditaron *$${fmtMoney(req.amount)}* a tu saldo.\n💵 Nuevo saldo: *$${fmtMoney(nuevoSaldo)}*`, { parse_mode: 'Markdown' }); } catch (_) {}
    } catch (err) {
      console.error('deposit approve:', err);
      await ctx.reply('❌ No se pudo aprobar la solicitud.');
    }
  });

  bot.action(/^deposit_reject_(\d+)$/, async (ctx) => {
    await answer(ctx);
    if (!adminIds.includes(ctx.from.id)) return ctx.answerCbQuery('No autorizado').catch(() => {});
    const requestId = Number(ctx.match[1]);
    try {
      const { data: req, error } = await supabase.from('deposit_requests').select('user_telegram_id,amount,status').eq('id', requestId).single();
      if (error || !req) throw new Error('Solicitud no encontrada');
      if (req.status !== 'pending') return ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      const { error: updateError } = await supabase.from('deposit_requests').update({ status: 'rejected', admin_notes: `Rechazado por ${ctx.from.id}`, updated_at: new Date() }).eq('id', requestId).eq('status', 'pending');
      if (updateError) throw updateError;
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.reply(`❌ Solicitud #${requestId} rechazada.`);
      try { await bot.telegram.sendMessage(req.user_telegram_id, `❌ *Recarga rechazada*\n\nLa solicitud #${requestId} por $${fmtMoney(req.amount)} fue rechazada. Contacta al administrador si necesitas revisar el pago.`, { parse_mode: 'Markdown' }); } catch (_) {}
    } catch (err) {
      console.error('deposit reject:', err);
      await ctx.reply('❌ No se pudo rechazar la solicitud.');
    }
  });

  bot.command('admin', async (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('❌ No autorizado.');
    await ctx.reply('👑 *Panel de Administración*\n\nGestiona las solicitudes de recarga pendientes.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 Solicitudes pendientes', callback_data: 'admin_pendientes' }]] } });
  });

  bot.action('admin_pendientes', async (ctx) => {
    await answer(ctx);
    if (!adminIds.includes(ctx.from.id)) return;
    try {
      const { data: requests, error } = await supabase.from('deposit_requests').select('id,user_telegram_id,amount,payment_method,status,created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(20);
      if (error) throw error;
      if (!requests?.length) return ctx.editMessageText('📋 *Solicitudes pendientes*\n\nNo hay recargas pendientes.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Menú', callback_data: 'menu_principal' }]] } });
      const keyboard = requests.map(r => [{ text: `#${r.id} — $${fmtMoney(r.amount)} — ${r.payment_method}`, callback_data: `deposit_view_${r.id}` }]);
      await ctx.editMessageText('📋 *Solicitudes pendientes*\n\nSelecciona una solicitud:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      console.error('admin_pendientes:', err);
      await ctx.editMessageText('❌ No se pudieron cargar las solicitudes.');
    }
  });

  bot.action(/^deposit_view_(\d+)$/, async (ctx) => {
    await answer(ctx);
    if (!adminIds.includes(ctx.from.id)) return;
    const id = Number(ctx.match[1]);
    try {
      const { data: r, error } = await supabase.from('deposit_requests').select('*').eq('id', id).single();
      if (error || !r) throw new Error('Solicitud no encontrada');
      let texto = `💰 *Solicitud #${r.id}*\n\n🆔 Usuario: ${r.user_telegram_id}\n💵 Monto: $${fmtMoney(r.amount)}\n💳 Método: ${r.payment_method}\n📌 Estado: ${r.status}`;
      if (r.admin_notes) texto += `\n📝 ${r.admin_notes}`;
      await ctx.editMessageText(texto, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Aprobar', callback_data: `deposit_approve_${r.id}` }, { text: '❌ Rechazar', callback_data: `deposit_reject_${r.id}` }],[{ text: '⬅️ Pendientes', callback_data: 'admin_pendientes' }]] } });
      if (r.proof_file_id) await bot.telegram.sendPhoto(ctx.from.id, r.proof_file_id, { caption: `Comprobante de solicitud #${r.id}` });
    } catch (err) {
      console.error('deposit_view:', err);
      await ctx.reply('❌ No se pudo cargar la solicitud.');
    }
  });

  bot.action('menu_ayuda', async (ctx) => {
    await answer(ctx);
    await ctx.editMessageText('⚙️ *Ayuda*\n\n1. Selecciona una lotería y un sorteo.\n2. Selecciona la moneda.\n3. Usa *💰 Depositar* para recargar saldo.\n4. Cuando el saldo esté acreditado podrás registrar jugadas.\n5. Usa /start para volver al menú principal.', { parse_mode: 'Markdown', ...mainKeyboard });
  });

  bot.action('menu_principal', async (ctx) => {
    await answer(ctx);
    try {
      const { data: user } = await supabase.from('users').select('saldo').eq('telegram_id', ctx.from.id).maybeSingle();
      const { data: pref } = await supabase.from('user_preferences').select('loteria_id,sorteo_id,moneda').eq('telegram_id', ctx.from.id).maybeSingle();
      let texto = '🏠 *Menú Principal*\n\n💰 *Saldo:* $' + fmtMoney(user?.saldo) + '\n';
      if (pref?.loteria_id && pref?.sorteo_id) {
        const { data: sorteo } = await supabase.from('sorteos').select('nombre').eq('id', pref.sorteo_id).maybeSingle();
        const { data: loteria } = await supabase.from('loterias').select('nombre').eq('id', pref.loteria_id).maybeSingle();
        if (sorteo) texto += `🎰 *Sorteo activo:* ${loteria?.nombre || '?'} - ${sorteo.nombre}\n💵 *Moneda:* ${(pref.moneda || 'cup').toUpperCase()}\n`;
        else texto += '⚠️ No has seleccionado un sorteo activo.\n';
      } else texto += '⚠️ No has seleccionado un sorteo activo.\n';
      await ctx.editMessageText(texto, { parse_mode: 'Markdown', ...mainKeyboard });
    } catch (err) {
      console.error('menu_principal:', err);
      await ctx.editMessageText('❌ No se pudo cargar el menú principal.', mainKeyboard);
    }
  });

  console.log('✅ Callbacks del menú y flujo de depósitos registrados');
}

try {
  require('./index.js');

  const app = global.__LOTO_APP__;
  const bot = global.__LOTO_BOT__;
  if (!app) throw new Error('No se pudo capturar la instancia Express creada por index.js');
  if (!bot) throw new Error('No se pudo capturar la instancia Telegraf creada por index.js');

  registerMenuCallbacks(bot).catch(err => {
    console.error('❌ Error registrando callbacks del menú:', err);
    process.exitCode = 1;
  });

  const PORT = Number(process.env.PORT) || 10000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
    console.log('✅ Webhook disponible en POST /webhook');
    console.log(`🏠 Health check: /ping`);
  });
} catch (err) {
  console.error('❌ ERROR DURANTE EL ARRANQUE:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
