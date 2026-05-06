const express = require('express');
const { Telegraf } = require('telegraf');

// ============================================================
// 1. Cargar el bundle (debe exponer globales)
// ============================================================
try {
  require('./lotopro-core.bundle.js');
} catch (err) {
  console.error('❌ No se pudo cargar lotopro-core.bundle.js:', err.message);
  process.exit(1);
}

// Obtener referencias globales
const { Engine, Expansion, Preprocesador, limpiarMonto } = global;

// Validación exhaustiva
const missing = [];
if (!Engine) missing.push('Engine');
if (!Expansion) missing.push('Expansion');
if (!Preprocesador) missing.push('Preprocesador');
if (!limpiarMonto) missing.push('limpiarMonto');
if (missing.length) {
  console.error(`❌ Faltan componentes del motor: ${missing.join(', ')}`);
  console.error('Objeto global disponible:', Object.keys(global).filter(k => k.includes('Engine') || k.includes('Prepro')));
  process.exit(1);
}
console.log('✅ Motor cargado correctamente');

// ============================================================
// 2. Funciones de expansión adicionales (opcional)
// ============================================================
function expandirParesConX(texto) {
  return texto.replace(/(\d+)\s*[xX]\s*(?=\d)/g, (match, p1) => p1 + ' ');
}

function expandirDecenasTerminales(texto) {
  let resultado = texto;
  resultado = resultado.replace(/\b[Dd](\d)\b/g, (match, digito) => {
    const decena = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) {
      nums.push(String(decena * 10 + i).padStart(2, '0'));
    }
    return nums.join(' ');
  });
  resultado = resultado.replace(/\b[Tt](\d)\b/g, (match, digito) => {
    const terminal = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) {
      nums.push(String(i * 10 + terminal).padStart(2, '0'));
    }
    return nums.join(' ');
  });
  return resultado;
}

// ============================================================
// 3. Configuración del bot
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

// Comandos
bot.start((ctx) => ctx.reply('✅ Bot activo. Envía una jugada en formato DSL.'));
bot.help((ctx) => ctx.reply('Ejemplo:\nJuana\nD2 con 50 y 20 candado con 2300\nParejas d2 t3 4 5 parle con 5'));

// Procesador principal
bot.on('text', async (ctx) => {
  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`📥 Entrada de ${ctx.from.username || ctx.from.id}: ${rawInput.slice(0, 200)}`);

  // Pre-expansiones
  rawInput = expandirParesConX(rawInput);
  rawInput = expandirDecenasTerminales(rawInput);

  try {
    // Llamada al motor con TODAS las dependencias
    const resultado = Engine.calcular(
      {
        rawInput,
        loteriaId: 1,
        sorteoId: 1,
      },
      {
        limpiarMonto,
        Expansion,
        preprocesarJugada: Preprocesador.preprocesarJugada,
      }
    );

    if (!resultado.ok) {
      const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
      await ctx.reply(`❌ Error en el cálculo:\n${errorMsg}`);
      return;
    }

    let respuesta = `💰 Total: ${resultado.totalGeneral.toFixed(2)}\n\n`;
    if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
    if (resultado.flaggedWarnings?.length) {
      respuesta += '\n⚠️ Revisiones pendientes:\n';
      respuesta += resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
    }
    await ctx.reply(respuesta, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('🔥 Excepción en el motor:', err);
    // Envía el error real para depuración (¡solo temporal!)
    await ctx.reply(`❌ Error interno del servidor:\n${err.message}\n\nStack: ${err.stack?.slice(0, 200)}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook en POST ${webhookPath}`);
});
