const express = require('express');
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');

// ============================================================
// 1. Conexión a MongoDB
// ============================================================
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI no definida en variables de entorno');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Conectado a MongoDB'))
  .catch(err => {
    console.error('❌ Error conectando a MongoDB:', err.message);
    process.exit(1);
  });

// ============================================================
// 2. Definir modelos
// ============================================================
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  saldo: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const betSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  telegramId: { type: Number, required: true },
  inputRaw: { type: String, required: true },
  totalApuesta: { type: Number, required: true },
  detalle: { type: String, default: '' },
  saldoAntes: { type: Number, required: true },
  saldoDespues: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Bet = mongoose.model('Bet', betSchema);

// ============================================================
// 3. Cargar el motor DSL (bundle)
// ============================================================
require('./lotopro-core.bundle.js');
const { Engine, Preprocesador } = global;

// ============================================================
// 4. Funciones de limpieza y normalización (igual que antes)
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

function stripWhatsAppMeta(line) {
  if (!line) return '';
  let cleaned = line.trim();
  cleaned = cleaned.replace(/^\[\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\]\s*[^:]+:\s*/i, '');
  cleaned = cleaned.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\s*-\s*[^:]+:\s*/i, '');
  cleaned = cleaned.replace(/^\+?\d[\d\s]{6,}:\s*/, '');
  return cleaned.trim();
}

function expandirDecenasTerminales(texto) {
  let resultado = texto;
  resultado = resultado.replace(/\b[Dd](\d)\b/g, (match, digito) => {
    const decena = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) nums.push(String(decena * 10 + i).padStart(2, '0'));
    return nums.join(' ');
  });
  resultado = resultado.replace(/\b[Tt](\d)\b/g, (match, digito) => {
    const terminal = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) nums.push(String(i * 10 + terminal).padStart(2, '0'));
    return nums.join(' ');
  });
  return resultado;
}

function normalizarSintaxis(texto) {
  let lines = texto.split('\n');
  let nuevas = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    line = line.replace(/(\d+)\s*\*\s*(\d+)/g, '$1x$2');
    const matchConY = line.match(/^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)$/i);
    if (matchConY) {
      const nums = matchConY[1];
      const monto1 = matchConY[2];
      const monto2 = matchConY[3];
      nuevas.push(`${nums} con ${monto1}`);
      nuevas.push(`${nums} corrido con ${monto2}`);
      continue;
    }
    if (line.toLowerCase() === 'parle' && i + 1 < lines.length) {
      let nextLine = lines[i + 1].trim();
      if (nextLine) {
        nuevas.push(`parle ${nextLine}`);
        i++;
        continue;
      }
    }
    line = line.replace(/\bparle\s+(\d+)/gi, 'parle con $1');
    if (/\bparejas?\s+con\s+\d+/i.test(line)) {
      const montoMatch = line.match(/\bparejas?\s+con\s+(\d+)/i);
      if (montoMatch) {
        const monto = montoMatch[1];
        const pares = [];
        for (let i = 0; i <= 9; i++) pares.push(String(i).repeat(2).padStart(2, '0'));
        nuevas.push(`${pares.join(' ')} parle con ${monto}`);
        continue;
      }
    }
    nuevas.push(line);
  }
  return nuevas.join('\n');
}

function reconstruirBloquesConNombres(texto) {
  const lines = texto.split('\n');
  let resultado = [];
  let nombreActual = null;
  let acumulador = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (acumulador.length) {
        if (nombreActual) resultado.unshift(nombreActual);
        resultado.push(...acumulador);
        resultado.push('');
        nombreActual = null;
        acumulador = [];
      }
      continue;
    }
    const esNombre = /^[a-zA-ZáéíóúñÁÉÍÓÚÑ\s]+$/.test(line) && !/\d/.test(line) && !/^(con|parle|candado|total|fijo|corrido|centena|parejas|terminal|decena|new|york|por|tarjeta)$/i.test(line);
    if (esNombre && nombreActual === null && acumulador.length === 0) {
      nombreActual = line;
      continue;
    }
    acumulador.push(line);
  }
  if (acumulador.length) {
    if (nombreActual) resultado.unshift(nombreActual);
    resultado.push(...acumulador);
  }
  return resultado.join('\n');
}

// ============================================================
// 5. Helper: obtener o registrar usuario
// ============================================================
async function getOrCreateUser(telegramId, username, firstName) {
  let user = await User.findOne({ telegramId });
  if (!user) {
    user = new User({
      telegramId,
      username: username || '',
      firstName: firstName || '',
      saldo: 0
    });
    await user.save();
    console.log(`🆕 Nuevo usuario registrado: ${telegramId} (${firstName || username})`);
  }
  return user;
}

// ============================================================
// 6. Configuración del bot y Express
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN no definido');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.path}`);
  next();
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot activo'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

// ============================================================
// 7. Comandos del bot
// ============================================================
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
  if (args.length < 2) {
    return ctx.reply('❌ Uso: /deposito <monto> (ej: /deposito 100)');
  }
  const monto = parseFloat(args[1]);
  if (isNaN(monto) || monto <= 0) {
    return ctx.reply('❌ Monto inválido. Debe ser un número positivo.');
  }
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  user.saldo += monto;
  user.updatedAt = new Date();
  await user.save();
  ctx.reply(`✅ Se acreditaron $${monto.toFixed(2)} a tu cuenta.\n💰 Nuevo saldo: $${user.saldo.toFixed(2)}`);
});

