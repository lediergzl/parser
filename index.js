const express = require('express');
const { Telegraf } = require('telegraf');

// ============================================================
// FUNCIÓN limpiarMonto (extraída de la lógica del bundle)
// ============================================================
function limpiarMonto(s) {
  if (s == null) return null;
  let txt = String(s)
    .replace(/\s+/g, '')   // eliminar espacios
    .replace(/\$/g, '');   // eliminar símbolo de moneda
  if (!txt) return null;
  // Normalizar separador decimal: comas → puntos
  txt = txt.replace(/,/g, '.');
  // Si hay más de un punto, el último es el decimal
  const dotCount = (txt.match(/\./g) || []).length;
  if (dotCount > 1) {
    const lastDot = txt.lastIndexOf('.');
    txt = txt.slice(0, lastDot).replace(/\./g, '') + '.' + txt.slice(lastDot + 1);
  }
  const n = parseFloat(txt);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// Carga del motor (lotopro-core.bundle.js)
// ============================================================
try {
  require('./lotopro-core.bundle.js');
} catch (error) {
  console.error("❌ Error al cargar 'lotopro-core.bundle.js':", error.message);
  process.exit(1);
}

const { Engine, Expansion } = global;

if (!Engine || typeof Engine.calcular !== 'function') {
  console.error("❌ Engine.calcular no está disponible");
  process.exit(1);
}

// ============================================================
// Configuración de Telegram y Express
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN no configurado en variables de entorno");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();

// Logging de todas las peticiones
app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.path}`);
  next();
});

// Ruta de health check (para cron-job.org)
app.get('/ping', (req, res) => res.send('pong'));

// Ruta raíz
app.get('/', (req, res) => res.send('🤖 Bot de apuestas activo'));

// Webhook (sin express.json() para no interferir)
const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

// Comandos del bot
bot.start((ctx) => ctx.reply('✅ Bot de apuestas activo. Envía una jugada en formato DSL.'));
bot.help((ctx) => ctx.reply(`Ejemplo:
\`\`\`
23 45 con 10
67 89 parle con 20
\`\`\``, { parse_mode: 'Markdown' }));

// Procesamiento de mensajes
bot.on('text', async (ctx) => {
  const rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`⚙️ Procesando jugada de ${ctx.from.username || ctx.from.id}: ${rawInput}`);

  try {
    const resultado = Engine.calcular(
      {
        rawInput,
        loteriaId: 1,      // Ajusta según tu lógica
        sorteoId: 1,       // Ajusta según tu lógica
      },
      {
        limpiarMonto,      // Nuestra función personalizada
        Expansion,
      }
    );

    if (resultado.ok) {
      let respuesta = `💰 *Total:* ${resultado.totalGeneral.toFixed(2)}\n\n`;
      if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
      if (resultado.flaggedWarnings && resultado.flaggedWarnings.length) {
        respuesta += '\n⚠️ *Revisiones pendientes:*\n';
        respuesta += resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
      }
      await ctx.reply(respuesta, { parse_mode: 'Markdown' });
    } else {
      const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
      await ctx.reply(`❌ *Error:*\n${errorMsg}`, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('🔥 Error en el motor:', err);
    await ctx.reply('❌ Error interno del servidor. El administrador ha sido notificado.');
  }
});

// Iniciar servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
  console.log(`✅ Webhook configurado en POST ${webhookPath}`);
});