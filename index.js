const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN no definido');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Middleware para parsear JSON (IMPORTANTE: debe ir antes del webhook)
app.use(express.json());

// Ruta de health check
app.get('/', (req, res) => res.send('OK'));

// Webhook con logging detallado
const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  console.log('📨 Webhook recibido, body:', JSON.stringify(req.body).slice(0, 500));
  // Delegar a Telegraf y capturar errores
  bot.webhookCallback(webhookPath)(req, res).catch(err => {
    console.error('❌ Error en webhookCallback:', err);
    res.status(500).send('Error interno');
  });
});

// Comandos
bot.start((ctx) => {
  console.log(`Comando /start de ${ctx.from.id}`);
  ctx.reply('✅ Bot activo. Envía cualquier mensaje.');
});

bot.on('text', (ctx) => {
  console.log(`Mensaje de ${ctx.from.id}: ${ctx.message.text}`);
  ctx.reply(`Recibí: ${ctx.message.text}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook configurado en POST ${webhookPath}`);
});
