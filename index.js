const express = require('express');
const { Telegraf } = require('telegraf');

// ============================================================
// 1. Cargar el bundle del motor (expone globales)
// ============================================================
require('./lotopro-core.bundle.js');

// Extraer las funciones que el motor necesita
const { Engine, Expansion, Preprocesador, limpiarMonto } = global;

// Verificar que todo esté presente
if (!Engine || typeof Engine.calcular !== 'function') {
  console.error('❌ Engine.calcular no está disponible');
  process.exit(1);
}
if (!Preprocesador || typeof Preprocesador.preprocesarJugada !== 'function') {
  console.error('❌ Preprocesador.preprocesarJugada no está disponible');
  process.exit(1);
}

// ============================================================
// 2. Funciones de expansión opcionales (para más tolerancia)
//    (puedes mantenerlas o no; el preprocesador ya hace mucho)
// ============================================================
function expandirParesConX(texto) {
  // Convierte "28x82x14x41" en "28 82 14 41"
  return texto.replace(/(\d+)\s*[xX]\s*(?=\d)/g, (match, p1) => p1 + ' ');
}

function expandirDecenasTerminales(texto) {
  // Convierte D2 → 20 21 ... 29,  t3 → 03 13 ... 93
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

// ============================================================
// 3. Configuración de Telegram y Express
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN no definido en variables de entorno');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Logging de todas las peticiones (útil para depurar)
app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.path}`);
  next();
});

// Ruta de salud para mantener el bot despierto (ping)
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 Bot de loterías activo'));

// Webhook: sin express.json() para no interferir con el callback de Telegraf
const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

// ============================================================
// 4. Comandos y mensajes del bot
// ============================================================
bot.start((ctx) => {
  ctx.reply(
    '✅ Bot de apuestas activo.\n\n' +
    'Envía una jugada en formato DSL.\n' +
    'Ejemplo:\n' +
    '```\n' +
    'Juana\n' +
    '20 21 22 23 24 25 26 27 28 29 con 50\n' +
    '20 21 22 23 24 25 26 27 28 29 corrido con 20\n' +
    '20 21 22 23 24 25 26 27 28 29 candado con 2300\n' +
    'Parejas d2 t3 4 5 parle con 5\n' +
    '```',
    { parse_mode: 'Markdown' }
  );
});

bot.help((ctx) => {
  ctx.reply(
    'ℹ️ *Instrucciones*\n' +
    '• Los números se separan por espacios.\n' +
    '• Usa "con" para indicar el monto.\n' +
    '• Para parlés: `nums parle con monto`\n' +
    '• Para candados: `nums candado con monto`\n' +
    '• Para centenas: `centenas con monto`\n' +
    '• Para decenas/terminales: `d2` (20-29), `t3` (03,13,...,93)\n' +
    '• Para pares con "x": `28x82x14x41 parle con 2`\n\n' +
    'Ejemplo completo:\n' +
    '```\n' +
    'Juana\n' +
    '20 21 22 23 24 25 26 27 28 29 con 50\n' +
    'D2 corrido con 20\n' +
    'D2 candado con 2300\n' +
    'd2 t3 4 5 parle con 5\n' +
    '```',
    { parse_mode: 'Markdown' }
  );
});

// Procesamiento de mensajes de texto
bot.on('text', async (ctx) => {
  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`⚙️ Procesando jugada de ${ctx.from.username || ctx.from.id}: ${rawInput.slice(0, 100)}`);

  // (Opcional) Expansiones adicionales para mayor comodidad
  // Si ya usas D2, t3, etc., el preprocesador las maneja; pero estas funciones ayudan
  // con notaciones como "28x82x14x41" y mayúsculas "D2".
  rawInput = expandirParesConX(rawInput);
  rawInput = expandirDecenasTerminales(rawInput);

  // Parámetros fijos (lotería y sorteo por defecto, se pueden hacer dinámicos)
  const loteriaId = 1;
  const sorteoId = 1;

  try {
    const resultado = Engine.calcular(
      {
        rawInput,
        loteriaId,
        sorteoId,
      },
      {
        limpiarMonto,                // función de limpieza de montos
        Expansion,                   // expansor de centenas, rangos, etc.
        preprocesarJugada: Preprocesador.preprocesarJugada,  // ← CLAVE: el preprocesador completo
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

// ============================================================
// 5. Iniciar servidor Express
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Express escuchando en el puerto ${PORT}`);
  console.log(`✅ Webhook configurado en POST ${webhookPath}`);
});