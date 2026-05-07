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

// ================================ LÍMITES ACUMULATIVOS ================================
async function getAcumuladoPorNumero(loteriaId, sorteoId, fecha) {
  const { data: bets, error } = await supabase
    .from('bets')
    .select('detalle')
    .eq('loteria_id', loteriaId)
    .eq('sorteo_id', sorteoId)
    .eq('fecha_apuesta', fecha);
  if (error || !bets) return {};
  const acumulado = {};
  for (const bet of bets) {
    try {
      const detalles = JSON.parse(bet.detalle);
      for (const det of detalles) {
        const montoUnit = det.monto_unitario;
        if (!montoUnit) continue;
        const numeros = det.numeros || [];
        for (const num of numeros) {
          const key = String(num);
          acumulado[key] = (acumulado[key] || 0) + montoUnit;
        }
      }
    } catch(e) {}
  }
  return acumulado;
}

async function getLimitesGlobales(loteriaId, sorteoId) {
  let query = supabase.from('limits').select('*');
  if (loteriaId && sorteoId) {
    query = query.or(`loteria_id.eq.${loteriaId},loteria_id.is.null`)
                 .or(`sorteo_id.eq.${sorteoId},sorteo_id.is.null`);
  } else {
    query = query.is('loteria_id', null).is('sorteo_id', null);
  }
  const { data, error } = await query;
  if (error || !data) return {};
  const map = {};
  for (const item of data) map[item.tipo] = item.monto_maximo;
  return map;
}

