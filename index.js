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

// ==================== NORMALIZACIÓN AVANZADA ====================
function expandirParleMixto(linea) {
  const regex = /^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+parle\s+con\s+(\d+(?:\.\d+)?)$/i;
  const match = linea.match(regex);
  if (!match) return linea;
  const nums = match[1].trim();
  const monto1 = match[2];
  const monto2 = match[3];
  return `${nums} con ${monto1}\nparle con ${monto2}`;
}

function expandirLineaMixta(linea) {
  let resultado = expandirParleMixto(linea);
  if (resultado.includes('\n')) return resultado;

  const regex = /^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)\s+candado\s+con\s+(\d+(?:\.\d+)?)$/i;
  const match = resultado.match(regex);
  if (!match) return resultado;
  const nums = match[1].trim();
  const monto1 = match[2];
  const monto2 = match[3];
  const monto3 = match[4];
  return `${nums} con ${monto1}\n${nums} corrido con ${monto2}\n${nums} candado con ${monto3}`;
}

function preprocesarLineasMixtas(texto) {
  const lines = texto.split('\n');
  const nuevas = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    line = expandirLineaMixta(line);
    const subLines = line.split('\n');
    for (const sub of subLines) {
      if (sub.trim()) nuevas.push(sub.trim());
    }
  }
  return nuevas.join('\n');
}

// ================================ HELPERS BD ================================
async function getOrCreateUser(telegramId, username, firstName) {
  let { data: user, error } = await supabase
    .from('users').select('*').eq('telegram_id', telegramId).single();
  if (error && error.code !== 'PGRST116') return null;
  if (!user) {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ telegram_id: telegramId, username, first_name: firstName, saldo: 0 }])
      .select().single();
    if (insertError) return null;
    user = newUser;
  }
  return user;
}

async function updateUserSaldo(telegramId, nuevoSaldo) {
  await supabase.from('users')
    .update({ saldo: nuevoSaldo, updated_at: new Date() })
    .eq('telegram_id', telegramId);
}

async function saveBet(userTelegramId, loteriaId, sorteoId, fecha, inputRaw, totalApuesta, detalle, saldoAntes, saldoDespues, moneda) {
  await supabase.from('bets').insert([{
    user_telegram_id: userTelegramId, loteria_id: loteriaId, sorteo_id: sorteoId,
    fecha_apuesta: fecha, input_raw: inputRaw, total_apuesta: totalApuesta,
    detalle, saldo_antes: saldoAntes, saldo_despues: saldoDespues, moneda: moneda || 'cup'
  }]);
}

async function createDepositRequest(userTelegramId, amount, paymentMethod, proofFileId) {
  const { data, error } = await supabase.from('deposit_requests').insert([{
    user_telegram_id: userTelegramId, amount, payment_method: paymentMethod,
    proof_file_id: proofFileId, status: 'pending'
  }]).select().single();
  if (error) throw error;
  return data;
}

async function approveDeposit(requestId, adminId) {
  const { data: req, error: fetchError } = await supabase
    .from('deposit_requests').select('*').eq('id', requestId).single();
  if (fetchError || !req) throw new Error('Solicitud no encontrada');
  await supabase.from('deposit_requests')
    .update({ status: 'approved', admin_notes: `Aprobado por ${adminId}`, updated_at: new Date() })
    .eq('id', requestId);
  const { data: user, error: userError } = await supabase
    .from('users').select('saldo').eq('telegram_id', req.user_telegram_id).single();
  if (userError) throw userError;
  const nuevoSaldo = (user.saldo || 0) + req.amount;
  await updateUserSaldo(req.user_telegram_id, nuevoSaldo);
  return { userId: req.user_telegram_id, amount: req.amount, nuevoSaldo };
}

async function rejectDeposit(requestId, adminId, reason = '') {
  await supabase.from('deposit_requests')
    .update({ status: 'rejected', admin_notes: `Rechazado por ${adminId}: ${reason}`, updated_at: new Date() })
    .eq('id', requestId);
}

