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
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error) {
    console.error('getOrCreateUser SELECT error:', error);
    throw error;
  }

  if (user) {
    return user;
  }

  const { data: newUser, error: insertError } = await supabase
    .from('users')
    .insert([{
      telegram_id: telegramId,
      username: username || null,
      first_name: firstName || null,
      saldo: 0
    }])
    .select('*')
    .single();

  if (insertError) {
    console.error('getOrCreateUser INSERT error:', insertError);
    throw insertError;
  }

  if (!newUser) {
    throw new Error('Supabase no devolvió el usuario después de crearlo');
  }

  return newUser;
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

  if (!user) {
    throw new Error(`No se pudo obtener/crear el usuario Telegram ${userId}`);
  }

  let pref = await getUserPreference(userId);
  let texto = '🏠 *Menú Principal*\n\n';
  const saldo = Number(user.saldo) || 0;
  texto += `💰 *Saldo:* $${saldo.toFixed(2)}\n`;

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
  try {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    const saldo = Number(user?.saldo) || 0;
    await ctx.reply(`💰 Saldo actual: $${saldo.toFixed(2)}`);
  } catch (err) {
    console.error('Error en /saldo:', err);
    await ctx.reply('❌ No se pudo consultar el saldo. Intenta de nuevo.');
  }
});