async function validarLimitesAcumulativos(jugadasDetalle, loteriaId, sorteoId, fecha, limites) {
  if (!limites || Object.keys(limites).length === 0) return null;
  const acumulado = await getAcumuladoPorNumero(loteriaId, sorteoId, fecha);
  for (const detalle of jugadasDetalle) {
    const tipoBase = (detalle.tipo === 'candado' || detalle.tipo === 'candado_global') ? 'parle' : detalle.tipo;
    const limite = limites[tipoBase];
    if (!limite) continue;
    const montoUnitario = detalle.monto_unitario;
    if (!montoUnitario) continue;
    const numeros = detalle.numeros || [];
    for (const num of numeros) {
      const acumPrev = acumulado[num] || 0;
      if (acumPrev + montoUnitario > limite) {
        return { numero: num, tipo: tipoBase, montoActual: montoUnitario, acumPrev, limite };
      }
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

// ==================== VALIDACIÓN DE HORARIO ====================
async function validarHorarioSorteo(sorteoId) {
  const { data: sorteo, error } = await supabase
    .from('sorteos')
    .select('hora_apertura, hora_cierre, nombre, loteria_id')
    .eq('id', sorteoId)
    .single();
  
  if (error || !sorteo) {
    console.error(`Error al obtener sorteo ${sorteoId}:`, error);
    return { 
      open: false, 
      message: '❌ El sorteo seleccionado ya no está disponible. Por favor, selecciona otro sorteo con /start.' 
    };
  }

  if (!sorteo.hora_apertura || !sorteo.hora_cierre) {
    console.warn(`Sorteo ${sorteo.nombre} (ID ${sorteoId}) sin horarios. Se permite la apuesta.`);
    return { open: true, warning: true, message: '⚠️ Sorteo sin horario definido. Se permite la apuesta.' };
  }

  const ahora = new Date();
  const horaActual = ahora.getHours() * 60 + ahora.getMinutes();
  const [aperturaH, aperturaM] = sorteo.hora_apertura.split(':').map(Number);
  const [cierreH, cierreM] = sorteo.hora_cierre.split(':').map(Number);
  const aperturaMin = aperturaH * 60 + aperturaM;
  const cierreMin = cierreH * 60 + cierreM;

  if (horaActual < aperturaMin) {
    return {
      open: false,
      message: `⏰ El sorteo "${sorteo.nombre}" aún no ha abierto.\n📅 Horario: ${sorteo.hora_apertura.slice(0,5)} - ${sorteo.hora_cierre.slice(0,5)}.\nVuelve más tarde.`
    };
  }
  if (horaActual >= cierreMin) {
    return {
      open: false,
      message: `⏰ El sorteo "${sorteo.nombre}" ya cerró.\n📅 Horario: ${sorteo.hora_apertura.slice(0,5)} - ${sorteo.hora_cierre.slice(0,5)}.\nNo se aceptan más apuestas.`
    };
  }
  return { open: true };
}

// ==================== GESTIÓN DE JUGADAS (USUARIO) ====================
async function getUserBets(telegramId, sorteoId = null, fecha = null) {
  let query = supabase
    .from('bets')
    .select(`
      *,
      sorteos!inner (hora_cierre, nombre)
    `)
    .eq('user_telegram_id', telegramId)
    .order('created_at', { ascending: false });
  if (sorteoId) query = query.eq('sorteo_id', sorteoId);
  if (fecha) query = query.eq('fecha_apuesta', fecha);
  const { data, error } = await query;
  if (error) return [];
  return data;
}

async function isBetEditable(bet) {
  const hoy = new Date().toISOString().slice(0,10);
  if (bet.fecha_apuesta !== hoy) return false;
  const ahora = new Date();
  const horaActual = ahora.getHours() * 60 + ahora.getMinutes();
  const { data: sorteo, error } = await supabase
    .from('sorteos')
    .select('hora_cierre')
    .eq('id', bet.sorteo_id)
    .single();
  if (error || !sorteo) return false;
  const [cierreH, cierreM] = sorteo.hora_cierre.split(':').map(Number);
  const cierreMin = cierreH * 60 + cierreM;
  return horaActual < cierreMin;
}

// ================================ CONFIGURACIÓN DEL BOT ================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN no definido');
  process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => { console.log(`📨 [${req.method}] ${req.path}`); next(); });
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot profesional'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => { bot.webhookCallback(webhookPath)(req, res); });

// Estados
const depositStates = new Map();
const rejectState = new Map();

// ================================ BOTONERA PRINCIPAL ================================
async function showMainMenu(ctx) {
  const pref = await getUserPreference(ctx.from.id);
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  let texto = '🏠 *Menú Principal*\n\n';
  texto += `💰 *Saldo:* $${user.saldo.toFixed(2)}\n`;
  if (pref && pref.loteria_id && pref.sorteo_id) {
    const { data: lot } = await supabase.from('loterias').select('nombre').eq('id', pref.loteria_id).single();
    const { data: sor } = await supabase.from('sorteos').select('nombre').eq('id', pref.sorteo_id).single();
    texto += `🎰 *Sorteo activo:* ${lot?.nombre} - ${sor?.nombre}\n`;
    texto += `💵 *Moneda:* ${pref.moneda?.toUpperCase()}\n\n`;
  } else {
    texto += '⚠️ *No has seleccionado un sorteo activo.*\n\n';
  }
  const keyboard = {
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
  await ctx.reply(texto, { parse_mode: 'Markdown', ...keyboard });
}

// ================================ CALLBACKS DE MENÚ ================================
bot.action('menu_loterias', async (ctx) => {
  try {
    const loterias = await getLoterias();
    if (!loterias.length) {
      await ctx.answerCbQuery('No hay loterías activas');
      await ctx.editMessageText('❌ No hay loterías disponibles.');
      return;
    }
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          ...loterias.map(l => [{ text: l.nombre, callback_data: `sel_lot_${l.id}` }]),
          [{ text: '🔙 Volver', callback_data: 'menu_main' }]
        ]
      }
    };
    await ctx.editMessageText('🎰 *Selecciona una lotería:*', { parse_mode: 'Markdown', ...keyboard });
  } catch (err) {
    console.error('Error en menu_loterias:', err);
    await ctx.answerCbQuery('Error, intenta de nuevo');
  }
});

