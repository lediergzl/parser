const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) process.exit(1);

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Webhook con logging y manejo de errores
app.post('/webhook', (req, res) => {
  console.log('📨 Webhook recibido, body:', req.body);
  bot.webhookCallback('/webhook')(req, res).catch(err => {
    console.error('❌ Error en webhook:', err);
    res.status(500).send('Error interno');
  });
});

app.get('/', (req, res) => res.send('OK'));

bot.start((ctx) => ctx.reply('✅ Bot activo. Envía cualquier mensaje.'));
bot.on('text', (ctx) => ctx.reply(`Recibí: ${ctx.message.text}`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`✅ Webhook en POST /webhook`);
});