// ================================ LÍMITES ================================
async function getAcumuladoPorNumero(loteriaId, sorteoId, fecha) {
  const { data: bets, error } = await supabase.from('bets').select('detalle')
    .eq('loteria_id', loteriaId).eq('sorteo_id', sorteoId).eq('fecha_apuesta', fecha);
  if (error || !bets) return {};
  const acumulado = {};
  for (const bet of bets) {
    try {
      const detalles = JSON.parse(bet.detalle);
      for (const det of detalles) {
        if (!det.monto_unitario) continue;
        for (const num of (det.numeros || [])) {
          const key = String(num);
          acumulado[key] = (acumulado[key] || 0) + det.monto_unitario;
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
    if (!limite || !detalle.monto_unitario) continue;
    for (const num of (detalle.numeros || [])) {
      const acumPrev = acumulado[num] || 0;
      if (acumPrev + detalle.monto_unitario > limite) {
        return { numero: num, tipo: tipoBase, montoActual: detalle.monto_unitario, acumPrev, limite };
      }
    }
  }
  return null;
}

// ================================ CATÁLOGOS ================================
async function getLoterias() {
  const { data, error } = await supabase.from('loterias').select('*').eq('activo', true).order('id');
  if (error) throw error;
  return data;
}

async function getSorteos(loteriaId) {
  const { data, error } = await supabase.from('sorteos').select('*')
    .eq('loteria_id', loteriaId).eq('activo', true).order('hora_apertura');
  if (error) throw error;
  return data;
}

async function getUserPreference(telegramId) {
  const { data, error } = await supabase.from('user_preferences').select('*')
    .eq('telegram_id', telegramId).single();
  if (error && error.code !== 'PGRST116') return null;
  return data;
}

async function saveUserPreference(telegramId, loteriaId, sorteoId, moneda) {
  await supabase.from('user_preferences').upsert({
    telegram_id: telegramId, loteria_id: loteriaId, sorteo_id: sorteoId,
    moneda, updated_at: new Date()
  }, { onConflict: 'telegram_id' });
}

// ==================== VALIDACIÓN DE HORARIO CON ZONA HORARIA CUBA ====================
async function validarHorarioSorteo(sorteoId) {
  const { data: sorteo, error } = await supabase.from('sorteos')
    .select('hora_apertura, hora_cierre, nombre, loteria_id, activo')
    .eq('id', sorteoId).single();
  if (error) {
    if (error.code === 'PGRST116') return { open: false, message: '❌ El sorteo guardado ya no existe. Selecciona uno nuevo con /start.' };
    return { open: false, message: '❌ Error al verificar el sorteo. Intenta de nuevo.' };
  }
  if (!sorteo) return { open: false, message: '❌ Sorteo no encontrado.' };
  if (sorteo.activo === false || sorteo.activo === 0)
    return { open: false, message: `❌ El sorteo "${sorteo.nombre}" está inactivo.` };
  if (!sorteo.hora_apertura || !sorteo.hora_cierre) return { open: true };

  // Obtener hora actual en la zona horaria de Cuba (America/Havana)
  const now = new Date();
  const havanaTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Havana' }));
  const horaActual = havanaTime.getHours() * 60 + havanaTime.getMinutes();

  const [ah, am] = sorteo.hora_apertura.split(':').map(Number);
  const [ch, cm] = sorteo.hora_cierre.split(':').map(Number);
  const aperturaMin = ah * 60 + am;
  const cierreMin = ch * 60 + cm;

  if (horaActual < aperturaMin)
    return { open: false, message: `⏰ El sorteo "${sorteo.nombre}" aún no ha abierto.\nHorario: ${sorteo.hora_apertura.slice(0,5)} - ${sorteo.hora_cierre.slice(0,5)} (hora local Cuba).` };
  if (horaActual >= cierreMin)
    return { open: false, message: `⏰ El sorteo "${sorteo.nombre}" ya cerró.\nHorario: ${sorteo.hora_apertura.slice(0,5)} - ${sorteo.hora_cierre.slice(0,5)} (hora local Cuba).` };
  return { open: true };
}

async function getUserBets(telegramId, sorteoId = null, fecha = null) {
  let query = supabase.from('bets').select('*, sorteos (hora_cierre, nombre)')
    .eq('user_telegram_id', telegramId).order('created_at', { ascending: false });
  if (sorteoId) query = query.eq('sorteo_id', sorteoId);
  if (fecha) query = query.eq('fecha_apuesta', fecha);
  const { data, error } = await query;
  if (error) { console.error('getUserBets error:', error.message); return []; }
  return data || [];
}

async function isBetEditable(bet) {
  const hoy = new Date().toISOString().slice(0,10);
  if (bet.fecha_apuesta !== hoy) return false;
  const ahora = new Date();
  const havanaTime = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Havana' }));
  const horaActual = havanaTime.getHours() * 60 + havanaTime.getMinutes();
  const { data: sorteo, error } = await supabase.from('sorteos')
    .select('hora_cierre').eq('id', bet.sorteo_id).single();
  if (error || !sorteo || !sorteo.hora_cierre) return true;
  const parts = sorteo.hora_cierre.split(':').map(Number);
  const cierreMin = (parts[0] || 0) * 60 + (parts[1] || 0);
  return horaActual < cierreMin;
}

// ================================ BOT SETUP ================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN no definido'); process.exit(1); }

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',')
  .map(id => parseInt(id.trim())).filter(id => !isNaN(id));

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res).catch(err => {
    console.error('❌ Error en webhook:', err);
    if (!res.headersSent) res.status(500).send('Error interno');
  });
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot'));

const depositStates = new Map();
const rejectState = new Map();

// ================================ MENÚ PRINCIPAL ================================
async function buildMainMenu(userId, username, firstName) {
  const user = await getOrCreateUser(userId, username, firstName);
  let pref = await getUserPreference(userId);
  let texto = '🏠 *Menú Principal*\n\n';
  texto += `💰 *Saldo:* $${user.saldo.toFixed(2)}\n`;

  let sorteoValido = false;
  if (pref && pref.loteria_id && pref.sorteo_id) {
    const { data: sorteo, error } = await supabase.from('sorteos')
      .select('id, nombre').eq('id', pref.sorteo_id).single();
    if (!error && sorteo) {
      sorteoValido = true;
      const lot = await supabase.from('loterias').select('nombre').eq('id', pref.loteria_id).single();
      texto += `🎰 *Sorteo activo:* ${lot.data?.nombre || '?'} - ${sorteo.nombre}\n`;
      texto += `💵 *Moneda:* ${(pref.moneda || 'cup').toUpperCase()}\n\n`;
    } else {
      await supabase.from('user_preferences').delete().eq('telegram_id', userId);
      pref = null;
    }
  }
  if (!sorteoValido) texto += '⚠️ No has seleccionado un sorteo activo.\n\n';

  return {
    texto,
    keyboard: {
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
    }
  };
}

async function showMainMenu(ctx) {
  try {
    const { texto, keyboard } = await buildMainMenu(ctx.from.id, ctx.from.username, ctx.from.first_name);
    await ctx.reply(texto, { parse_mode: 'Markdown', ...keyboard });
  } catch (err) {
    console.error('Error en showMainMenu:', err);
    await ctx.reply('⚠️ Error al cargar el menú. Intenta de nuevo.');
  }
}

async function editToMainMenu(ctx) {
  try { await ctx.answerCbQuery(); } catch(e) {}
  try {
    const { texto, keyboard } = await buildMainMenu(ctx.from.id, ctx.from.username, ctx.from.first_name);
    await ctx.editMessageText(texto, { parse_mode: 'Markdown', ...keyboard });
  } catch(err) {
    console.error('editToMainMenu error:', err);
  }
}

function buildAdminPanel() {
  return {
    texto: '👑 *Panel de Administración*',
    keyboard: {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Solicitudes depósito', callback_data: 'admin_pendientes' }],
          [{ text: '🎲 Jugadas del día', callback_data: 'admin_jugadas_hoy' }],
          [{ text: '📊 Estadísticas', callback_data: 'admin_estadisticas' }],
          [{ text: '⚙️ Límites', callback_data: 'admin_limites' }],
          [{ text: '🕒 Horarios', callback_data: 'admin_horarios' }]
        ]
      }
    }
  };
}