bot.action(/sel_lot_(\d+)/, async (ctx) => {
  try {
    const lotId = parseInt(ctx.match[1]);
    const sorteos = await getSorteos(lotId);
    if (!sorteos.length) {
      await ctx.answerCbQuery('Esta lotería no tiene sorteos activos');
      await ctx.editMessageText('❌ No hay sorteos disponibles para esta lotería.');
      return;
    }
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          ...sorteos.map(s => [{ text: `${s.nombre} (${s.hora_apertura.slice(0,5)}-${s.hora_cierre.slice(0,5)})`, callback_data: `sel_sor_${s.id}` }]),
          [{ text: '🔙 Volver', callback_data: 'menu_loterias' }]
        ]
      }
    };
    await ctx.editMessageText(`🎲 *Sorteos disponibles:*`, { parse_mode: 'Markdown', ...keyboard });
  } catch (err) {
    console.error('Error en sel_lot:', err);
    await ctx.answerCbQuery('Error, intenta de nuevo');
  }
});

bot.action(/sel_sor_(\d+)/, async (ctx) => {
  try {
    const sorId = parseInt(ctx.match[1]);
    const { data: sorteo, error } = await supabase.from('sorteos').select('*, loterias!inner(nombre)').eq('id', sorId).single();
    if (error) {
      await ctx.answerCbQuery('Error al seleccionar sorteo');
      return;
    }
    const pref = await getUserPreference(ctx.from.id) || {};
    await saveUserPreference(ctx.from.id, sorteo.loteria_id, sorId, pref.moneda || 'cup');
    await ctx.answerCbQuery(`Sorteo ${sorteo.nombre} seleccionado`);
    await ctx.editMessageText(`✅ *Sorteo seleccionado:* ${sorteo.loterias.nombre} - ${sorteo.nombre}\n\nAhora puedes enviar tu jugada directamente.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error en sel_sor:', err);
    await ctx.answerCbQuery('Error al seleccionar sorteo');
  }
});

bot.action('menu_moneda', async (ctx) => {
  try {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇨🇺 CUP', callback_data: 'moneda_cup' }],
          [{ text: '💳 MLC', callback_data: 'moneda_mlc' }],
          [{ text: '🇺🇸 USD', callback_data: 'moneda_usd' }],
          [{ text: '🔙 Volver', callback_data: 'menu_main' }]
        ]
      }
    };
    await ctx.editMessageText('💵 *Selecciona tu moneda preferida:*', { parse_mode: 'Markdown', ...keyboard });
  } catch (err) {
    console.error('Error en menu_moneda:', err);
    await ctx.answerCbQuery('Error, intenta de nuevo');
  }
});

bot.action(/moneda_(cup|mlc|usd)/, async (ctx) => {
  try {
    const moneda = ctx.match[1];
    const pref = await getUserPreference(ctx.from.id);
    await saveUserPreference(ctx.from.id, pref?.loteria_id || null, pref?.sorteo_id || null, moneda);
    await ctx.answerCbQuery(`Moneda ${moneda.toUpperCase()} seleccionada`);
    await ctx.editMessageText(`✅ *Moneda seleccionada:* ${moneda.toUpperCase()}`);
  } catch (err) {
    console.error('Error en moneda:', err);
    await ctx.answerCbQuery('Error al cambiar moneda');
  }
});

bot.action('menu_mis_jugadas', async (ctx) => {
  const pref = await getUserPreference(ctx.from.id);
  if (!pref?.sorteo_id) {
    await ctx.answerCbQuery('Primero selecciona un sorteo');
    await ctx.editMessageText('⚠️ Primero debes seleccionar un sorteo desde el menú principal.');
    return;
  }
  const bets = await getUserBets(ctx.from.id, pref.sorteo_id, new Date().toISOString().slice(0,10));
  if (!bets.length) {
    await ctx.answerCbQuery('No tienes jugadas hoy');
    await ctx.editMessageText('📭 No tienes jugadas registradas en el sorteo actual.');
    return;
  }
  let msg = '📋 *Tus jugadas de hoy:*\n\n';
  for (const bet of bets) {
    const editable = await isBetEditable(bet);
    const status = editable ? '🟢' : '🔴';
    msg += `${status} *ID:* ${bet.id}\n💰 $${bet.total_apuesta.toFixed(2)}\n📝 ${bet.input_raw.substring(0, 80)}...\n\n`;
  }
  const betsWithEditable = await Promise.all(bets.slice(0, 6).map(async (bet) => {
    const editable = await isBetEditable(bet);
    return { ...bet, editable };
  }));
  const inlineButtons = betsWithEditable.map(bet => [
    { text: `${bet.editable ? '✏️' : '🔒'} Editar #${bet.id}`, callback_data: `edit_bet_${bet.id}` },
    { text: `${bet.editable ? '❌' : '🔒'} Eliminar #${bet.id}`, callback_data: `del_bet_${bet.id}` }
  ]).flat();
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        ...(inlineButtons.length ? [inlineButtons.slice(0, 2)] : []),
        [{ text: '🔙 Menú principal', callback_data: 'menu_main' }]
      ]
    }
  };
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action(/edit_bet_(\d+)/, async (ctx) => {
  const betId = parseInt(ctx.match[1]);
  const { data: bet, error } = await supabase.from('bets').select('*').eq('id', betId).single();
  if (error || !bet) {
    await ctx.answerCbQuery('Jugada no encontrada');
    return;
  }
  if (!(await isBetEditable(bet))) {
    await ctx.answerCbQuery('⏰ El sorteo ya cerró, no se puede editar');
    return;
  }
  await ctx.answerCbQuery('Jugada cargada para edición');
  await ctx.reply(`✏️ *Editar jugada #${betId}*\n\nCopia y modifica este texto:\n\`\`\`\n${bet.input_raw}\n\`\`\`\nLuego envíala como una nueva jugada (la original deberás eliminarla manualmente).`);
});

