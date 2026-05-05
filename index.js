const express = require('express');
const { Telegraf } = require('telegraf');

// Cargar tu motor lotopro-core.bundle.js
// Asegúrate de que el archivo esté en la misma carpeta
require('./lotopro-core.bundle.js');

// Usa las funciones globales que expone el bundle
const { Engine, limpiarMonto, Expansion } = global;

// Token del bot (lo pones como variable de entorno en Render)
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
app.use(express.json());

// Webhook endpoint (puedes cambiar la ruta)
app.use(bot.webhookCallback('/webhook'));

// Comando start
bot.start((ctx) => ctx.reply('✅ Bot de apuestas activo. Envíame una jugada en el formato DSL.'));

// Procesar mensajes de texto
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

// Ruta de salud (para mantener vivo el servicio con cron-job.org)
app.get('/ping', (req, res) => res.send('pong'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot listening on port ${port}`));