const express = require('express');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// 1. SUPABASE
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// 2. Cargar el motor DSL
// ============================================================
require('./lotopro-core.bundle.js');
const { Engine, Preprocesador } = global;

// ============================================================
// 3. limpiarMonto manual
// ============================================================
function limpiarMonto(s) {
  if (s == null) return null;
  let txt = String(s).replace(/\s+/g, '').replace(/\$/g, '');
  if (!txt) return null;
  txt = txt.replace(/,/g, '.');
  const dotCount = (txt.match(/\./g) || []).length;
  if (dotCount > 1) {
    const lastDot = txt.lastIndexOf('.');
    txt = txt.slice(0, lastDot).replace(/\./g, '') + '.' + txt.slice(lastDot + 1);
  }
  const n = parseFloat(txt);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// 4. Preprocesamiento adicional (líneas mixtas)
// ============================================================
function expandirLineaMixta(linea) {
  const regex = /^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)\s+candado\s+con\s+(\d+(?:\.\d+)?)$/i;
  const match = linea.match(regex);
  if (!match) return linea;
  const nums = match[1].trim();
  const monto1 = match[2];
  const monto2 = match[3];
  const monto3 = match[4];
  return `${nums} con ${monto1}\n${nums} corrido con ${monto2}\n${nums} candado con ${monto3}`;
}

function preprocesarLineasMixtas(texto) {
  return texto.split('\n').map(linea => expandirLineaMixta(linea.trim())).join('\n');
}

// ============================================================
// 5. Helpers de base de datos (usuarios, apuestas, depósitos)
// ============================================================
async function getOrCreateUser(telegramId, username, firstName) {
  let { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  if (error && error.code !== 'PGRST116') return null;
  if (!user) {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ telegram_id: telegramId, username, first_name: firstName, saldo: 0 }])
      .select()
      .single();
    if (insertError) return null;
    user = newUser;
  }
  return user;
}

async function updateUserSaldo(telegramId, nuevoSaldo) {
  await supabase
    .from('users')
    .update({ saldo: nuevoSaldo, updated_at: new Date() })
    .eq('telegram_id', telegramId);
}

async function saveBet(userTelegramId, inputRaw, totalApuesta, detalle, saldoAntes, saldoDespues) {
  await supabase.from('bets').insert([{
    user_telegram_id: userTelegramId,
    input_raw: inputRaw,
    total_apuesta: totalApuesta,
    detalle: detalle,
    saldo_antes: saldoAntes,
    saldo_despues: saldoDespues
  }]);
}

async function createDepositRequest(userTelegramId, amount, paymentMethod, proofFileId) {
  const { data, error } = await supabase.from('deposit_requests').insert([{
    user_telegram_id: userTelegramId,
    amount,
    payment_method: paymentMethod,
    proof_file_id: proofFileId,
    status: 'pending'
  }]).select().single();
  if (error) throw error;
  return data;
}