bot.action(/del_bet_(\d+)/, async (ctx) => {
  const betId = parseInt(ctx.match[1]);
  const { data: bet, error } = await supabase.from('bets').select('*').eq('id', betId).single();
  if (error || !bet) {
    await ctx.answerCbQuery('Jugada no encontrada');
    return;
  }
  if (!(await isBetEditable(bet))) {
    await ctx.answerCbQuery('⏰ El sorteo ya cerró, no se puede eliminar');
    return;
  }
  const confirmKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Sí, eliminar', callback_data: `confirm_del_${betId}` }],
        [{ text: '❌ Cancelar', callback_data: 'cancel_del' }]
      ]
    }
  };
  await ctx.editMessageText(`⚠️ ¿Eliminar jugada #${betId}?\nMonto: $${bet.total_apuesta.toFixed(2)}`, confirmKeyboard);
});

bot.action(/confirm_del_(\d+)/, async (ctx) => {
  const betId = parseInt(ctx.match[1]);
  const { data: bet, error } = await supabase.from('bets').select('*').eq('id', betId).single();
  if (error || !bet) {
    await ctx.answerCbQuery('Jugada no encontrada');
    return;
  }
  if (!(await isBetEditable(bet))) {
    await ctx.answerCbQuery('⏰ El sorteo ya cerró, no se puede eliminar');
    return;
  }
  await supabase.from('bets').delete().eq('id', betId);
  const { data: user } = await supabase.from('users').select('saldo').eq('telegram_id', bet.user_telegram_id).single();
  if (user) {
    const nuevoSaldo = user.saldo + bet.total_apuesta;
    await updateUserSaldo(bet.user_telegram_id, nuevoSaldo);
  }
  await ctx.answerCbQuery('Jugada eliminada');
  await ctx.editMessageText(`✅ Jugada #${betId} eliminada. Se reintegraron $${bet.total_apuesta.toFixed(2)} a tu saldo.`);
});

bot.action('cancel_del', async (ctx) => {
  await ctx.answerCbQuery('Cancelado');
  await ctx.deleteMessage();
});

bot.action('menu_depositar', async (ctx) => {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💳 Tarjeta', callback_data: 'dep_method_tarjeta' }],
        [{ text: '🏦 Transferencia', callback_data: 'dep_method_transferencia' }],
        [{ text: '📱 Monedero', callback_data: 'dep_method_monedero' }],
        [{ text: '🔙 Volver', callback_data: 'menu_main' }]
      ]
    }
  };
  await ctx.editMessageText('💸 *Selecciona método de pago para depositar:*', { parse_mode: 'Markdown', ...keyboard });
});