function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

// ================================ COMANDOS ================================
bot.command('start', async (ctx) => {
  try {
    await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    await showMainMenu(ctx);
  } catch (err) {
    console.error('Error en /start:', err);
    await ctx.reply('❌ Error al iniciar. Intenta de nuevo.');
  }
});

bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Saldo actual: $${user.saldo.toFixed(2)}`);
});

bot.command('admin_panel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const { texto, keyboard } = buildAdminPanel();
  await ctx.reply(texto, { parse_mode: 'Markdown', ...keyboard });
});

bot.command('set_limit', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Uso: /set_limit tipo monto\nTipos: fijo, corrido, parle, centena');
  const tipo = args[1].toLowerCase();
  const monto = parseFloat(args[2]);
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');
  const tipos = ['fijo', 'corrido', 'parle', 'centena'];
  if (!tipos.includes(tipo)) return ctx.reply(`Tipo inválido. Permitidos: ${tipos.join(', ')}`);
  const { data: existing } = await supabase.from('limits').select('id')
    .eq('tipo', tipo).is('loteria_id', null).is('sorteo_id', null).maybeSingle();
  if (existing) {
    await supabase.from('limits').update({ monto_maximo: monto, updated_at: new Date() }).eq('id', existing.id);
  } else {
    await supabase.from('limits').insert([{ tipo, monto_maximo: monto, loteria_id: null, sorteo_id: null }]);
  }
  ctx.reply(`✅ Límite para ${tipo} = $${monto.toFixed(2)}`);
});

bot.command('horarios', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const { data: sorteos, error } = await supabase.from('sorteos')
    .select('id, nombre, loterias(nombre), hora_apertura, hora_cierre').order('id');
  if (error || !sorteos?.length) return ctx.reply('No hay sorteos configurados.');
  let msg = 'Horarios de sorteos (hora local Cuba):\n\n';
  for (const s of sorteos) {
    msg += `${s.loterias?.nombre || '?'} - ${s.nombre}\n`;
    msg += `  ${s.hora_apertura?.slice(0,5) || '?'} - ${s.hora_cierre?.slice(0,5) || '?'}\n\n`;
  }
  ctx.reply(msg);
});

bot.command('diagnostico', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const { data: sorteos, error } = await supabase.from('sorteos').select('*');
  if (error) return ctx.reply(`Error: ${error.message}`);
  if (!sorteos?.length) return ctx.reply('No hay sorteos en BD.');
  let msg = 'Diagnóstico de sorteos:\n\n';
  for (const s of sorteos) {
    const horario = s.hora_apertura && s.hora_cierre
      ? `${s.hora_apertura.slice(0,5)} - ${s.hora_cierre.slice(0,5)}`
      : 'Sin horario';
    msg += `ID ${s.id} — ${s.nombre}\n  ${horario} | Lotería: ${s.loteria_id}\n\n`;
  }
  ctx.reply(msg);
});

bot.command('reset', async (ctx) => {
  await supabase.from('user_preferences').delete().eq('telegram_id', ctx.from.id);
  ctx.reply('✅ Configuración borrada. Usa /start para seleccionar un sorteo.');
});

// ================================ CALLBACKS ================================
bot.action('menu_main', async (ctx) => { await editToMainMenu(ctx); });

bot.action('menu_loterias', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const loterias = await getLoterias();
    if (!loterias.length) {
      return ctx.editMessageText('❌ No hay loterías disponibles.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] }
      });
    }
    await ctx.editMessageText('🎰 Selecciona una lotería:', {
      reply_markup: {
        inline_keyboard: [
          ...loterias.map(l => [{ text: l.nombre, callback_data: `sel_lot_${l.id}` }]),
          [{ text: '🔙 Volver', callback_data: 'menu_main' }]
        ]
      }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^sel_lot_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const lotId = parseInt(ctx.match[1]);
    const sorteos = await getSorteos(lotId);
    if (!sorteos.length) {
      return ctx.editMessageText('❌ No hay sorteos disponibles.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_loterias' }]] }
      });
    }
    await ctx.editMessageText('🎲 Selecciona un sorteo:', {
      reply_markup: {
        inline_keyboard: [
          ...sorteos.map(s => [{
            text: `${s.nombre} (${(s.hora_apertura||'--:--').slice(0,5)}-${(s.hora_cierre||'--:--').slice(0,5)})`,
            callback_data: `sel_sor_${s.id}`
          }]),
          [{ text: '🔙 Volver', callback_data: 'menu_loterias' }]
        ]
      }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^sel_sor_(\d+)$/, async (ctx) => {
  try {
    const sorId = parseInt(ctx.match[1]);
    const { data: sorteo, error } = await supabase.from('sorteos')
      .select('*, loterias!inner(nombre)').eq('id', sorId).single();
    if (error) throw error;
    const pref = await getUserPreference(ctx.from.id) || {};
    await saveUserPreference(ctx.from.id, sorteo.loteria_id, sorId, pref.moneda || 'cup');
    await ctx.answerCbQuery(`✅ ${sorteo.nombre} seleccionado`);
    await ctx.editMessageText(
      `✅ Sorteo seleccionado: ${sorteo.loterias.nombre} - ${sorteo.nombre}\n\nYa puedes enviar tu jugada.`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Menú principal', callback_data: 'menu_main' }]] } }
    );
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action('menu_moneda', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText('💵 Selecciona tu moneda:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇨🇺 CUP', callback_data: 'moneda_cup' }],
          [{ text: '💳 MLC', callback_data: 'moneda_mlc' }],
          [{ text: '🇺🇸 USD', callback_data: 'moneda_usd' }],
          [{ text: '🔙 Volver', callback_data: 'menu_main' }]
        ]
      }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^moneda_(cup|mlc|usd)$/, async (ctx) => {
  try {
    const moneda = ctx.match[1];
    const pref = await getUserPreference(ctx.from.id);
    await saveUserPreference(ctx.from.id, pref?.loteria_id || null, pref?.sorteo_id || null, moneda);
    await ctx.answerCbQuery(`${moneda.toUpperCase()} seleccionada ✅`);
    await ctx.editMessageText(`✅ Moneda: ${moneda.toUpperCase()}`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Menú principal', callback_data: 'menu_main' }]] }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action('menu_mis_jugadas', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const pref = await getUserPreference(ctx.from.id);
    if (!pref?.sorteo_id) {
      return ctx.editMessageText('⚠️ Debes seleccionar un sorteo primero.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] }
      });
    }
    const bets = await getUserBets(ctx.from.id, pref.sorteo_id, new Date().toISOString().slice(0,10));
    if (!bets.length) {
      return ctx.editMessageText('📭 No tienes jugadas en el sorteo actual.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] }
      });
    }
    const betsEx = await Promise.all(bets.slice(0,5).map(async b => ({ ...b, editable: await isBetEditable(b) })));
    let msg = '📋 Tus jugadas de hoy:\n\n';
    for (const bet of betsEx) {
      msg += `${bet.editable ? '🟢' : '🔴'} ID: ${bet.id} | $${bet.total_apuesta.toFixed(2)}\n`;
      msg += `${bet.input_raw.substring(0,60)}...\n\n`;
    }
    const rows = betsEx.map(bet => [
      { text: `${bet.editable ? '✏️' : '🔒'} #${bet.id}`, callback_data: `edit_bet_${bet.id}` },
      { text: `${bet.editable ? '❌' : '🔒'} #${bet.id}`, callback_data: `del_bet_${bet.id}` }
    ]);
    rows.push([{ text: '🔙 Menú principal', callback_data: 'menu_main' }]);
    await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: rows } });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^edit_bet_(\d+)$/, async (ctx) => {
  try {
    const betId = parseInt(ctx.match[1]);
    const { data: bet, error } = await supabase.from('bets').select('*').eq('id', betId).single();
    if (error || !bet) { await ctx.answerCbQuery('No encontrada'); return; }
    if (!(await isBetEditable(bet))) { await ctx.answerCbQuery('⏰ Sorteo cerrado'); return; }
    await ctx.answerCbQuery('Jugada cargada');
    await ctx.reply(`✏️ Editar jugada #${betId}\n\nTexto original:\n${bet.input_raw}\n\nEnvíalo modificado como nueva jugada.`);
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^del_bet_(\d+)$/, async (ctx) => {
  try {
    const betId = parseInt(ctx.match[1]);
    const { data: bet, error } = await supabase.from('bets').select('*').eq('id', betId).single();
    if (error || !bet) { await ctx.answerCbQuery('No encontrada'); return; }
    if (!(await isBetEditable(bet))) { await ctx.answerCbQuery('⏰ Sorteo cerrado'); return; }
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `⚠️ ¿Eliminar jugada #${betId}? Monto: $${bet.total_apuesta.toFixed(2)}`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Sí, eliminar', callback_data: `confirm_del_${betId}` }],
        [{ text: '❌ Cancelar', callback_data: 'menu_mis_jugadas' }]
      ]}}
    );
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^confirm_del_(\d+)$/, async (ctx) => {
  try {
    const betId = parseInt(ctx.match[1]);
    const { data: bet, error } = await supabase.from('bets').select('*').eq('id', betId).single();
    if (error || !bet) { await ctx.answerCbQuery('No encontrada'); return; }
    if (!(await isBetEditable(bet))) { await ctx.answerCbQuery('⏰ Sorteo cerrado'); return; }
    await supabase.from('bets').delete().eq('id', betId);
    const { data: user } = await supabase.from('users').select('saldo').eq('telegram_id', bet.user_telegram_id).single();
    if (user) await updateUserSaldo(bet.user_telegram_id, user.saldo + bet.total_apuesta);
    await ctx.answerCbQuery('Eliminada ✅');
    await ctx.editMessageText(
      `✅ Jugada #${betId} eliminada. Se reintegraron $${bet.total_apuesta.toFixed(2)}.`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Menú principal', callback_data: 'menu_main' }]] } }
    );
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action('menu_depositar', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText('💸 Selecciona método de pago:', {
      reply_markup: { inline_keyboard: [
        [{ text: '💳 Tarjeta', callback_data: 'dep_method_tarjeta' }],
        [{ text: '🏦 Transferencia', callback_data: 'dep_method_transferencia' }],
        [{ text: '📱 Monedero', callback_data: 'dep_method_monedero' }],
        [{ text: '🔙 Volver', callback_data: 'menu_main' }]
      ]}
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^dep_method_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const method = ctx.match[1];
    depositStates.set(ctx.from.id, { method, step: 'amount' });
    await ctx.editMessageText(`Método: ${method}\nEscribe el monto a depositar:`);
  } catch (err) { console.error(err); }
});

bot.action('menu_historial', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const { data: bets, error } = await supabase.from('bets').select('*')
      .eq('user_telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(5);
    if (error || !bets?.length) {
      return ctx.editMessageText('📭 No tienes jugadas registradas.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] }
      });
    }
    let msg = 'Tus últimas 5 jugadas:\n\n';
    bets.forEach(b => {
      msg += `$${b.total_apuesta.toFixed(2)} — ${new Date(b.created_at).toLocaleString()}\n`;
      msg += `${b.input_raw.substring(0, 80)}...\n\n`;
    });
    await ctx.editMessageText(msg, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action('menu_ayuda', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const ayuda =
      'Ayuda rápida:\n\n' +
      '1. Selecciona un sorteo desde el menú.\n' +
      '2. Envía tu jugada en formato DSL.\n' +
      '3. Consulta tu saldo con /saldo.\n' +
      '4. Deposita desde el menú.\n' +
      '5. Admins: /admin_panel';
    await ctx.editMessageText(ayuda, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'menu_main' }]] }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

// ================================ ADMIN CALLBACKS ================================
bot.action('admin_panel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  try {
    await ctx.answerCbQuery();
    const { texto, keyboard } = buildAdminPanel();
    await ctx.editMessageText(texto, { parse_mode: 'Markdown', ...keyboard });
  } catch (err) { console.error(err); }
});

