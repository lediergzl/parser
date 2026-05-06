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
// 3. Funciones auxiliares (limpiarMonto, expansiones, etc.)
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
// 4. Helpers de base de datos
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
    console.log(`🆕 Nuevo usuario: ${telegramId} (${firstName || username})`);
  }
  return user;
}

async function updateUserSaldo(telegramId, nuevoSaldo) {
  await supabase
    .from('users')
    .update({ saldo: nuevoSaldo, updated_at: new Date() })
    .eq('telegram_id', telegramId);
}

async function saveBet(userTelegramId, loteriaId, sorteoId, fecha, inputRaw, totalApuesta, detalle, saldoAntes, saldoDespues) {
  await supabase.from('bets').insert([{
    user_telegram_id: userTelegramId,
    loteria_id: loteriaId,
    sorteo_id: sorteoId,
    fecha_apuesta: fecha,
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
  const { data: req, error: fetchError } = await supabase
    .from('deposit_requests')
    .select('*')
    .eq('id', requestId)
    .single();
  if (fetchError || !req) throw new Error('Solicitud no encontrada');
  const { error: updateError } = await supabase
    .from('deposit_requests')
    .update({ status: 'approved', admin_notes: `Aprobado por ${adminId}`, updated_at: new Date() })
    .eq('id', requestId);
  if (updateError) throw updateError;
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

// ============================================================
// 5. Funciones para límites, horarios y ganadores
// ============================================================
async function getHorario(loteriaId, sorteoId) {
  const { data, error } = await supabase
    .from('sorteo_hours')
    .select('*')
    .eq('loteria_id', loteriaId)
    .eq('sorteo_id', sorteoId)
    .single();
  if (error) return null;
  return data;
}

async function validarLimites(tipoMontoMap, loteriaId, sorteoId) {
  let query = supabase.from('limits').select('*');
  if (loteriaId && sorteoId) {
    query = query.or(`loteria_id.eq.${loteriaId},loteria_id.is.null`)
                 .or(`sorteo_id.eq.${sorteoId},sorteo_id.is.null`);
  } else {
    query = query.is('loteria_id', null).is('sorteo_id', null);
  }
  const { data: limites } = await query;
  if (!limites) return null;
  for (const [tipo, monto] of Object.entries(tipoMontoMap)) {
    const limite = limites.find(l => l.tipo === tipo);
    if (limite && monto > limite.monto_maximo) {
      return { tipo, monto, maximo: limite.monto_maximo };
    }
  }
  return null;
}

// Función que calcula el premio para una apuesta dado el número ganador
// Basado en la lógica del APK (fijo, corrido, centena, parle, candado)
function calcularPremioParaApuesta(bet, numeroGanador, pagosConfig) {
  try {
    // Parsear detalles de la apuesta (están en JSON en bet.detalle)
    // Por simplicidad, asumimos que bet.detalle es un array o string JSON.
    // En el APK real, se guarda el detalle estructurado. Aquí haremos una versión simplificada.
    // Para producción, deberías guardar los detalles en un campo JSONB en la tabla bets.
    const detalles = typeof bet.detalle === 'string' ? JSON.parse(bet.detalle) : bet.detalle;
    if (!detalles || !detalles.length) return 0;

    // Extraer los números del número ganador (centena, decenas, terminales, pares)
    const num = numeroGanador.toString().replace(/\s/g, '');
    const centena = num.length >= 3 ? num.slice(0, 3) : num.padStart(3, '0').slice(0, 3);
    const fijo = centena.slice(-2);
    const decena1 = num.length >= 5 ? num.slice(3, 5) : null;
    const decena2 = num.length >= 7 ? num.slice(5, 7) : null;
    const paresGanadores = [];
    if (fijo && decena1) paresGanadores.push(fijo + decena1, decena1 + fijo);
    if (fijo && decena2) paresGanadores.push(fijo + decena2, decena2 + fijo);
    if (decena1 && decena2) paresGanadores.push(decena1 + decena2, decena2 + decena1);

    let premioTotal = 0;

    for (const det of detalles) {
      const tipo = det.tipo;
      const numeros = det.numeros || [];
      const montoUnitario = det.monto_unitario || (det.monto / (numeros.length || 1));
      const multiplicador = pagosConfig[tipo] || (tipo === 'fijo' ? 80 : tipo === 'corrido' ? 40 : tipo === 'centena' ? 500 : tipo === 'parle' ? 500 : 0);
      let aciertos = 0;

      if (tipo === 'fijo') {
        aciertos = numeros.filter(n => n === fijo).length;
      } else if (tipo === 'corrido') {
        if (decena1) aciertos += numeros.filter(n => n === decena1).length;
        if (decena2) aciertos += numeros.filter(n => n === decena2).length;
      } else if (tipo === 'centena') {
        aciertos = numeros.filter(n => n === centena).length;
      } else if (tipo === 'parle' || tipo === 'candado') {
        const combinaciones = det.combinaciones || det.pares || [];
        aciertos = combinaciones.filter(c => paresGanadores.includes(c)).length;
      }
      if (aciertos > 0) {
        premioTotal += aciertos * montoUnitario * multiplicador;
      }
    }
    return premioTotal;
  } catch (e) {
    console.error('Error calculando premio:', e);
    return 0;
  }
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

app.use((req, res, next) => { console.log(`📨 [${req.method}] ${req.path}`); next(); });
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot completo'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => { bot.webhookCallback(webhookPath)(req, res); });

// ============================================================
// 7. Comandos públicos
// ============================================================
bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(
    `✅ Bienvenido ${ctx.from.first_name || 'usuario'}.\n` +
    `💰 Saldo actual: $${user.saldo.toFixed(2)}\n\n` +
    `Comandos:\n` +
    `/saldo - ver saldo\n` +
    `/depositar - solicitar recarga\n` +
    `/mis_depositos - estado de solicitudes\n` +
    `/historial - últimas 5 jugadas\n\n` +
    `Ejemplo de jugada:\n` +
    `Juana\nd2 con 50 y 20 candado con 2300\nparejas d2 t3 4 5 parle con 5`
  );
});

bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Saldo actual: $${user.saldo.toFixed(2)}`);
});

bot.command('depositar', async (ctx) => {
  if (depositStates.has(ctx.from.id)) depositStates.delete(ctx.from.id);
  depositStates.set(ctx.from.id, { step: 'method' });
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💳 Tarjeta', callback_data: 'dep_method_tarjeta' }],
        [{ text: '🏦 Transferencia', callback_data: 'dep_method_transferencia' }],
        [{ text: '📱 Monedero', callback_data: 'dep_method_monedero' }]
      ]
    }
  };
  await ctx.reply('Selecciona método de pago:', keyboard);
});

bot.command('mis_depositos', async (ctx) => {
  const { data: requests, error } = await supabase
    .from('deposit_requests')
    .select('*')
    .eq('user_telegram_id', ctx.from.id)
    .order('created_at', { ascending: false });
  if (error || !requests.length) return ctx.reply('No hay solicitudes.');
  let msg = '📋 *Tus solicitudes de depósito:*\n\n';
  for (const r of requests) {
    const statusEmoji = r.status === 'pending' ? '⏳' : (r.status === 'approved' ? '✅' : '❌');
    msg += `${statusEmoji} *${r.status.toUpperCase()}* - $${r.amount.toFixed(2)} (${r.payment_method})\n`;
    msg += `ID: ${r.id} - ${new Date(r.created_at).toLocaleString()}\n`;
    if (r.admin_notes) msg += `Nota: ${r.admin_notes}\n\n`;
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
  if (error || !bets || !bets.length) return ctx.reply('No hay jugadas.');
  let msg = '📜 *Últimas 5 jugadas:*\n\n';
  bets.forEach(b => {
    msg += `💰 $${b.total_apuesta.toFixed(2)} - ${new Date(b.created_at).toLocaleString()}\n`;
    msg += `📝 ${b.detalle?.substring(0, 150)}…\n\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ============================================================
// 8. Comandos de administrador
// ============================================================
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

bot.command('aprobar', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Uso: /aprobar <id_solicitud>');
  const id = parseInt(args[1]);
  if (isNaN(id)) return ctx.reply('ID inválido.');
  try {
    const { userId, amount, nuevoSaldo } = await approveDeposit(id, ctx.from.id);
    await ctx.reply(`✅ Depósito aprobado. $${amount.toFixed(2)} a usuario ${userId}. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
    try {
      await bot.telegram.sendMessage(userId, `✅ Tu depósito de $${amount.toFixed(2)} fue aprobado. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
    } catch (e) {}
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
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
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('pendientes', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Solo administradores.');
  try {
    const pendings = await getPendingDeposits();
    if (!pendings.length) return ctx.reply('No hay solicitudes pendientes.');
    let msg = '📋 *Solicitudes pendientes:*\n\n';
    for (const p of pendings) {
      msg += `ID: ${p.id}\nUsuario: ${p.users.first_name || p.users.username || p.users.telegram_id} (${p.users.telegram_id})\nMonto: $${p.amount.toFixed(2)}\nMétodo: ${p.payment_method}\nComprobante: <a href="https://t.me/file/${p.proof_file_id}">Ver</a>\nFecha: ${new Date(p.created_at).toLocaleString()}\n\nAprobar: /aprobar ${p.id}\nRechazar: /rechazar ${p.id}\n\n`;
    }
    ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('set_limit', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Uso: /set_limit <tipo> <monto_maximo>');
  const tipo = args[1].toLowerCase();
  const monto = parseFloat(args[2]);
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido');
  const { error } = await supabase.from('limits').upsert({
    tipo, monto_maximo: monto, loteria_id: null, sorteo_id: null,
    updated_at: new Date()
  }, { onConflict: 'tipo,loteria_id,sorteo_id' });
  if (error) return ctx.reply(`Error: ${error.message}`);
  ctx.reply(`✅ Límite para ${tipo} establecido en $${monto.toFixed(2)} (global)`);
});

bot.command('set_horario', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 5) return ctx.reply('Uso: /set_horario <loteria_id> <sorteo_id> <apertura> <cierre> (HH:MM)');
  const lot_id = parseInt(args[1]);
  const sor_id = parseInt(args[2]);
  const apertura = args[3];
  const cierre = args[4];
  if (!/^\d{2}:\d{2}$/.test(apertura) || !/^\d{2}:\d{2}$/.test(cierre))
    return ctx.reply('Formato de hora inválido (HH:MM)');
  const { error } = await supabase.from('sorteo_hours').upsert({
    loteria_id: lot_id, sorteo_id: sor_id, apertura, cierre,
    updated_at: new Date()
  }, { onConflict: 'loteria_id,sorteo_id' });
  if (error) return ctx.reply(`Error: ${error.message}`);
  ctx.reply(`✅ Horario configurado: lotería ${lot_id} sorteo ${sor_id} apertura ${apertura} cierre ${cierre}`);
});

bot.command('set_resultado', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 6) return ctx.reply('Uso: /set_resultado <loteria_id> <sorteo_id> <fecha> <numero>');
  const lot_id = parseInt(args[1]);
  const sor_id = parseInt(args[2]);
  const fecha = args[3];
  const numero = args[4];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return ctx.reply('Fecha inválida (YYYY-MM-DD)');
  const { error } = await supabase.from('resultados').insert({
    loteria_id: lot_id, sorteo_id: sor_id, fecha, numero_ganador: numero, procesado: false
  });
  if (error) return ctx.reply(`Error: ${error.message}`);
  ctx.reply(`✅ Resultado guardado. Luego ejecuta /procesar_ganadores ${fecha} ${lot_id} ${sor_id} para pagar.`);
});

bot.command('procesar_ganadores', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 4) return ctx.reply('Uso: /procesar_ganadores <fecha> <loteria_id> <sorteo_id>');
  const fecha = args[1];
  const lot_id = parseInt(args[2]);
  const sor_id = parseInt(args[3]);

  // Obtener resultado
  const { data: resultado, error: resErr } = await supabase
    .from('resultados')
    .select('*')
    .eq('loteria_id', lot_id)
    .eq('sorteo_id', sor_id)
    .eq('fecha', fecha)
    .single();
  if (resErr || !resultado) return ctx.reply('No se encontró el resultado. Usa /set_resultado primero.');
  if (resultado.procesado) return ctx.reply('Este resultado ya fue procesado.');

  // Obtener apuestas del sorteo
  const { data: apuestas, error: betErr } = await supabase
    .from('bets')
    .select('*')
    .eq('loteria_id', lot_id)
    .eq('sorteo_id', sor_id)
    .eq('fecha_apuesta', fecha);
  if (betErr) return ctx.reply(`Error al obtener apuestas: ${betErr.message}`);

  // Obtener configuración de pagos (multiplicadores)
  // Puedes cargar desde configuración o usar valores por defecto
  const pagos = { fijo: 80, corrido: 40, centena: 500, parle: 500, candado: 500 };

  let totalPremios = 0;
  let ganadores = [];

  for (const bet of apuestas) {
    const premio = calcularPremioParaApuesta(bet, resultado.numero_ganador, pagos);
    if (premio > 0) {
      const { data: user, error: userErr } = await supabase
        .from('users')
        .select('saldo')
        .eq('telegram_id', bet.user_telegram_id)
        .single();
      if (!userErr) {
        const nuevoSaldo = user.saldo + premio;
        await updateUserSaldo(bet.user_telegram_id, nuevoSaldo);
        totalPremios += premio;
        ganadores.push({ user: bet.user_telegram_id, premio });
        // Notificar al usuario
        try {
          await bot.telegram.sendMessage(bet.user_telegram_id, `🎉 ¡Felicidades! Ganaste $${premio.toFixed(2)} con tu apuesta del ${fecha}. Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
        } catch(e) {}
      }
    }
  }

  // Marcar resultado como procesado
  await supabase.from('resultados').update({ procesado: true }).eq('id', resultado.id);

  ctx.reply(`✅ Procesamiento completado.\nNúmero ganador: ${resultado.numero_ganador}\nTotal pagado: $${totalPremios.toFixed(2)}\nGanadores: ${ganadores.length}`);
});

// ============================================================
// 9. Estados para depósitos
// ============================================================
const depositStates = new Map();

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

// ============================================================
// 10. Manejo de texto (flujo de depósito y apuestas)
// ============================================================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  if (state && state.step === 'amount') {
    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Monto inválido, escribe un número positivo.');
    }
    state.amount = amount;
    state.step = 'proof';
    depositStates.set(userId, state);
    await ctx.reply(`Monto: $${amount.toFixed(2)}\nAhora envía una imagen o documento como comprobante.`);
    return;
  }
  // Si no hay estado activo, procesar apuesta
  await processBet(ctx, ctx.message.text);
});

bot.on(['photo', 'document'], async (ctx) => {
  const userId = ctx.from.id;
  const state = depositStates.get(userId);
  if (!state || state.step !== 'proof') {
    return ctx.reply('No estás en proceso de depósito. Usa /depositar.');
  }
  let fileId;
  if (ctx.message.photo) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  } else if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
  } else {
    return ctx.reply('Envía una imagen o documento.');
  }
  try {
    const deposit = await createDepositRequest(userId, state.amount, state.method, fileId);
    depositStates.delete(userId);
    await ctx.reply(`✅ Solicitud creada.\nID: ${deposit.id}\nMonto: $${deposit.amount}\nMétodo: ${deposit.payment_method}\nEl administrador revisará y aprobará.`);
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(adminId, `📥 Nueva solicitud #${deposit.id}\nUsuario: ${userId}\nMonto: $${deposit.amount}`);
      } catch(e) {}
    }
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Error al guardar la solicitud.');
  }
});

// ============================================================
// 11. Función principal de apuesta (con validaciones)
// ============================================================
async function processBet(ctx, rawInput) {
  if (!rawInput.trim()) return;
  if (rawInput.startsWith('/')) return;

  console.log(`📥 Apuesta de ${ctx.from.id}: ${rawInput.substring(0, 200)}`);

  // Preprocesar
  let processed = rawInput.toLowerCase();
  processed = preprocesarLineasMixtas(processed);

  let resultado;
  try {
    resultado = Engine.calcular(
      { rawInput: processed, loteriaId: 1, sorteoId: 1 },
      { limpiarMonto, Expansion: global.Expansion, preprocesarJugada: Preprocesador.preprocesarJugada }
    );
  } catch (err) {
    console.error(err);
    return ctx.reply(`❌ Error interno: ${err.message}`);
  }

  if (!resultado.ok) {
    const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
    return ctx.reply(`❌ Error: ${errorMsg}`);
  }

  const totalApuesta = resultado.totalGeneral;
  if (totalApuesta === 0) return ctx.reply('❌ La jugada no tiene monto válido.');

  // Verificar horario del sorteo (asumiendo loteriaId=1, sorteoId=1)
  const hoy = new Date().toISOString().slice(0,10);
  const ahora = new Date();
  const horaActual = ahora.getHours().toString().padStart(2,'0') + ':' + ahora.getMinutes().toString().padStart(2,'0');
  const horario = await getHorario(1, 1);
  if (horario) {
    if (horaActual < horario.apertura) return ctx.reply(`⏰ El sorteo abre a las ${horario.apertura}. Vuelve más tarde.`);
    if (horaActual >= horario.cierre) return ctx.reply(`⏰ El sorteo cerró a las ${horario.cierre}.`);
  }

  // Extraer tipos y montos para validar límites
  const tipoMontoMap = {};
  (resultado.jugadas || []).forEach(j => {
    (j.jugadas_detalle || []).forEach(d => {
      const tipo = d.tipo;
      const monto = d.monto;
      if (!tipoMontoMap[tipo]) tipoMontoMap[tipo] = 0;
      tipoMontoMap[tipo] += monto;
    });
  });
  const limiteExcedido = await validarLimites(tipoMontoMap, 1, 1);
  if (limiteExcedido) {
    return ctx.reply(`❌ Límite excedido para tipo "${limiteExcedido.tipo}". Máximo: $${limiteExcedido.maximo.toFixed(2)}. Apostaste: $${limiteExcedido.monto.toFixed(2)}.`);
  }

  // Verificar saldo
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(`❌ Saldo insuficiente. Necesitas $${totalApuesta.toFixed(2)}. Usa /depositar.`);
  }

  // Deducir saldo y guardar apuesta
  const saldoAntes = user.saldo;
  const saldoDespues = saldoAntes - totalApuesta;
  await updateUserSaldo(ctx.from.id, saldoDespues);
  await saveBet(ctx.from.id, 1, 1, hoy, rawInput, totalApuesta, JSON.stringify(resultado.jugadas_detalle || []), saldoAntes, saldoDespues);

  // Formatear respuesta
  let respuesta = `💰 *Total apostado:* $${totalApuesta.toFixed(2)}\n💰 *Saldo restante:* $${saldoDespues.toFixed(2)}\n\n`;
  if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
  if (resultado.flaggedWarnings?.length) {
    respuesta += '\n⚠️ Revisiones pendientes:\n' + resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
  }
  respuesta += `\n✅ *Jugada registrada.*`;
  await ctx.reply(respuesta, { parse_mode: 'Markdown' });
}

// ============================================================
// 12. Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`✅ Webhook: ${webhookPath}`);
  console.log(`👑 Admins: ${ADMIN_IDS.join(', ') || 'Ninguno'}`);
});