bot.action(/dep_method_(.+)/, async (ctx) => {
  const method = ctx.match[1];
  depositStates.set(ctx.from.id, { method, step: 'amount' });
  await ctx.editMessageText(`Método: ${method}\n✍️ *Escribe el monto a depositar:*`, { parse_mode: 'Markdown' });
});

bot.action('menu_historial', async (ctx) => {
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('user_telegram_id', ctx.from.id)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error || !bets || !bets.length) {
    await ctx.answerCbQuery('No hay historial');
    await ctx.editMessageText('📭 No tienes jugadas registradas.');
    return;
  }
  let msg = '📜 *Tus últimas 5 jugadas:*\n\n';
  bets.forEach(b => {
    msg += `💰 $${b.total_apuesta.toFixed(2)} - ${new Date(b.created_at).toLocaleString()}\n📝 ${b.detalle?.substring(0, 100)}…\n\n`;
  });
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] } };
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('menu_ayuda', async (ctx) => {
  const ayuda = `📖 *Ayuda rápida*

1️⃣ *Selecciona un sorteo* desde el menú.
2️⃣ *Envía tu jugada* en formato DSL.
   Ejemplo: \`pepe\nt5 con 500\`
3️⃣ *Consulta tu saldo* con /saldo.
4️⃣ *Deposita* desde el menú (envía comprobante).
5️⃣ *Administradores*: usen /admin_panel.

Para más detalles, contacta al soporte.`;
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] } };
  await ctx.editMessageText(ayuda, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('menu_main', async (ctx) => {
  try {
    await showMainMenu(ctx);
  } catch (err) {
    console.error('Error en menu_main:', err);
    await ctx.reply('⚠️ Ocurrió un error al mostrar el menú. Por favor, usa /start nuevamente.');
  }
});

// ================================ PANEL DE ADMINISTRACIÓN ================================
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

bot.command('admin_panel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Comando solo para administradores.');
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Ver solicitudes depósito', callback_data: 'admin_pendientes' }],
        [{ text: '🎲 Ver jugadas del día', callback_data: 'admin_jugadas_hoy' }],
        [{ text: '📊 Estadísticas', callback_data: 'admin_estadisticas' }],
        [{ text: '⚙️ Gestionar límites', callback_data: 'admin_limites' }],
        [{ text: '🕒 Ver horarios', callback_data: 'admin_horarios' }]
      ]
    }
  };
  await ctx.reply('👑 *Panel de Administración*', { parse_mode: 'Markdown', ...keyboard });
});

bot.action('admin_pendientes', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const { data: pendings, error } = await supabase
    .from('deposit_requests')
    .select('*, users!inner(telegram_id, username, first_name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error || !pendings.length) {
    await ctx.answerCbQuery('No hay solicitudes pendientes');
    await ctx.editMessageText('✅ No hay solicitudes de depósito pendientes.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } });
    return;
  }
  let msg = '📋 *Solicitudes de depósito pendientes:*\n\n';
  for (const p of pendings) {
    msg += `ID: ${p.id}\n👤 ${p.users.first_name || p.users.username || p.users.telegram_id}\n💰 $${p.amount.toFixed(2)}\n💳 ${p.payment_method}\n📎 <a href="https://t.me/file/${p.proof_file_id}">Ver comprobante</a>\n\n`;
  }
  const keyboard = pendings.map(p => [
    { text: `✅ Aprobar #${p.id}`, callback_data: `admin_aprob_${p.id}` },
    { text: `❌ Rechazar #${p.id}`, callback_data: `admin_rech_${p.id}` }
  ]).flat();
  const backButton = [{ text: '🔙 Volver', callback_data: 'admin_panel' }];
  const rows = [];
  for (let i = 0; i < keyboard.length; i += 2) rows.push(keyboard.slice(i, i+2));
  rows.push(backButton);
  await ctx.editMessageText(msg, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: rows } });
});