async function getPendingDeposits() {
  const { data, error } = await supabase
    .from('deposit_requests')
    .select('*, users!inner(telegram_id, username, first_name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function approveDeposit(requestId, adminId) {
  // Obtener la solicitud
  const { data: req, error: fetchError } = await supabase
    .from('deposit_requests')
    .select('*')
    .eq('id', requestId)
    .single();
  if (fetchError || !req) throw new Error('Solicitud no encontrada');

  // Actualizar estado
  const { error: updateError } = await supabase
    .from('deposit_requests')
    .update({ status: 'approved', admin_notes: `Aprobado por ${adminId}`, updated_at: new Date() })
    .eq('id', requestId);
  if (updateError) throw updateError;

  // Sumar saldo al usuario
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('saldo')
    .eq('telegram_id', req.user_telegram_id)
    .single();
  if (userError) throw userError;

  const nuevoSaldo = (user.saldo || 0) + req.amount;
  await updateUserSaldo(req.user_telegram_id, nuevoSaldo);

  // Notificar al usuario (opcional, se hará desde el comando)
  return { userId: req.user_telegram_id, amount: req.amount, nuevoSaldo };
}

async function rejectDeposit(requestId, adminId, reason = '') {
  const { error } = await supabase
    .from('deposit_requests')
    .update({ status: 'rejected', admin_notes: `Rechazado por ${adminId}: ${reason}`, updated_at: new Date() })
    .eq('id', requestId);
  if (error) throw error;
}

// ============================================================
// 6. Configurar bot y Express
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Token no definido');
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.path}`);
  next();
});
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot con depósitos'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

// Estados para el flujo de depósito (por usuario)
const depositStates = new Map(); // userId -> { step, amount, method }

// ============================================================
// 7. Funciones auxiliares
// ============================================================
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// ============================================================
// 8. Comandos públicos
// ============================================================
bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(
    `✅ Bienvenido ${ctx.from.first_name || 'usuario'}.\n` +
    `💰 Tu saldo actual es: $${user.saldo.toFixed(2)}\n\n` +
    `Comandos:\n` +
    `/saldo - ver tu saldo\n` +
    `/depositar - solicitar recarga de saldo (con comprobante)\n` +
    `/mis_depositos - ver estado de tus solicitudes\n` +
    `/historial - ver tus últimas 5 jugadas\n\n` +
    `Para apostar, envía tu jugada en formato DSL.\n` +
    `Ejemplo:\nJuana\nd2 con 50 y 20 candado con 2300\nparejas d2 t3 4 5 parle con 5`
  );
});

bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Tu saldo actual es: $${user.saldo.toFixed(2)}`);
});

bot.command('depositar', async (ctx) => {
  const userId = ctx.from.id;
  depositStates.set(userId, { step: 'method' });
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💳 Tarjeta de Crédito/Débito', callback_data: 'dep_method_tarjeta' }],
        [{ text: '🏦 Transferencia Bancaria', callback_data: 'dep_method_transferencia' }],
        [{ text: '📱 Monedero (MercadoPago, etc.)', callback_data: 'dep_method_monedero' }]
      ]
    }
  };
  await ctx.reply('Selecciona el método de pago:', keyboard);
});

