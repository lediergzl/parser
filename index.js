const express = require('express');
const { Telegraf } = require('telegraf');

// --- Importación de tu motor lotopro-core ---
// Asegúrate de que este archivo esté en la misma carpeta y se llame exactamente igual.
try {
  require('./lotopro-core.bundle.js');
} catch (error) {
  console.error("Error al cargar 'lotopro-core.bundle.js'. Verifica que el archivo exista.");
  process.exit(1);
}

// Usa las funciones globales que expone el bundle
const { Engine, limpiarMonto, Expansion } = global;

if (!Engine || typeof Engine.calcular !== 'function') {
  console.error("Error: El motor 'lotopro-core.bundle.js' no se cargó correctamente o no expone 'Engine.calcular'.");
  process.exit(1);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error("Error: La variable de entorno 'TELEGRAM_BOT_TOKEN' no está configurada.");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();

// ---- Middleware de LOG para depuración ----
// Esto te permitirá ver en los logs de Render si Telegram está llegando a tu servidor.
app.use((req, res, next) => {
  console.log(`📨 Solicitud entrante: ${req.method} ${req.path}`);
  next();
});

// ---- Ruta de prueba para confirmar que el servicio está activo ----
app.get('/ping', (req, res) => {
  console.log("📡 Ping recibido");
  res.send('pong');
});

// ---- WEBHOOK - Ruta que Telegram llamará ----
const webhookPath = '/webhook';
// `bot.webhookCallback` crea un middleware que procesa el update y le responde a Telegram.
// Es *fundamental* usar `app.use` sin añadir `express.json()`, ya que el middleware lo maneja internamente.
app.use(webhookPath, bot.webhookCallback(webhookPath));
console.log(`✅ Middleware de webhook configurado en la ruta: ${webhookPath}`);

// Puedes añadir más rutas si necesitas un frontend simple
app.get('/', (req, res) => {
  res.send('🤖 Bot de Apuestas LotoPro activo. El webhook está funcionando.');
});

// ---- Comandos del bot ----
bot.start((ctx) => ctx.reply('✅ Bot de apuestas activo. Envíame una jugada en el formato DSL.'));

bot.on('text', async (ctx) => {
  const rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  // Parámetros fijos (ajústalos si tu motor necesita lotería/sorteo reales)
  const resultado = Engine.calcular(
    {
      rawInput,
      loteriaId: 1,
      sorteoId: 1,
    },
    {
      limpiarMonto,
      Expansion,
      // El bundle ya tiene internamente preprocesarJugada, no hace falta pasarlo
    }
  );

  if (resultado.ok) {
    let respuesta = `💰 *Total:* ${resultado.totalGeneral.toFixed(2)}\n\n`;
    if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
    if (resultado.flaggedWarnings?.length) {
      respuesta += '\n⚠️ *Revisiones pendientes:*\n';
      respuesta += resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
    }
    await ctx.reply(respuesta, { parse_mode: 'Markdown' });
  } else {
    const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
    await ctx.reply(`❌ *Error:*\n${errorMsg}`, { parse_mode: 'Markdown' });
  }
});

// ---- Inicio del servidor Express ----
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
});