const express = require('express');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ================================ SUPABASE =================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ================================ MOTOR DSL ================================
require('./lotopro-core.bundle.js');
const { Engine, Preprocesador } = global;

// ================================ UTILIDADES ================================
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

// ================================ HELPERS BD ================================
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

async function saveBet(userTelegramId, loteriaId, sorteoId, fecha, inputRaw, totalApuesta, detalle, saldoAntes, saldoDespues, moneda) {
  await supabase.from('bets').insert([{
    user_telegram_id: userTelegramId,
    loteria_id: loteriaId,
    sorteo_id: sorteoId,
    fecha_apuesta: fecha,
    input_raw: inputRaw,
    total_apuesta: totalApuesta,
    detalle: detalle,
    saldo_antes: saldoAntes,
    saldo_despues: saldoDespues,
    moneda: moneda || 'cup'
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

async function approveDeposit(requestId, adminId) {
  const { data: req, error: fetchError } = await supabase
    .from('deposit_requests')
    .select('*')
    .eq('id', requestId)
    .single();
  if (fetchError || !req) throw new Error('Solicitud no encontrada');
  await supabase
    .from('deposit_requests')
    .update({ status: 'approved', admin_notes: `Aprobado por ${adminId}`, updated_at: new Date() })
    .eq('id', requestId);
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('saldo')
    .eq('telegram_id', req.user_telegram_id)
    .single();
  if (userError) throw userError;
  const nuevoSaldo = (user.saldo || 0) + req.amount;
  await updateUserSaldo(req.user_telegram_id, nuevoSaldo);
  return { userId: req.user_telegram_id, amount: req.amount, nuevoSaldo };
}

async function rejectDeposit(requestId, adminId, reason = '') {
  await supabase
    .from('deposit_requests')
    .update({ status: 'rejected', admin_notes: `Rechazado por ${adminId}: ${reason}`, updated_at: new Date() })
    .eq('id', requestId);
}

// ================================ LÍMITES POR TIPO (SIN NÚMEROS INDIVIDUALES) ================================
async function validarLimitesPorTipo(jugadasDetalle, loteriaId, sorteoId) {
  // Obtener límites configurados (globales o por lotería/sorteo)
  let query = supabase.from('limits').select('*');
  if (loteriaId && sorteoId) {
    query = query.or(`loteria_id.eq.${loteriaId},loteria_id.is.null`)
                 .or(`sorteo_id.eq.${sorteoId},sorteo_id.is.null`);
  } else {
    query = query.is('loteria_id', null).is('sorteo_id', null);
  }
  const { data: limites } = await query;
  if (!limites) return null;

  for (const detalle of jugadasDetalle) {
    const tipo = detalle.tipo;
    // Para candado, también usamos el tipo 'parle' (porque comparte límite)
    const tipoBase = (tipo === 'candado' || tipo === 'candado_global') ? 'parle' : tipo;
    const montoUnitario = detalle.monto_unitario;
    if (montoUnitario === undefined || montoUnitario === null) continue;

    const limite = limites.find(l => l.tipo === tipoBase);
    if (limite && montoUnitario > limite.monto_maximo) {
      return { tipo: tipoBase, montoUnitario, maximo: limite.monto_maximo };
    }
  }
  return null;
}

// ================================ CATÁLOGOS Y PREFERENCIAS ================================
async function getLoterias() {
  const { data, error } = await supabase.from('loterias').select('*').eq('activo', true).order('id');
  if (error) throw error;
  return data;
}

async function getSorteos(loteriaId) {
  const { data, error } = await supabase
    .from('sorteos')
    .select('*')
    .eq('loteria_id', loteriaId)
    .eq('activo', true)
    .order('hora_apertura');
  if (error) throw error;
  return data;
}

async function getUserPreference(telegramId) {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  if (error && error.code !== 'PGRST116') return null;
  return data;
}

async function saveUserPreference(telegramId, loteriaId, sorteoId, moneda) {
  await supabase
    .from('user_preferences')
    .upsert({
      telegram_id: telegramId,
      loteria_id: loteriaId,
      sorteo_id: sorteoId,
      moneda: moneda,
      updated_at: new Date()
    }, { onConflict: 'telegram_id' });
}

async function validarHorarioSorteo(sorteoId) {
  const { data: sorteo, error } = await supabase
    .from('sorteos')
    .select('hora_apertura, hora_cierre')
    .eq('id', sorteoId)
    .single();
  if (error || !sorteo) return null;
  const ahora = new Date();
  const horaActual = ahora.getHours().toString().padStart(2,'0') + ':' + ahora.getMinutes().toString().padStart(2,'0');
  if (horaActual < sorteo.hora_apertura) return { open: false, message: `⏰ El sorteo abre a las ${sorteo.hora_apertura}.` };
  if (horaActual >= sorteo.hora_cierre) return { open: false, message: `⏰ El sorteo cerró a las ${sorteo.hora_cierre}.` };
  return { open: true };
}

// ================================ CONFIGURACIÓN DEL BOT ================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Token no definido');
  process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => { console.log(`📨 [${req.method}] ${req.path}`); next(); });
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot con límites por tipo'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => { bot.webhookCallback(webhookPath)(req, res); });

// ================================ ESTADOS DEPÓSITOS ================================
const depositStates = new Map();

// ================================ COMANDOS PÚBLICOS ================================
bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const pref = await getUserPreference(ctx.from.id);
  let msg = `✅ Bienvenido ${ctx.from.first_name || 'usuario'}.\n💰 Saldo: $${user.saldo.toFixed(2)}\n\n`;
  if (pref) {
    const { data: lot } = await supabase.from('loterias').select('nombre').eq('id', pref.loteria_id).single();
    const { data: sor } = await supabase.from('sorteos').select('nombre').eq('id', pref.sorteo_id).single();
    msg += `🎰 Configuración actual: ${lot?.nombre || '?'} / ${sor?.nombre || '?'}\n💵 Moneda: ${pref.moneda?.toUpperCase() || 'CUP'}\n\n`;
  } else {
    msg += `⚠️ Selecciona lotería, sorteo y moneda:\n`;
  }
  msg += `/loterias - elegir lotería\n/sorteos - elegir sorteo\n/moneda - elegir moneda\n/saldo\n/depositar\n/mis_depositos\n/historial\n\n`;
  msg += `Ejemplo de jugada:\npepe\nt5 con 10\n\n(El límite por tipo se aplica al monto por número o combinación)`;
  ctx.reply(msg);
});

bot.command('loterias', async (ctx) => {
  const loterias = await getLoterias();
  if (!loterias.length) return ctx.reply('No hay loterías activas.');
  const keyboard = { reply_markup: { inline_keyboard: loterias.map(l => [{ text: l.nombre, callback_data: `sel_lot_${l.id}` }]) } };
  ctx.reply('Selecciona una lotería:', keyboard);
});

bot.action(/sel_lot_(\d+)/, async (ctx) => {
  const lotId = parseInt(ctx.match[1]);
  const pref = await getUserPreference(ctx.from.id) || {};
  await saveUserPreference(ctx.from.id, lotId, pref.sorteo_id || null, pref.moneda || 'cup');
  await ctx.answerCbQuery(`Lotería seleccionada. Ahora usa /sorteos.`);
  ctx.editMessageText(`✅ Lotería seleccionada. Ahora usa /sorteos para elegir el sorteo.`);
});

bot.command('sorteos', async (ctx) => {
  const pref = await getUserPreference(ctx.from.id);
  if (!pref || !pref.loteria_id) return ctx.reply('Primero selecciona una lotería con /loterias');
  const sorteos = await getSorteos(pref.loteria_id);
  if (!sorteos.length) return ctx.reply('No hay sorteos activos.');
  const keyboard = { reply_markup: { inline_keyboard: sorteos.map(s => [{ text: `${s.nombre} (${s.hora_apertura} - ${s.hora_cierre})`, callback_data: `sel_sor_${s.id}` }]) } };
  ctx.reply('Selecciona un sorteo:', keyboard);
});

bot.action(/sel_sor_(\d+)/, async (ctx) => {
  const sorId = parseInt(ctx.match[1]);
  const pref = await getUserPreference(ctx.from.id);
  if (!pref) return ctx.answerCbQuery('Primero selecciona lotería', true);
  await saveUserPreference(ctx.from.id, pref.loteria_id, sorId, pref.moneda || 'cup');
  await ctx.answerCbQuery(`Sorteo seleccionado.`);
  ctx.editMessageText(`✅ Sorteo seleccionado. Ya puedes enviar tu jugada.`);
});

bot.command('moneda', async (ctx) => {
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🇨🇺 CUP', callback_data: 'moneda_cup' }],[{ text: '💳 MLC', callback_data: 'moneda_mlc' }],[{ text: '🇺🇸 USD', callback_data: 'moneda_usd' }]] } };
  ctx.reply('Selecciona la moneda:', keyboard);
});

bot.action(/moneda_(cup|mlc|usd)/, async (ctx) => {
  const moneda = ctx.match[1];
  const pref = await getUserPreference(ctx.from.id);
  await saveUserPreference(ctx.from.id, pref?.loteria_id || null, pref?.sorteo_id || null, moneda);
  await ctx.answerCbQuery(`Moneda ${moneda.toUpperCase()} seleccionada.`);
  ctx.editMessageText(`✅ Moneda ${moneda.toUpperCase()} seleccionada.`);
});

bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Saldo actual: $${user.saldo.toFixed(2)}`);
});

bot.command('depositar', async (ctx) => {
  depositStates.set(ctx.from.id, { step: 'method' });
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '💳 Tarjeta', callback_data: 'dep_method_tarjeta' }],[{ text: '🏦 Transferencia', callback_data: 'dep_method_transferencia' }],[{ text: '📱 Monedero', callback_data: 'dep_method_monedero' }]] } };
  await ctx.reply('Selecciona método de pago:', keyboard);
});

bot.command('mis_depositos', async (ctx) => {
  const { data: requests } = await supabase.from('deposit_requests').select('*').eq('user_telegram_id', ctx.from.id).order('created_at', { ascending: false });
  if (!requests?.length) return ctx.reply('No hay solicitudes.');
  let msg = '📋 *Tus solicitudes de depósito:*\n\n';
  for (const r of requests) {
    const statusEmoji = r.status === 'pending' ? '⏳' : (r.status === 'approved' ? '✅' : '❌');
    msg += `${statusEmoji} *${r.status.toUpperCase()}* - $${r.amount.toFixed(2)} (${r.payment_method})\nID: ${r.id} - ${new Date(r.created_at).toLocaleString()}\n${r.admin_notes ? `Nota: ${r.admin_notes}\n` : ''}\n`;
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('historial', async (ctx) => {
  const { data: bets } = await supabase.from('bets').select('*').eq('user_telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(5);
  if (!bets?.length) return ctx.reply('No hay jugadas.');
  let msg = '📜 *Últimas 5 jugadas:*\n\n';
  bets.forEach(b => {
    msg += `💰 $${b.total_apuesta.toFixed(2)} - ${new Date(b.created_at).toLocaleString()}\n📝 ${b.detalle?.substring(0, 150)}…\n\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ================================ COMANDOS ADMIN ================================
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

bot.command('aprobar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Uso: /aprobar <id_solicitud>');
  const id = parseInt(args[1]);
  if (isNaN(id)) return ctx.reply('ID inválido.');
  try {
    const { userId, amount, nuevoSaldo } = await approveDeposit(id, ctx.from.id);
    await ctx.reply(`✅ Depósito aprobado. $${amount.toFixed(2)} a usuario ${userId}. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
    try { await bot.telegram.sendMessage(userId, `✅ Tu depósito de $${amount.toFixed(2)} fue aprobado. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`); } catch(e) {}
  } catch (err) { ctx.reply(`❌ Error: ${err.message}`); }
});

bot.command('rechazar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Uso: /rechazar <id_solicitud> [razón]');
  const id = parseInt(args[1]);
  if (isNaN(id)) return ctx.reply('ID inválido.');
  const reason = args.slice(2).join(' ') || 'Sin motivo';
  try {
    await rejectDeposit(id, ctx.from.id, reason);
    const { data: req } = await supabase.from('deposit_requests').select('user_telegram_id').eq('id', id).single();
    if (req) await bot.telegram.sendMessage(req.user_telegram_id, `❌ Tu depósito fue rechazado. Motivo: ${reason}`);
    ctx.reply(`✅ Depósito ${id} rechazado.`);
  } catch (err) { ctx.reply(`❌ Error: ${err.message}`); }
});

bot.command('pendientes', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const { data: pendings, error } = await supabase
    .from('deposit_requests')
    .select('*, users!inner(telegram_id, username, first_name)')
    .eq('status', 'pending')
    .order('created_at');
  if (error || !pendings.length) return ctx.reply('No hay solicitudes pendientes.');
  let msg = '📋 *Solicitudes pendientes:*\n\n';
  for (const p of pendings) {
    msg += `ID: ${p.id}\nUsuario: ${p.users.first_name || p.users.username || p.users.telegram_id} (${p.users.telegram_id})\nMonto: $${p.amount.toFixed(2)}\nMétodo: ${p.payment_method}\nComprobante: <a href="https://t.me/file/${p.proof_file_id}">Ver</a>\nFecha: ${new Date(p.created_at).toLocaleString()}\n\nAprobar: /aprobar ${p.id}\nRechazar: /rechazar ${p.id}\n\n`;
  }
  ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// Comando para establecer límite por tipo (admin)
bot.command('set_limit', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Uso: /set_limit <tipo> <monto_maximo_por_numero> (tipos: fijo, corrido, parle, centena)');
  const tipo = args[1].toLowerCase();
  const monto = parseFloat(args[2]);
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido (debe ser número positivo).');

  // Validar tipo permitido
  const tiposPermitidos = ['fijo', 'corrido', 'parle', 'centena'];
  if (!tiposPermitidos.includes(tipo)) return ctx.reply(`Tipo inválido. Permitidos: ${tiposPermitidos.join(', ')}`);

  // Buscar si ya existe límite global para este tipo
  const { data: existing, error: findError } = await supabase
    .from('limits')
    .select('id')
    .eq('tipo', tipo)
    .is('loteria_id', null)
    .is('sorteo_id', null)
    .maybeSingle();

  if (findError) return ctx.reply(`Error: ${findError.message}`);

  if (existing) {
    const { error: updateError } = await supabase
      .from('limits')
      .update({ monto_maximo: monto, updated_at: new Date() })
      .eq('id', existing.id);
    if (updateError) return ctx.reply(`Error: ${updateError.message}`);
    ctx.reply(`✅ Límite para ${tipo} actualizado a $${monto.toFixed(2)} (máximo por número/combinación)`);
  } else {
    const { error: insertError } = await supabase
      .from('limits')
      .insert([{ tipo, monto_maximo: monto, loteria_id: null, sorteo_id: null, updated_at: new Date() }]);
    if (insertError) return ctx.reply(`Error: ${insertError.message}`);
    ctx.reply(`✅ Límite para ${tipo} establecido en $${monto.toFixed(2)} (máximo por número/combinación)`);
  }
});

// ================================ MANEJO DE DEPÓSITOS ================================
bot.action(/dep_method_(.+)/, async (ctx) => {
  const method = ctx.match[1];
  const state = depositStates.get(ctx.from.id);
  if (!state || state.step !== 'method') {
    await ctx.answerCbQuery('Inicia con /depositar');
    return ctx.deleteMessage();
  }
  state.method = method;
  state.step = 'amount';
  depositStates.set(ctx.from.id, state);
  await ctx.editMessageText(`Método: ${method}\nAhora escribe el monto a depositar (número):`);
});

// ================================ MANEJO DE TEXTO Y COMPROBANTES ================================
bot.on('text', async (ctx) => {
  const state = depositStates.get(ctx.from.id);
  if (state && state.step === 'amount') {
    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Monto inválido.');
    state.amount = amount;
    state.step = 'proof';
    depositStates.set(ctx.from.id, state);
    await ctx.reply(`Monto: $${amount.toFixed(2)}\nAhora envía una imagen o documento como comprobante.`);
    return;
  }
  // Si no hay estado activo, procesar apuesta
  await processBet(ctx, ctx.message.text);
});

bot.on(['photo', 'document'], async (ctx) => {
  const state = depositStates.get(ctx.from.id);
  if (!state || state.step !== 'proof') return ctx.reply('No estás en proceso de depósito. Usa /depositar.');
  let fileId;
  if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  else if (ctx.message.document) fileId = ctx.message.document.file_id;
  else return ctx.reply('Envía una imagen o documento.');
  try {
    const deposit = await createDepositRequest(ctx.from.id, state.amount, state.method, fileId);
    depositStates.delete(ctx.from.id);
    await ctx.reply(`✅ Solicitud creada.\nID: ${deposit.id}\nMonto: $${deposit.amount}\nMétodo: ${deposit.payment_method}\nEl administrador revisará.`);
    for (const adminId of ADMIN_IDS) {
      try { await bot.telegram.sendMessage(adminId, `📥 Nueva solicitud #${deposit.id}\nUsuario: ${ctx.from.id}\nMonto: $${deposit.amount}`); } catch(e) {}
    }
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Error al guardar la solicitud.');
  }
});

