const express = require('express');
const { Telegraf } = require('telegraf');

// 1. Carga de tu motor de apuestas local
try {
  require('./lotopro-core.bundle.js');
} catch (error) {
  console.error("Error FATAL: No se pudo cargar 'lotopro-core.bundle.js'. Verifica que el archivo exista en el directorio.");
  // En un entorno de producción, es mejor que el proceso termine aquí si el core es vital.
  // process.exit(1);
}

// Verificación de que el motor se cargó correctamente en el objeto global
const { Engine, limpiarMonto, Expansion } = global;
if (!Engine || typeof Engine.calcular !== 'function') {
  console.error("Error FATAL: El motor 'lotopro-core.bundle.js' no se cargó o no expone 'Engine.calcular'.");
  // process.exit(1);
}

// 2. Configuración Básica
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error("Error FATAL: La variable de entorno 'TELEGRAM_BOT_TOKEN' no está configurada.");
  // process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();

// --- Middleware de LOG (Siempre útil para depurar) ---
app.use((req, res, next) => {
  console.log(`📨 [${req.method}] Solicitud entrante a: ${req.path}`);
  next();
});

// --- Ruta de prueba para mantener el servicio despierto y hacer health checks ---
app.get('/ping', (req, res) => {
  console.log("📡 Ping recibido en /ping");
  res.send('pong');
});

// --- Ruta raíz para verificar que el servidor está activo y responderá ---
app.get('/', (req, res) => {
  res.send('🤖 Bot de Apuestas LotoPro activo. El webhook está funcionando.');
});

// --- WEBHOOK (La parte crucial) ---
const webhookPath = '/webhook';
// 🔥 La clave está aquí: NO usamos app.use(express.json()) de forma global.
// app.use(bot.webhookCallback(webhookPath)) ya incluye su propio parser para la petición POST de Telegram.
app.post(webhookPath, (req, res) => {
  // req.body se pasa directamente al middleware de Telegraf.
  bot.webhookCallback(webhookPath)(req, res);
});
console.log(`✅ Middleware de webhook configurado manualmente en la ruta POST: ${webhookPath}`);

// --- Comandos del Bot ---
bot.start((ctx) => ctx.reply('✅ Bot de apuestas activo. Envíame una jugada en el formato DSL.'));

// Comando de ayuda para que los usuarios sepan qué hacer
bot.help((ctx) => ctx.reply(`ℹ️ *Instrucciones:* escribe los números y el monto siguiendo el formato DSL. Por ejemplo:
\`\`\`
23 45 con 10
67 89 parle con 20
\`\`\``, { parse_mode: 'Markdown' }));

// Procesador de mensajes de texto (Aquí va tu lógica de negocio)
bot.on('text', async (ctx) => {
  const rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`⚙️ Procesando jugada de ${ctx.from.username || ctx.from.id}: ${rawInput}`);

  // Parámetros fijos que espera tu motor. Ajusta si son necesarios.
  try {
    const resultado = Engine.calcular(
      {
        rawInput,
        loteriaId: 1,
        sorteoId: 1,
      },
      {
        limpiarMonto,
        Expansion,
      }
    );

    if (resultado.ok) {
      let respuesta = `💰 *Total:* ${resultado.totalGeneral.toFixed(2)}\n\n`;
      if (resultado.detalleTexto) respuesta += resultado.detalleTexto;
      if (resultado.flaggedWarnings && resultado.flaggedWarnings.length > 0) {
        respuesta += '\n⚠️ *Revisiones pendientes:*\n';
        respuesta += resultado.flaggedWarnings.map(w => `• ${w.message}`).join('\n');
      }
      await ctx.reply(respuesta, { parse_mode: 'Markdown' });
    } else {
      const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
      await ctx.reply(`❌ *Error:*\n${errorMsg}`, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error(`🔥 Error crítico en el motor de apuestas: ${err.message}`);
    console.error(err.stack);
    await ctx.reply('❌ Error interno del servidor. El administrador ha sido notificado.');
  }
});

// --- Inicio del Servidor Express ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Servidor Express escuchando en el puerto ${port} y listo para recibir webhooks.`);
});