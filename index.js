const express = require('express');
const { Telegraf } = require('telegraf');

// ============================================================
// 1. Cargar el bundle (debe exponer Engine y Preprocesador)
// ============================================================
try {
  require('./lotopro-core.bundle.js');
} catch (err) {
  console.error('❌ No se pudo cargar lotopro-core.bundle.js:', err.message);
  process.exit(1);
}

// Extraer lo que el bundle expone
const { Engine, Preprocesador } = global;

// ──────────────────────────────────────────────────────────
// 2. Definir limpiarMonto MANUALMENTE (no viene en el bundle)
// ──────────────────────────────────────────────────────────
function limpiarMonto(s) {
  if (s == null) return null;
  let txt = String(s)
    .replace(/\s+/g, '')
    .replace(/\$/g, '');
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

// ──────────────────────────────────────────────────────────
// 3. Expansión de D2/t3 y NxN (para que tolere mayúsculas)
// ──────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────
// 4. Validar dependencias mínimas para arrancar
// ──────────────────────────────────────────────────────────
if (!Engine) {
  console.error('❌ Engine no está disponible en el bundle');
  process.exit(1);
}
if (!Preprocesador) {
  console.error('❌ Preprocesador no está disponible en el bundle');
  process.exit(1);
}
console.log('✅ Motor cargado correctamente (limpiarMonto definido localmente)');

// ──────────────────────────────────────────────────────────
// 5. Configuración de Telegram y Express
// ──────────────────────────────────────────────────────────
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

bot.start((ctx) => ctx.reply('✅ Bot activo. Envía una jugada en formato DSL.'));
bot.help((ctx) => ctx.reply(
  'Ejemplo:\n```\nJuana\nD2 con 50 y 20 candado con 2300\nParejas d2 t3 4 5 parle con 5\n```',
  { parse_mode: 'Markdown' }
));

// ──────────────────────────────────────────────────────────
// 6. Procesamiento de mensajes (con manejo de errores detallado)
// ──────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`📥 Entrada de ${ctx.from.username || ctx.from.id}: ${rawInput.slice(0, 200)}`);

  // Expansiones opcionales (mejoran compatibilidad)
  rawInput = expandirParesConX(rawInput);
  rawInput = expandirDecenasTerminales(rawInput);

  try {
    // Llamada al motor con todas las dependencias
    const resultado = Engine.calcular(
      {
        rawInput,
        loteriaId: 1,
        sorteoId: 1,
      },
      {
        limpiarMonto,                                     // manual
        Expansion: global.Expansion || null,              // puede ser null, el motor lo tolera
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
    // Enviamos el error real para depurar (después puedes quitar el stack)
    await ctx.reply(`❌ Error interno del servidor:\n${err.message}\n\nStack:\n${err.stack?.slice(0, 500)}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook en POST ${webhookPath}`);
});
