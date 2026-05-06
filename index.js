const express = require('express');
const { Telegraf } = require('telegraf');

// ============================================================
// 1. Cargar el bundle del motor
// ============================================================
require('./lotopro-core.bundle.js');

const { Engine, Preprocesador } = global;

// ============================================================
// 2. Función limpiarMonto (no viene en el bundle)
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
// 3. Expansión de decenas y terminales (d2 -> 20 21 ... 29)
// ============================================================
function expandirDecenasTerminales(texto) {
  let resultado = texto;
  // d2 (minúscula o mayúscula) → 20 21 22 ... 29
  resultado = resultado.replace(/\b[Dd](\d)\b/g, (match, digito) => {
    const decena = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) {
      nums.push(String(decena * 10 + i).padStart(2, '0'));
    }
    return nums.join(' ');
  });
  // t3 → 03 13 23 ... 93
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
// 4. Convertir "d2 con 50 y 20 candado con 2300" en tres líneas
//    y expandir las abreviaturas dentro de la parte numérica
// ============================================================
function expandirLineaMixta(linea) {
  const regex = /^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)\s+candado\s+con\s+(\d+(?:\.\d+)?)$/i;
  const match = linea.match(regex);
  if (!match) return linea;

  let numsPart = match[1].trim();      // ej: "d2" o "20 21"
  const monto1 = match[2];
  const monto2 = match[3];
  const monto3 = match[4];

  // Expandir abreviaturas dentro de numsPart (d2 → lista de números)
  numsPart = expandirDecenasTerminales(numsPart);

  const fijoLine   = `${numsPart} con ${monto1}`;
  const corridoLine = `${numsPart} corrido con ${monto2}`;
  const candadoLine = `${numsPart} candado con ${monto3}`;
  return `${fijoLine}\n${corridoLine}\n${candadoLine}`;
}

function preprocesarLineasMixtas(texto) {
  return texto.split('\n').map(l => expandirLineaMixta(l.trim())).join('\n');
}

// ============================================================
// 5. Verificar dependencias
// ============================================================
if (!Engine || !Preprocesador) {
  console.error('❌ Motor no cargado correctamente');
  process.exit(1);
}
console.log('✅ Motor listo');

// ============================================================
// 6. Configuración del bot y Express
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN no definido');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.path}`);
  next();
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot activo'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => {
  bot.webhookCallback(webhookPath)(req, res);
});

bot.start((ctx) => ctx.reply('✅ Bot activo. Envía una jugada en formato DSL.'));
bot.help((ctx) => ctx.reply(
  'Ejemplo:\n' +
  'Juana\n' +
  'D2 con 50 y 20 candado con 2300\n' +
  'Parejas d2 t3 4 5 parle con 5\n\n' +
  'Puedes usar mayúsculas o minúsculas.',
  { parse_mode: 'Markdown' }
));

// ============================================================
// 7. Procesamiento principal con formateo compacto
// ============================================================
bot.on('text', async (ctx) => {
  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`📥 Entrada original:\n${rawInput}`);

  // Convertir a minúsculas para unificar
  rawInput = rawInput.toLowerCase();

  // Dividir líneas mixtas (ej: "d2 con 50 y 20 candado con 2300")
  rawInput = preprocesarLineasMixtas(rawInput);

  // Expandir cualquier abreviatura dX/tX residual
  rawInput = expandirDecenasTerminales(rawInput);

  console.log(`📥 Texto preprocesado:\n${rawInput}`);

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

    // ----- Formateo compacto de la salida -----
    let respuesta = `💰 *Total:* ${resultado.totalGeneral.toFixed(2)}\n\n`;
    let bloqueActual = null;
    let lineasAgrupadas = [];

    const lines = (resultado.detalleTexto || '').split('\n');
    for (let line of lines) {
      line = line.trim();
      if (line === '') continue;

      // Detectar inicio de bloque "=== JUGADOR: xxx ==="
      const matchJugador = line.match(/^=== JUGADOR:\s*(.+?)\s*===/i);
      if (matchJugador) {
        if (bloqueActual) {
          respuesta += `*${bloqueActual.nombre}*\n`;
          for (const item of lineasAgrupadas) {
            respuesta += `  ${item}\n`;
          }
          respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n\n`;
          lineasAgrupadas = [];
        }
        bloqueActual = { nombre: matchJugador[1], total: 0 };
        continue;
      }

      // Detectar líneas de tipo "Fijos: ...", "Corridos: ...", "Centena: ...", "Parle: ..."
      const matchTipo = line.match(/^(Fijos|Corridos|Centena|Parle):\s*(.*)/i);
      if (matchTipo && bloqueActual) {
        const tipo = matchTipo[1];
        const contenido = matchTipo[2];
        lineasAgrupadas.push(`${tipo}: ${contenido}`);
        continue;
      }

      // Detectar total de jugador (ej: "TOTAL Pepe: 145.00")
      const matchTotal = line.match(/^TOTAL\s+(\S+):\s+([\d.]+)/i);
      if (matchTotal && bloqueActual) {
        bloqueActual.total = parseFloat(matchTotal[2]);
        continue;
      }

      // Otras líneas (fallback) las agregamos tal cual
      if (bloqueActual) {
        lineasAgrupadas.push(line);
      }
    }

    // Cerrar último bloque
    if (bloqueActual) {
      respuesta += `*${bloqueActual.nombre}*\n`;
      for (const item of lineasAgrupadas) {
        respuesta += `  ${item}\n`;
      }
      respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n`;
    }

    // Si el total general no se incluyó arriba, lo añadimos
    if (!respuesta.includes('*TOTAL GENERAL*')) {
      respuesta += `\n*TOTAL GENERAL:* ${resultado.totalGeneral.toFixed(2)}`;
    }

    await ctx.reply(respuesta, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('🔥 Excepción en el motor:', err);
    await ctx.reply(`❌ Error interno:\n${err.message}\n\n${err.stack?.slice(0, 500)}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook en POST ${webhookPath}`);
});