bot.command('historial', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const bets = await Bet.find({ telegramId: ctx.from.id }).sort({ createdAt: -1 }).limit(5);
  if (!bets.length) {
    return ctx.reply('📭 No tienes jugadas registradas aún.');
  }
  let msg = '📜 *Tus últimas 5 jugadas:*\n\n';
  bets.forEach(b => {
    msg += `💰 *Monto:* $${b.totalApuesta.toFixed(2)}\n`;
    msg += `📅 *Fecha:* ${b.createdAt.toLocaleString()}\n`;
    msg += `📝 *Detalle:*\n${b.detalle.substring(0, 200)}${b.detalle.length > 200 ? '…' : ''}\n\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ============================================================
// 8. Procesamiento de mensajes de texto (jugadas)
// ============================================================
bot.on('text', async (ctx) => {
  // Ignorar comandos (empiezan con /)
  if (ctx.message.text.startsWith('/')) return;

  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`📥 Entrada de ${ctx.from.id} (${ctx.from.username}):\n${rawInput}`);

  // 1. Limpiar metadatos y normalizar
  const lines = rawInput.split('\n');
  const cleanedLines = lines.map(line => stripWhatsAppMeta(line)).filter(l => l.trim());
  let cleanText = cleanedLines.join('\n');
  cleanText = reconstruirBloquesConNombres(cleanText);
  cleanText = normalizarSintaxis(cleanText);
  cleanText = expandirDecenasTerminales(cleanText);
  cleanText = cleanText.toLowerCase();

  // 2. Ejecutar el motor para obtener el total de la jugada
  let resultado;
  try {
    resultado = Engine.calcular(
      { rawInput: cleanText, loteriaId: 1, sorteoId: 1 },
      {
        limpiarMonto,
        Expansion: global.Expansion,
        preprocesarJugada: Preprocesador.preprocesarJugada,
      }
    );
  } catch (err) {
    console.error('🔥 Error en motor:', err);
    return ctx.reply(`❌ Error interno del motor: ${err.message}`);
  }

  if (!resultado.ok) {
    const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
    return ctx.reply(`❌ Error en la jugada:\n${errorMsg}`);
  }

  const totalApuesta = resultado.totalGeneral;
  if (totalApuesta === 0) {
    return ctx.reply('❌ La jugada no tiene monto válido. Revisa la sintaxis.');
  }

  // 3. Obtener usuario y verificar saldo
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(
      `❌ Saldo insuficiente.\n` +
      `💰 Necesitas: $${totalApuesta.toFixed(2)}\n` +
      `💰 Tu saldo actual: $${user.saldo.toFixed(2)}\n` +
      `Usa /deposito <monto> para recargar.`
    );
  }

  // 4. Deducción del saldo
  const saldoAntes = user.saldo;
  user.saldo -= totalApuesta;
  user.updatedAt = new Date();
  await user.save();

  // 5. Guardar la jugada en el historial
  const bet = new Bet({
    userId: user._id,
    telegramId: user.telegramId,
    inputRaw: rawInput,
    totalApuesta,
    detalle: resultado.detalleTexto || '',
    saldoAntes,
    saldoDespues: user.saldo,
  });
  await bet.save();

  // 6. Formatear respuesta compacta (igual que antes)
  let respuesta = `💰 *Total apostado:* $${totalApuesta.toFixed(2)}\n`;
  respuesta += `💰 *Saldo restante:* $${user.saldo.toFixed(2)}\n\n`;

  let bloqueActual = null;
  let lineasAgrupadas = [];
  const linesOut = (resultado.detalleTexto || '').split('\n');
  for (let line of linesOut) {
    line = line.trim();
    if (line === '') continue;
    const matchJugador = line.match(/^=== JUGADOR:\s*(.+?)\s*===/i);
    if (matchJugador) {
      if (bloqueActual) {
        respuesta += `*${bloqueActual.nombre}*\n`;
        for (const item of lineasAgrupadas) respuesta += `  ${item}\n`;
        respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n\n`;
        lineasAgrupadas = [];
      }
      bloqueActual = { nombre: matchJugador[1], total: 0 };
      continue;
    }
    const matchTipo = line.match(/^(Fijos|Corridos|Centena|Parle):\s*(.*)/i);
    if (matchTipo && bloqueActual) {
      lineasAgrupadas.push(`${matchTipo[1]}: ${matchTipo[2]}`);
      continue;
    }
    const matchTotal = line.match(/^TOTAL\s+(\S+):\s+([\d.]+)/i);
    if (matchTotal && bloqueActual) {
      bloqueActual.total = parseFloat(matchTotal[2]);
      continue;
    }
    if (bloqueActual) lineasAgrupadas.push(line);
  }
  if (bloqueActual) {
    respuesta += `*${bloqueActual.nombre}*\n`;
    for (const item of lineasAgrupadas) respuesta += `  ${item}\n`;
    respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n`;
  }

  respuesta += `\n✅ *Jugada registrada correctamente.*`;

  await ctx.reply(respuesta, { parse_mode: 'Markdown' });
});

// ============================================================
// 9. Iniciar servidor Express
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook en POST ${webhookPath}`);
});
