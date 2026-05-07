const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Token no definido');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

bot.start((ctx) => ctx.reply('✅ Bot funcionando. Envía cualquier mensaje.'));
bot.on('text', (ctx) => ctx.reply(`Recibí: ${ctx.message.text}`));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`✅ Webhook: ${webhookPath}`);
});