// ================================ FUNCIÓN PRINCIPAL DE APUESTA ================================
async function processBet(ctx, rawInput) {
  if (!rawInput.trim() || rawInput.startsWith('/')) return;

  const pref = await getUserPreference(ctx.from.id);
  if (!pref || !pref.loteria_id || !pref.sorteo_id) {
    return ctx.reply('⚠️ Primero selecciona una lotería y un sorteo con /loterias y /sorteos.');
  }
  const moneda = pref.moneda || 'cup';
  const horario = await validarHorarioSorteo(pref.sorteo_id);
  if (!horario || !horario.open) return ctx.reply(horario?.message || 'Error de horario.');

  console.log(`📥 Apuesta de ${ctx.from.id}: ${rawInput.substring(0,200)}`);

  let processed = rawInput.toLowerCase();
  processed = preprocesarLineasMixtas(processed);

  let resultado;
  try {
    resultado = Engine.calcular(
      { rawInput: processed, loteriaId: pref.loteria_id, sorteoId: pref.sorteo_id },
      { limpiarMonto, Expansion: global.Expansion, preprocesarJugada: Preprocesador.preprocesarJugada }
    );
  } catch (err) {
    console.error(err);
    return ctx.reply(`❌ Error interno: ${err.message}`);
  }

  if (!resultado.ok) {
    const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
    return ctx.reply(`❌ Error en la jugada:\n${errorMsg}`);
  }

  const totalApuesta = resultado.totalGeneral;
  if (totalApuesta === 0) return ctx.reply('❌ La jugada no tiene monto válido.');

  // Extraer detalles para validar límites por tipo
  const allDetails = [];
  (resultado.jugadas || []).forEach(j => {
    (j.jugadas_detalle || []).forEach(d => allDetails.push(d));
  });

  // Validación de límite por tipo (monto unitario)
  const limiteExcedido = await validarLimitesPorTipo(allDetails, pref.loteria_id, pref.sorteo_id);
  if (limiteExcedido) {
    return ctx.reply(`❌ Límite excedido para tipo "${limiteExcedido.tipo}". Máximo por número/combinación: $${limiteExcedido.maximo.toFixed(2)}. Apostaste: $${limiteExcedido.montoUnitario.toFixed(2)} por número/combinación.`);
  }

  // Verificar saldo
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(`❌ Saldo insuficiente. Necesitas $${totalApuesta.toFixed(2)} (${moneda.toUpperCase()}). Usa /depositar.`);
  }

  const saldoAntes = user.saldo;
  const saldoDespues = saldoAntes - totalApuesta;
  await updateUserSaldo(ctx.from.id, saldoDespues);
  await saveBet(ctx.from.id, pref.loteria_id, pref.sorteo_id, new Date().toISOString().slice(0,10), rawInput, totalApuesta, JSON.stringify(allDetails), saldoAntes, saldoDespues, moneda);

  let respuesta = `💰 *Total apostado:* $${totalApuesta.toFixed(2)} (${moneda.toUpperCase()})\n`;
  respuesta += `💰 *Saldo restante:* $${saldoDespues.toFixed(2)}\n\n`;
  if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
  if (resultado.flaggedWarnings?.length) {
    respuesta += '\n⚠️ Revisiones pendientes:\n' + resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
  }
  respuesta += `\n✅ *Jugada registrada.*`;
  await ctx.reply(respuesta, { parse_mode: 'Markdown' });
}

// ================================ INICIAR SERVIDOR ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`✅ Webhook: ${webhookPath}`);
  console.log(`👑 Admins: ${ADMIN_IDS.join(', ') || 'Ninguno'}`);
});
