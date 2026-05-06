const express = require('express');
const { Telegraf } = require('telegraf');

// ============================================================
// 1. Cargar el bundle
// ============================================================
require('./lotopro-core.bundle.js');

const { Engine, Preprocesador } = global;

// ============================================================
// 2. Definir limpiarMonto (no viene en el bundle)
// ============================================================
function limpiarMonto(s) {
  if (s == null) return null;
  let txt = String(s).replace(/\s+/g, '').replace(/\$/g, '');
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

// ============================================================
// 3. Verificar dependencias
// ============================================================
if (!Engine || !Preprocesador) {
  console.error('❌ Motor no cargado correctamente');
  process.exit(1);
}
console.log('✅ Motor listo');

// ============================================================
// 4. Configurar bot y Express
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Token no configurado');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.path}`);
  next();
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

bot.start((ctx) => ctx.reply('✅ Bot activo. Envía una jugada.'));
bot.help((ctx) => ctx.reply('Ejemplo:\nJuana\nd2 con 50 y 20 candado con 2300\nparejas d2 t3 4 5 parle con 5'));

// ============================================================
// 5. Procesamiento principal (sin expansiones manuales)
// ============================================================
bot.on('text', async (ctx) => {
  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`📥 Entrada: ${rawInput.slice(0, 200)}`);

  // Convertir a minúsculas para que D2 → d2, Parle → parle, etc.
  rawInput = rawInput.toLowerCase();

  try {
    const resultado = Engine.calcular(
      {
        rawInput,
        loteriaId: 1,
        sorteoId: 1,
      },
      {
        limpiarMonto,
        Expansion: global.Expansion,
        preprocesarJugada: Preprocesador.preprocesarJugada,
      }
    );

    if (!resultado.ok) {
      const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
      await ctx.reply(`❌ Error:\n${errorMsg}`);
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
    console.error('🔥 Excepción:', err);
    await ctx.reply(`❌ Error interno:\n${err.message}\n\n${err.stack?.slice(0, 500)}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`✅ Webhook en ${webhookPath}`);
});