bot.action(/admin_aprob_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match[1]);
  try {
    const { userId, amount, nuevoSaldo } = await approveDeposit(id, ctx.from.id);
    await ctx.answerCbQuery(`Depósito #${id} aprobado`);
    await ctx.editMessageText(`✅ Depósito #${id} aprobado. Usuario ${userId} recibe $${amount.toFixed(2)}. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
    try { await bot.telegram.sendMessage(userId, `✅ Tu depósito de $${amount.toFixed(2)} ha sido aprobado. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`); } catch(e) {}
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`);
  }
});

bot.action(/admin_rech_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match[1]);
  await ctx.answerCbQuery('Escribe el motivo del rechazo en el chat.');
  rejectState.set(ctx.from.id, id);
  await ctx.reply(`Escribe el motivo del rechazo para la solicitud #${id}:`);
});

bot.action('admin_jugadas_hoy', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const hoy = new Date().toISOString().slice(0,10);
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*, users(first_name, username), sorteos(nombre)')
    .eq('fecha_apuesta', hoy)
    .order('created_at', { ascending: false });
  if (error || !bets.length) {
    await ctx.answerCbQuery('No hay jugadas hoy');
    await ctx.editMessageText('📭 No se registraron jugadas hoy.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } });
    return;
  }
  let msg = `📊 *Jugadas del día ${hoy}:*\n\n`;
  let totalGeneral = 0;
  for (const b of bets.slice(0, 10)) {
    totalGeneral += b.total_apuesta;
    msg += `👤 ${b.users.first_name || b.users.username || b.user_telegram_id}\n🎲 ${b.sorteos.nombre}\n💰 $${b.total_apuesta.toFixed(2)}\n📝 \`${b.input_raw.substring(0, 60)}...\`\n\n`;
  }
  msg += `*Total recogido hoy: $${totalGeneral.toFixed(2)}*\n`;
  if (bets.length > 10) msg += `\n*Mostrando las 10 más recientes.*`;
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } };
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('admin_estadisticas', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const hoy = new Date().toISOString().slice(0,10);
  const { data: bets, error } = await supabase.from('bets').select('total_apuesta, user_telegram_id').eq('fecha_apuesta', hoy);
  if (error) return ctx.reply('Error consultando estadísticas');
  const total = bets.reduce((s, b) => s + b.total_apuesta, 0);
  const usuarios = new Set(bets.map(b => b.user_telegram_id)).size;
  const topUsers = Object.entries(bets.reduce((acc, b) => {
    acc[b.user_telegram_id] = (acc[b.user_telegram_id] || 0) + b.total_apuesta;
    return acc;
  }, {})).sort((a,b) => b[1] - a[1]).slice(0, 5);
  let topMsg = '';
  for (const [uid, monto] of topUsers) {
    const { data: u } = await supabase.from('users').select('first_name, username').eq('telegram_id', uid).single();
    topMsg += `👤 ${u?.first_name || u?.username || uid} → $${monto.toFixed(2)}\n`;
  }
  const msg = `📊 *Estadísticas del día ${hoy}*\n\n*Total recogido:* $${total.toFixed(2)}\n*Usuarios que apostaron:* ${usuarios}\n\n*Top 5 apostadores:*\n${topMsg}`;
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } };
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('admin_limites', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const { data: limites, error } = await supabase.from('limits').select('*').is('loteria_id', null).is('sorteo_id', null);
  if (error) return ctx.reply('Error');
  let msg = '⚙️ *Límites actuales (globales):*\n\n';
  for (const l of limites) msg += `• *${l.tipo}* → $${l.monto_maximo.toFixed(2)}\n`;
  msg += '\n*Comandos para modificar:*\n/set_limit <tipo> <monto>\nTipos: fijo, corrido, parle, centena';
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } };
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('admin_horarios', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const { data: sorteos, error } = await supabase
    .from('sorteos')
    .select('id, nombre, loterias(nombre), hora_apertura, hora_cierre')
    .order('id');
  if (error || !sorteos.length) return ctx.editMessageText('No hay sorteos configurados.');
  let msg = '*Horarios de sorteos:*\n\n';
  for (const s of sorteos) {
    msg += `🎲 *${s.loterias?.nombre || '?'} - ${s.nombre}*\n`;
    const apertura = s.hora_apertura ? s.hora_apertura.slice(0,5) : '?';
    const cierre = s.hora_cierre ? s.hora_cierre.slice(0,5) : '?';
    msg += `   ⏰ ${apertura} → ${cierre}\n\n`;
  }
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } };
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
});

