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
// 2. Cargar el bundle
// ============================================================
require('./lotopro-core.bundle.js');
const { Engine, Preprocesador } = global;

// ============================================================
// 3. Definir limpiarMonto manualmente
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
// 4. Preprocesamiento adicional para líneas mixtas
//    Convierte "d2 con 50 y 20 candado con 2300" en:
//      d2 con 50
//      d2 corrido con 20
//      d2 candado con 2300
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
// 5. Helpers de base de datos (usuarios y apuestas)
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

// ============================================================
// 6. Verificar dependencias
// ============================================================
if (!Engine || !Preprocesador) {
  console.error('❌ Motor no cargado');
  process.exit(1);
}
console.log('✅ Motor listo');

// ============================================================
// 7. Configurar bot y Express
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Token no definido');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.path}`);
  next();
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot con saldo'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

// Comandos
bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(
    `✅ Bienvenido ${ctx.from.first_name || 'usuario'}.\n` +
    `💰 Tu saldo actual es: $${user.saldo.toFixed(2)}\n\n` +
    `Envía una jugada en formato DSL para apostar.\n` +
    `Usa /deposito <monto> para recargar (solo pruebas).\n` +
    `Usa /saldo para consultar tu saldo.\n` +
    `Usa /historial para ver tus últimas jugadas.`
  );
});

bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Tu saldo actual es: $${user.saldo.toFixed(2)}`);
});

bot.command('deposito', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('❌ Uso: /deposito <monto> (ej: /deposito 100)');
  const monto = parseFloat(args[1]);
  if (isNaN(monto) || monto <= 0) return ctx.reply('❌ Monto inválido.');
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const nuevoSaldo = user.saldo + monto;
  await updateUserSaldo(ctx.from.id, nuevoSaldo);
  ctx.reply(`✅ Se acreditaron $${monto.toFixed(2)}.\n💰 Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
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
    msg += `💰 *Monto:* $${b.total_apuesta.toFixed(2)}\n`;
    msg += `📅 *Fecha:* ${new Date(b.created_at).toLocaleString()}\n`;
    msg += `📝 *Detalle:*\n${b.detalle?.substring(0, 200) || ''}${b.detalle?.length > 200 ? '…' : ''}\n\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.help((ctx) => ctx.reply(
  'Ejemplo de jugada:\n`Juana\nd2 con 50 y 20 candado con 2300\nparejas d2 t3 4 5 parle con 5`\n\n' +
  'Comandos:\n/saldo - ver saldo\n/deposito <monto> - recargar (modo pruebas)\n/historial - últimas 5 jugadas',
  { parse_mode: 'Markdown' }
));

// ============================================================
// 8. Procesamiento principal (con validación de saldo)
// ============================================================
bot.on('text', async (ctx) => {
  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;
  if (rawInput.startsWith('/')) return; // ignorar comandos

  console.log(`📥 Entrada original:\n${rawInput}`);

  rawInput = rawInput.toLowerCase();
  rawInput = preprocesarLineasMixtas(rawInput);
  console.log(`📥 Después de expansión mixta:\n${rawInput}`);

  let resultado;
  try {
    resultado = Engine.calcular(
      { rawInput, loteriaId: 1, sorteoId: 1 },
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

  // Obtener usuario y verificar saldo
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(
      `❌ Saldo insuficiente.\n` +
      `💰 Necesitas: $${totalApuesta.toFixed(2)}\n` +
      `💰 Tu saldo actual: $${user.saldo.toFixed(2)}\n` +
      `Usa /deposito para recargar.`
    );
  }

  // Deducir saldo y guardar jugada
  const saldoAntes = user.saldo;
  const saldoDespues = saldoAntes - totalApuesta;
  await updateUserSaldo(ctx.from.id, saldoDespues);
  await saveBet(ctx.from.id, rawInput, totalApuesta, resultado.detalleTexto || '', saldoAntes, saldoDespues);

  // Construir respuesta
  let respuesta = `💰 *Total apostado:* $${totalApuesta.toFixed(2)}\n`;
  respuesta += `💰 *Saldo restante:* $${saldoDespues.toFixed(2)}\n\n`;
  if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
  if (resultado.flaggedWarnings?.length) {
    respuesta += '\n⚠️ Revisiones pendientes:\n';
    respuesta += resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
  }
  respuesta += `\n✅ *Jugada registrada correctamente.*`;

  await ctx.reply(respuesta, { parse_mode: 'Markdown' });
});

// ============================================================
// 9. Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`✅ Webhook en ${webhookPath}`);
});