bot.action('admin_pendientes', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  try {
    await ctx.answerCbQuery();
    const { data: pendings, error } = await supabase.from('deposit_requests')
      .select('*, users!inner(telegram_id, username, first_name)')
      .eq('status', 'pending').order('created_at');
    if (error || !pendings?.length) {
      return ctx.editMessageText('✅ No hay solicitudes pendientes.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] }
      });
    }
    let msg = 'Solicitudes pendientes:\n\n';
    for (const p of pendings) {
      msg += `#${p.id} | ${p.users.first_name || p.users.username || p.users.telegram_id} | $${p.amount.toFixed(2)} | ${p.payment_method}\n`;
    }
    const rows = pendings.map(p => [
      { text: `✅ Aprobar #${p.id}`, callback_data: `admin_aprob_${p.id}` },
      { text: `❌ Rechazar #${p.id}`, callback_data: `admin_rech_${p.id}` }
    ]);
    rows.push([{ text: '🔙 Volver', callback_data: 'admin_panel' }]);
    await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: rows } });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action(/^admin_aprob_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  const id = parseInt(ctx.match[1]);
  try {
    const { userId, amount, nuevoSaldo } = await approveDeposit(id, ctx.from.id);
    await ctx.answerCbQuery('Aprobado ✅');
    await ctx.editMessageText(
      `✅ Depósito #${id} aprobado.\nUsuario: ${userId}\nMonto: $${amount.toFixed(2)}\nNuevo saldo: $${nuevoSaldo.toFixed(2)}`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } }
    );
    try { await bot.telegram.sendMessage(userId, `✅ Tu depósito de $${amount.toFixed(2)} fue aprobado. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`); } catch(e) {}
  } catch (err) { try { await ctx.answerCbQuery(`Error: ${err.message}`); } catch(e) {} }
});