bot.command('mis_depositos', async (ctx) => {
  const userId = ctx.from.id;
  const { data: requests, error } = await supabase
    .from('deposit_requests')
    .select('*')
    .eq('user_telegram_id', userId)
    .order('created_at', { ascending: false });
  if (error || !requests.length) {
    return ctx.reply('No tienes solicitudes de depósito registradas.');
  }
  let msg = '📋 *Tus solicitudes de depósito:*\n\n';
  for (const r of requests) {
    const statusEmoji = r.status === 'pending' ? '⏳' : (r.status === 'approved' ? '✅' : '❌');
    msg += `${statusEmoji} *${r.status.toUpperCase()}* - $${r.amount.toFixed(2)} (${r.payment_method})\n`;
    msg += `   ID: ${r.id} - ${new Date(r.created_at).toLocaleString()}\n`;
    if (r.admin_notes) msg += `   Nota: ${r.admin_notes}\n`;
    msg += '\n';
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('historial', async (ctx) => {
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('user_telegram_id', ctx.from.id)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error || !bets || !bets.length) return ctx.reply('📭 No tienes jugadas registradas aún.');
  let msg = '📜 *Tus últimas 5 jugadas:*\n\n';
  bets.forEach(b => {
    msg += `💰 *Monto:* $${b.total_apuesta.toFixed(2)}\n📅 *Fecha:* ${new Date(b.created_at).toLocaleString()}\n📝 *Detalle:*\n${b.detalle?.substring(0, 200) || ''}${b.detalle?.length > 200 ? '…' : ''}\n\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.help((ctx) => ctx.reply(
  'Comandos:\n' +
  '/start - iniciar\n' +
  '/saldo - ver saldo\n' +
  '/depositar - solicitar recarga (con comprobante)\n' +
  '/mis_depositos - ver estado de tus solicitudes\n' +
  '/historial - ver tus últimas jugadas\n\n' +
  'Para apostar, envía tu jugada en formato DSL.\n' +
  'Ejemplo:\n`Juana\nd2 con 50 y 20 candado con 2300\nparejas d2 t3 4 5 parle con 5`',
  { parse_mode: 'Markdown' }
));

// ============================================================
// 9. Comandos exclusivos para administrador
// ============================================================
bot.command('aprobar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Comando solo para administradores.');
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Uso: /aprobar <id_de_solicitud> [monto_si_no_coincide]');
  }
  const requestId = parseInt(args[1]);
  if (isNaN(requestId)) return ctx.reply('ID inválido.');

  try {
    const { userId, amount, nuevoSaldo } = await approveDeposit(requestId, ctx.from.id);
    await ctx.reply(`✅ Depósito aprobado. Se acreditaron $${amount.toFixed(2)} al usuario ${userId}. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
    // Notificar al usuario (en privado)
    try {
      await bot.telegram.sendMessage(userId, `✅ Tu depósito de $${amount.toFixed(2)} ha sido aprobado. Tu nuevo saldo es $${nuevoSaldo.toFixed(2)}.`);
    } catch (e) { console.log('No se pudo notificar al usuario:', e.message); }
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('rechazar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Comando solo para administradores.');
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Uso: /rechazar <id_de_solicitud> [razón]');
  }
  const requestId = parseInt(args[1]);
  if (isNaN(requestId)) return ctx.reply('ID inválido.');
  const reason = args.slice(2).join(' ') || 'Sin especificar';

  try {
    await rejectDeposit(requestId, ctx.from.id, reason);
    // Obtener el userId de la solicitud para notificar
    const { data: req } = await supabase.from('deposit_requests').select('user_telegram_id').eq('id', requestId).single();
    if (req) {
      await bot.telegram.sendMessage(req.user_telegram_id, `❌ Tu depósito ha sido rechazado. Motivo: ${reason}`);
    }
    await ctx.reply(`✅ Depósito ${requestId} rechazado.`);
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('pendientes', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Comando solo para administradores.');
  try {
    const pendings = await getPendingDeposits();
    if (!pendings.length) {
      return ctx.reply('No hay solicitudes de depósito pendientes.');
    }
    let msg = '📋 *Solicitudes pendientes:*\n\n';
    for (const p of pendings) {
      const user = p.users;
      msg += `ID: ${p.id}\n`;
      msg += `Usuario: ${user.first_name || user.username || user.telegram_id} (${user.telegram_id})\n`;
      msg += `Monto: $${p.amount.toFixed(2)}\n`;
      msg += `Método: ${p.payment_method}\n`;
      msg += `Comprobante: <a href="https://t.me/file/${p.proof_file_id}">Ver archivo</a>\n`;
      msg += `Fecha: ${new Date(p.created_at).toLocaleString()}\n`;
      msg += `\nAprobar: /aprobar ${p.id}\nRechazar: /rechazar ${p.id} [razón]\n\n`;
    }
    ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

// ============================================================
// 10. Callbacks para selección de método de pago
// ============================================================
bot.action(/dep_method_(.+)/, async (ctx) => {
  const method = ctx.match[1];
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  if (!state || state.step !== 'method') {
    await ctx.answerCbQuery('Por favor, inicia el proceso con /depositar');
    return ctx.deleteMessage();
  }
  state.method = method;
  state.step = 'amount';
  depositStates.set(userId, state);
  await ctx.editMessageText(`Método seleccionado: ${method}\nAhora, escribe el monto a depositar (solo número):`);
});

// ============================================================
// 11. Manejo de mensajes de texto para flujo de depósito
// ============================================================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  const text = ctx.message.text.trim();

  // Si estamos en flujo de depósito y esperando monto
  if (state && state.step === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Monto inválido. Debes escribir un número positivo.');
    }
    state.amount = amount;
    state.step = 'proof';
    depositStates.set(userId, state);
    await ctx.reply(`✅ Monto: $${amount.toFixed(2)}\n\nAhora, envía una imagen o documento con el comprobante de pago.`);
    return;
  }

  // Si no hay flujo activo, procesar como jugada normal
  await processBet(ctx, text);
});

// ============================================================
// 12. Manejo de fotos/documentos (comprobantes)
// ============================================================
bot.on(['photo', 'document'], async (ctx) => {
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  if (!state || state.step !== 'proof') {
    return ctx.reply('No estás en proceso de depósito. Usa /depositar para iniciar.');
  }

  let fileId;
  if (ctx.message.photo) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  } else if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
  } else {
    return ctx.reply('Por favor, envía una imagen o documento como comprobante.');
  }

  try {
    const deposit = await createDepositRequest(userId, state.amount, state.method, fileId);
    depositStates.delete(userId);
    await ctx.reply(`✅ Solicitud de depósito creada.\nID: ${deposit.id}\nMonto: $${deposit.amount}\nMétodo: ${deposit.payment_method}\n\nEl administrador revisará tu comprobante y te notificará cuando sea aprobado.`);
    // Notificar a los admins (opcional)
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(adminId, `📥 Nueva solicitud de depósito #${deposit.id}\nUsuario: ${ctx.from.id}\nMonto: $${deposit.amount}\nMétodo: ${deposit.payment_method}\nUsa /pendientes para ver todas.`);
      } catch(e) {}
    }
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Error al guardar la solicitud. Intenta más tarde.');
  }
});

// ============================================================
// 13. Función para procesar apuestas (jugadas)
// ============================================================
async function processBet(ctx, rawInput) {
  if (!rawInput.trim()) return;
  console.log(`📥 Entrada original:\n${rawInput}`);

  let processed = rawInput.toLowerCase();
  processed = preprocesarLineasMixtas(processed);
  console.log(`📥 Después de expansión mixta:\n${processed}`);

  let resultado;
  try {
    resultado = Engine.calcular(
      { rawInput: processed, loteriaId: 1, sorteoId: 1 },
      { limpiarMonto, Expansion: global.Expansion, preprocesarJugada: Preprocesador.preprocesarJugada }
    );
  } catch (err) {
    console.error('🔥 Excepción:', err);
    return ctx.reply(`❌ Error interno:\n${err.message}`);
  }

  if (!resultado.ok) {
    const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
    return ctx.reply(`❌ Error en la jugada:\n${errorMsg}`);
  }

  const totalApuesta = resultado.totalGeneral;
  if (totalApuesta === 0) {
    return ctx.reply('❌ La jugada no tiene monto válido. Revisa la sintaxis.');
  }

  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(
      `❌ Saldo insuficiente.\n` +
      `💰 Necesitas: $${totalApuesta.toFixed(2)}\n` +
      `💰 Tu saldo actual: $${user.saldo.toFixed(2)}\n` +
      `Usa /depositar para solicitar recarga.`
    );
  }

  const saldoAntes = user.saldo;
  const saldoDespues = saldoAntes - totalApuesta;
  await updateUserSaldo(ctx.from.id, saldoDespues);
  await saveBet(ctx.from.id, rawInput, totalApuesta, resultado.detalleTexto || '', saldoAntes, saldoDespues);

  let respuesta = `💰 *Total apostado:* $${totalApuesta.toFixed(2)}\n`;
  respuesta += `💰 *Saldo restante:* $${saldoDespues.toFixed(2)}\n\n`;
  if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
  if (resultado.flaggedWarnings?.length) {
    respuesta += '\n⚠️ Revisiones pendientes:\n';
    respuesta += resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
  }
  respuesta += `\n✅ *Jugada registrada correctamente.*`;
  await ctx.reply(respuesta, { parse_mode: 'Markdown' });
}

// ============================================================
// 14. Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`✅ Webhook en ${webhookPath}`);
  console.log(`👑 Admins: ${ADMIN_IDS.join(', ') || 'Ninguno (usa ADMIN_IDS variable)'}`);
});