// ================================ MANEJO DE TEXTO ================================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  // Rechazar depósito (admin)
  if (rejectState.has(userId)) {
    const id = rejectState.get(userId);
    const reason = ctx.message.text;
    rejectState.delete(userId);
    try {
      await rejectDeposit(id, userId, reason);
      const { data: req } = await supabase.from('deposit_requests').select('user_telegram_id').eq('id', id).single();
      if (req) await bot.telegram.sendMessage(req.user_telegram_id, `❌ Tu depósito fue rechazado. Motivo: ${reason}`);
      await ctx.reply(`✅ Depósito #${id} rechazado.`);
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
    return;
  }
  // Procesar depósito en paso amount
  if (state && state.step === 'amount') {
    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Monto inválido.');
    state.amount = amount;
    state.step = 'proof';
    depositStates.set(userId, state);
    await ctx.reply(`Monto: $${amount.toFixed(2)}\nAhora envía una imagen o documento como comprobante.`);
    return;
  }
  // Si no hay flujo, procesar apuesta normal
  await processBet(ctx, ctx.message.text);
});

bot.on(['photo', 'document'], async (ctx) => {
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  if (!state || state.step !== 'proof') {
    return ctx.reply('No estás en proceso de depósito. Usa /start y selecciona "Depositar" en el menú.');
  }
  let fileId;
  if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  else if (ctx.message.document) fileId = ctx.message.document.file_id;
  else return ctx.reply('Envía una imagen o documento.');
  try {
    const deposit = await createDepositRequest(userId, state.amount, state.method, fileId);
    depositStates.delete(userId);
    await ctx.reply(`✅ Solicitud creada.\nID: ${deposit.id}\nMonto: $${deposit.amount}\nMétodo: ${deposit.payment_method}\nEl administrador revisará y aprobará.`);
    for (const adminId of ADMIN_IDS) {
      try { await bot.telegram.sendMessage(adminId, `📥 Nueva solicitud #${deposit.id}\nUsuario: ${userId}\nMonto: $${deposit.amount}`); } catch(e) {}
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
    return ctx.reply('⚠️ Primero selecciona un sorteo desde el menú principal usando /start.');
  }
  const moneda = pref.moneda || 'cup';
  const horario = await validarHorarioSorteo(pref.sorteo_id);
  if (!horario.open) {
    return ctx.reply(horario.message);
  }
  if (horario.warning) {
    await ctx.reply(horario.message);
  }
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
  const allDetails = [];
  (resultado.jugadas || []).forEach(j => {
    (j.jugadas_detalle || []).forEach(d => allDetails.push(d));
  });
  const limites = await getLimitesGlobales(pref.loteria_id, pref.sorteo_id);
  const fechaHoy = new Date().toISOString().slice(0,10);
  const violacion = await validarLimitesAcumulativos(allDetails, pref.loteria_id, pref.sorteo_id, fechaHoy, limites);
  if (violacion) {
    return ctx.reply(`❌ Límite excedido para tipo "${violacion.tipo}". El número ${violacion.numero} ya acumula $${violacion.acumPrev.toFixed(2)} apostados. Máximo: $${violacion.limite.toFixed(2)}. Esta apuesta añade $${violacion.montoActual.toFixed(2)}.`);
  }
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(`❌ Saldo insuficiente. Necesitas $${totalApuesta.toFixed(2)} (${moneda.toUpperCase()}). Usa el menú para depositar.`);
  }
  const saldoAntes = user.saldo;
  const saldoDespues = saldoAntes - totalApuesta;
  await updateUserSaldo(ctx.from.id, saldoDespues);
  await saveBet(ctx.from.id, pref.loteria_id, pref.sorteo_id, fechaHoy, rawInput, totalApuesta, JSON.stringify(allDetails), saldoAntes, saldoDespues, moneda);
  let respuesta = `💰 *Total apostado:* $${totalApuesta.toFixed(2)} (${moneda.toUpperCase()})\n💰 *Saldo restante:* $${saldoDespues.toFixed(2)}\n\n`;
  if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
  if (resultado.flaggedWarnings?.length) {
    respuesta += '\n⚠️ Revisiones pendientes:\n' + resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
  }
  respuesta += `\n✅ *Jugada registrada.*`;
  await ctx.reply(respuesta, { parse_mode: 'Markdown' });
}

// ================================ COMANDOS ADICIONALES ================================
bot.command('start', async (ctx) => {
  await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  await showMainMenu(ctx);
});

bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Saldo actual: $${user.saldo.toFixed(2)}`);
});

bot.command('ver_limites', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const { data: limites, error } = await supabase.from('limits').select('*').is('loteria_id', null).is('sorteo_id', null);
  if (error || !limites.length) return ctx.reply('No hay límites configurados. Usa /set_limit <tipo> <monto>');
  let msg = '*Límites globales:*\n';
  for (const l of limites) msg += `• ${l.tipo}: $${l.monto_maximo.toFixed(2)}\n`;
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('set_limit', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Uso: /set_limit <tipo> <monto>');
  const tipo = args[1].toLowerCase();
  const monto = parseFloat(args[2]);
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido');
  const tiposPermitidos = ['fijo', 'corrido', 'parle', 'centena'];
  if (!tiposPermitidos.includes(tipo)) return ctx.reply(`Tipo inválido. Permitidos: ${tiposPermitidos.join(', ')}`);
  const { data: existing } = await supabase.from('limits').select('id').eq('tipo', tipo).is('loteria_id', null).is('sorteo_id', null).maybeSingle();
  if (existing) {
    await supabase.from('limits').update({ monto_maximo: monto, updated_at: new Date() }).eq('id', existing.id);
    ctx.reply(`✅ Límite para ${tipo} actualizado a $${monto.toFixed(2)}`);
  } else {
    await supabase.from('limits').insert([{ tipo, monto_maximo: monto, loteria_id: null, sorteo_id: null, updated_at: new Date() }]);
    ctx.reply(`✅ Límite para ${tipo} establecido en $${monto.toFixed(2)}`);
  }
});

bot.command('horarios', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const { data: sorteos, error } = await supabase
    .from('sorteos')
    .select('id, nombre, loterias(nombre), hora_apertura, hora_cierre')
    .order('id');
  if (error || !sorteos.length) return ctx.reply('No hay sorteos configurados.');
  let msg = '*Horarios de sorteos:*\n\n';
  for (const s of sorteos) {
    msg += `🎲 *${s.loterias?.nombre || '?'} - ${s.nombre}*\n`;
    const apertura = s.hora_apertura ? s.hora_apertura.slice(0,5) : '?';
    const cierre = s.hora_cierre ? s.hora_cierre.slice(0,5) : '?';
    msg += `   ⏰ ${apertura} → ${cierre}\n\n`;
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('diagnostico', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const { data: sorteos, error } = await supabase.from('sorteos').select('*');
  if (error) return ctx.reply(`Error: ${error.message}`);
  if (!sorteos.length) return ctx.reply('No hay sorteos en la base de datos.');
  let msg = '*Diagnóstico de sorteos:*\n\n';
  for (const s of sorteos) {
    const horario = s.hora_apertura && s.hora_cierre ? `${s.hora_apertura.slice(0,5)} - ${s.hora_cierre.slice(0,5)}` : '❌ Sin horario';
    msg += `ID: ${s.id} - ${s.nombre}\n   Horario: ${horario}\n   Loteria ID: ${s.loteria_id}\n\n`;
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ================================ INICIAR SERVIDOR ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook: ${webhookPath}`);
  console.log(`👑 Admins: ${ADMIN_IDS.join(', ') || 'Ninguno'}`);
});