bot.action(/^admin_rech_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  const id = parseInt(ctx.match[1]);
  try { await ctx.answerCbQuery('Escribe el motivo'); } catch(e) {}
  rejectState.set(ctx.from.id, id);
  await ctx.reply(`Escribe el motivo del rechazo para la solicitud #${id}:`);
});

bot.action('admin_jugadas_hoy', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  try {
    await ctx.answerCbQuery();
    const hoy = new Date().toISOString().slice(0,10);
    const { data: bets, error } = await supabase.from('bets')
      .select('*, users(first_name, username), sorteos(nombre)')
      .eq('fecha_apuesta', hoy).order('created_at', { ascending: false });
    if (error || !bets?.length) {
      return ctx.editMessageText('📭 No hay jugadas hoy.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] }
      });
    }
    let msg = `Jugadas del día ${hoy}:\n\n`;
    let total = 0;
    for (const b of bets.slice(0,10)) {
      total += b.total_apuesta;
      msg += `${b.users?.first_name || b.users?.username || b.user_telegram_id} | ${b.sorteos?.nombre || '?'} | $${b.total_apuesta.toFixed(2)}\n`;
      msg += `${b.input_raw.substring(0,50)}...\n\n`;
    }
    msg += `Total: $${total.toFixed(2)}`;
    await ctx.editMessageText(msg, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action('admin_estadisticas', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  try {
    await ctx.answerCbQuery();
    const hoy = new Date().toISOString().slice(0,10);
    const { data: bets, error } = await supabase.from('bets')
      .select('total_apuesta, user_telegram_id').eq('fecha_apuesta', hoy);
    if (error) return ctx.editMessageText('Error al cargar estadísticas.');
    const total = bets.reduce((s, b) => s + b.total_apuesta, 0);
    const usuarios = new Set(bets.map(b => b.user_telegram_id)).size;
    const topMap = bets.reduce((acc, b) => {
      acc[b.user_telegram_id] = (acc[b.user_telegram_id] || 0) + b.total_apuesta;
      return acc;
    }, {});
    const topUsers = Object.entries(topMap).sort((a,b) => b[1] - a[1]).slice(0,5);
    let topMsg = '';
    for (const [uid, monto] of topUsers) {
      const u = await supabase.from('users').select('first_name, username').eq('telegram_id', uid).single();
      topMsg += `${u.data?.first_name || u.data?.username || uid}: $${monto.toFixed(2)}\n`;
    }
    await ctx.editMessageText(
      `Estadísticas del día ${hoy}\n\nTotal recogido: $${total.toFixed(2)}\nUsuarios activos: ${usuarios}\n\nTop 5:\n${topMsg || 'Sin datos'}`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] } }
    );
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action('admin_limites', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  try {
    await ctx.answerCbQuery();
    const { data: limites, error } = await supabase.from('limits').select('*')
      .is('loteria_id', null).is('sorteo_id', null);
    if (error) return ctx.editMessageText('Error al cargar límites.');
    let msg = 'Límites globales:\n\n';
    if (limites?.length) {
      for (const l of limites) msg += `${l.tipo}: $${l.monto_maximo.toFixed(2)}\n`;
    } else {
      msg += 'No hay límites configurados.\n';
    }
    msg += '\nUso: /set_limit tipo monto\nTipos: fijo, corrido, parle, centena';
    await ctx.editMessageText(msg, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

bot.action('admin_horarios', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { try { await ctx.answerCbQuery('⛔'); } catch(e) {} return; }
  try {
    await ctx.answerCbQuery();
    const { data: sorteos, error } = await supabase.from('sorteos')
      .select('id, nombre, loterias(nombre), hora_apertura, hora_cierre, activo').order('id');
    if (error || !sorteos?.length) {
      return ctx.editMessageText('No hay sorteos configurados.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] }
      });
    }
    let msg = 'Horarios de sorteos (hora local Cuba):\n\n';
    for (const s of sorteos) {
      const abre = s.hora_apertura?.slice(0,5) || 'sin hora';
      const cierra = s.hora_cierre?.slice(0,5) || 'sin hora';
      msg += `${s.loterias?.nombre || '?'} - ${s.nombre}\n`;
      msg += `  ${abre} - ${cierra} | ${s.activo ? '🟢' : '🔴'}\n\n`;
    }
    await ctx.editMessageText(msg, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Volver', callback_data: 'admin_panel' }]] }
    });
  } catch (err) { console.error(err); try { await ctx.answerCbQuery('Error'); } catch(e) {} }
});

// ================================ TEXTO / FOTOS ================================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;

  // Motivo de rechazo
  if (rejectState.has(userId)) {
    const id = rejectState.get(userId);
    rejectState.delete(userId);
    try {
      await rejectDeposit(id, userId, ctx.message.text);
      const { data: req } = await supabase.from('deposit_requests')
        .select('user_telegram_id').eq('id', id).single();
      if (req) {
        try { await bot.telegram.sendMessage(req.user_telegram_id, `❌ Tu depósito fue rechazado.\nMotivo: ${ctx.message.text}`); } catch(e) {}
      }
      await ctx.reply(`✅ Depósito #${id} rechazado.`);
    } catch (err) { await ctx.reply(`❌ Error: ${err.message}`); }
    return;
  }

  // Flujo de depósito
  const state = depositStates.get(userId);
  if (state && state.step === 'amount') {
    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Monto inválido. Escribe un número mayor a 0.');
      return;
    }
    state.amount = amount;
    state.step = 'proof';
    depositStates.set(userId, state);
    await ctx.reply(`Monto: $${amount.toFixed(2)}\nAhora envía una imagen como comprobante.`);
    return;
  }

  // Jugada
  await processBet(ctx, ctx.message.text);
});

