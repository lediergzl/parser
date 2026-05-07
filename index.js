const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN no definido');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Webhook
const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

// Ruta de salud (opcional)
app.get('/', (req, res) => res.send('OK'));

// Comandos
bot.start((ctx) => ctx.reply('✅ Bot activo. Envía cualquier mensaje.'));
bot.on('text', (ctx) => {
  console.log(`Mensaje de ${ctx.from.id}: ${ctx.message.text}`);
  ctx.reply(`Recibí: ${ctx.message.text}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook configurado en POST ${webhookPath}`);
});