bot.on(['photo', 'document'], async (ctx) => {
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  if (!state || state.step !== 'proof') {
    return ctx.reply('No estás en proceso de depósito. Usa /start.');
  }
  let fileId;
  if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  else if (ctx.message.document) fileId = ctx.message.document.file_id;
  else return ctx.reply('Envía una imagen o documento.');
  try {
    const deposit = await createDepositRequest(userId, state.amount, state.method, fileId);
    depositStates.delete(userId);
    await ctx.reply(`✅ Solicitud creada.\nID: ${deposit.id}\nMonto: $${deposit.amount}\nMétodo: ${deposit.payment_method}\nEl administrador revisará pronto.`);
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(adminId,
          `📥 Nueva solicitud #${deposit.id}\nUsuario: ${userId}\nMonto: $${deposit.amount}\nMétodo: ${deposit.payment_method}`
        );
      } catch(e) {}
    }
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Error al guardar la solicitud. Intenta de nuevo.');
  }
});

// ================================ PROCESAR APUESTA ================================
async function processBet(ctx, rawInput) {
  if (!rawInput.trim() || rawInput.startsWith('/')) return;
  const pref = await getUserPreference(ctx.from.id);
  if (!pref || !pref.loteria_id || !pref.sorteo_id) {
    return ctx.reply('⚠️ Primero selecciona un sorteo usando /start.');
  }
  const moneda = pref.moneda || 'cup';
  const horario = await validarHorarioSorteo(pref.sorteo_id);
  if (!horario.open) return ctx.reply(horario.message);
  console.log(`📥 Apuesta de ${ctx.from.id}: ${rawInput.substring(0,200)}`);
  let processed = rawInput.toLowerCase();
  processed = preprocesarLineasMixtas(processed);
  console.log('📥 Texto ENVIADO al motor:\n', processed);
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
  (resultado.jugadas || []).forEach(j => (j.jugadas_detalle || []).forEach(d => allDetails.push(d)));
  const limites = await getLimitesGlobales(pref.loteria_id, pref.sorteo_id);
  const fechaHoy = new Date().toISOString().slice(0,10);
  const violacion = await validarLimitesAcumulativos(allDetails, pref.loteria_id, pref.sorteo_id, fechaHoy, limites);
  if (violacion) {
    return ctx.reply(
      `❌ Límite excedido para tipo ${violacion.tipo}.\n` +
      `Número ${violacion.numero} acumula $${violacion.acumPrev.toFixed(2)} de $${violacion.limite.toFixed(2)}.\n` +
      `Esta apuesta añade $${violacion.montoActual.toFixed(2)}.`
    );
  }
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(`❌ Saldo insuficiente.\nNecesitas $${totalApuesta.toFixed(2)} (${moneda.toUpperCase()}).\nUsa el menú para depositar.`);
  }
  const saldoAntes = user.saldo;
  const saldoDespues = saldoAntes - totalApuesta;
  await updateUserSaldo(ctx.from.id, saldoDespues);
  await saveBet(ctx.from.id, pref.loteria_id, pref.sorteo_id, fechaHoy, rawInput, totalApuesta, JSON.stringify(allDetails), saldoAntes, saldoDespues, moneda);
  let respuesta = `✅ Jugada registrada.\nTotal: $${totalApuesta.toFixed(2)} (${moneda.toUpperCase()})\nSaldo restante: $${saldoDespues.toFixed(2)}\n\n`;
  if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
  if (resultado.flaggedWarnings?.length) {
    respuesta += '\n⚠️ Revisiones:\n' + resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
  }
  await ctx.reply(respuesta);
}

// ================================ SERVIDOR ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook en POST ${webhookPath}`);
  console.log(`👑 Admins: ${ADMIN_IDS.join(', ') || 'Ninguno'}`);
});
