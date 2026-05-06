const express = require('express');
const { Telegraf } = require('telegraf');

// ============================================================
// 1. Cargar el bundle del motor
// ============================================================
require('./lotopro-core.bundle.js');

const { Engine, Preprocesador } = global;

// ============================================================
// 2. Funciones de limpieza y normalización
// ============================================================

// Elimina metadatos de WhatsApp y líneas vacías o de solo metadatos
function stripWhatsAppMeta(line) {
  if (!line) return '';
  let cleaned = line.trim();
  // [5/5, 1:49 p. m.] +53 5 6468550: Mensaje
  cleaned = cleaned.replace(/^\[\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\]\s*[^:]+:\s*/i, '');
  // 5/5/26, 1:49 p. m. - Nombre: Mensaje
  cleaned = cleaned.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\s*-\s*[^:]+:\s*/i, '');
  // +53 5 6468550: (sin fecha)
  cleaned = cleaned.replace(/^\+?\d[\d\s]{6,}:\s*/, '');
  return cleaned.trim();
}

// Expande dX y tX a listas de números
function expandirDecenasTerminales(texto) {
  let resultado = texto;
  resultado = resultado.replace(/\b[Dd](\d)\b/g, (match, digito) => {
    const decena = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) nums.push(String(decena * 10 + i).padStart(2, '0'));
    return nums.join(' ');
  });
  resultado = resultado.replace(/\b[Tt](\d)\b/g, (match, digito) => {
    const terminal = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) nums.push(String(i * 10 + terminal).padStart(2, '0'));
    return nums.join(' ');
  });
  return resultado;
}

// Normaliza sintaxis: * -> x, "con X y Y" -> dos líneas, "Parle" aparte, etc.
function normalizarSintaxis(texto) {
  let lines = texto.split('\n');
  let nuevas = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // 1. Reemplazar * por x en pares (ej: 25*33 → 25x33)
    line = line.replace(/(\d+)\s*\*\s*(\d+)/g, '$1x$2');

    // 2. Detectar "con X y Y" (sin palabra corrido) y dividir
    const matchConY = line.match(/^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)$/i);
    if (matchConY) {
      const nums = matchConY[1];
      const monto1 = matchConY[2];
      const monto2 = matchConY[3];
      nuevas.push(`${nums} con ${monto1}`);
      nuevas.push(`${nums} corrido con ${monto2}`);
      continue;
    }

    // 3. Detectar "Parle" en línea propia y la siguiente contiene la lista de pares
    if (line.toLowerCase() === 'parle' && i + 1 < lines.length) {
      let nextLine = lines[i + 1].trim();
      if (nextLine) {
        // Si la siguiente línea tiene pares con * o x, ya se normalizaron
        nuevas.push(`parle ${nextLine}`);
        i++; // saltar la línea siguiente
        continue;
      }
    }

    // 4. Asegurar "parle con N" cuando está pegado
    line = line.replace(/\bparle\s+(\d+)/gi, 'parle con $1');

    // 5. Expandir "parejas con N" a lista completa 00 11 ... 99 con N
    if (/\bparejas?\s+con\s+\d+/i.test(line)) {
      const montoMatch = line.match(/\bparejas?\s+con\s+(\d+)/i);
      if (montoMatch) {
        const monto = montoMatch[1];
        const pares = [];
        for (let i = 0; i <= 9; i++) pares.push(String(i).repeat(2).padStart(2, '0'));
        nuevas.push(`${pares.join(' ')} parle con ${monto}`);
        continue;
      }
    }

    // 6. Si no aplica ninguna regla, mantener la línea
    nuevas.push(line);
  }
  return nuevas.join('\n');
}

// Reconstruye bloques detectando nombres automáticamente
function reconstruirBloquesConNombres(texto) {
  const lines = texto.split('\n');
  let resultado = [];
  let nombreActual = null;
  let acumulador = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (acumulador.length) {
        if (nombreActual) resultado.unshift(nombreActual);
        resultado.push(...acumulador);
        resultado.push('');
        nombreActual = null;
        acumulador = [];
      }
      continue;
    }

    // Es nombre si: solo letras (con acentos), sin dígitos, y no es palabra reservada del DSL
    const esNombre = /^[a-zA-ZáéíóúñÁÉÍÓÚÑ\s]+$/.test(line) && !/\d/.test(line) && !/^(con|parle|candado|total|fijo|corrido|centena|parejas|terminal|decena|new|york|por|tarjeta)$/i.test(line);
    if (esNombre && nombreActual === null && acumulador.length === 0) {
      nombreActual = line;
      continue;
    }

    acumulador.push(line);
  }
  if (acumulador.length) {
    if (nombreActual) resultado.unshift(nombreActual);
    resultado.push(...acumulador);
  }
  return resultado.join('\n');
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
// 4. Configuración del bot y Express
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

bot.start((ctx) => ctx.reply('✅ Bot activo. Envía una jugada tal como sale de WhatsApp.'));
bot.help((ctx) => ctx.reply('Puedes pegar el texto completo con múltiples jugadores. El bot lo procesará automáticamente.'));

// ============================================================
// 5. Procesamiento principal
// ============================================================
bot.on('text', async (ctx) => {
  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`📥 Entrada original:\n${rawInput}`);

  // 1. Limpiar metadatos de WhatsApp línea por línea
  const lines = rawInput.split('\n');
  const cleanedLines = lines.map(line => stripWhatsAppMeta(line)).filter(l => l.trim());
  let cleanText = cleanedLines.join('\n');

  // 2. Reconstruir bloques con nombres detectados
  cleanText = reconstruirBloquesConNombres(cleanText);

  // 3. Normalizar sintaxis (con X y Y, * → x, Parle anticipado, parejas)
  cleanText = normalizarSintaxis(cleanText);

  // 4. Expandir dX, tX
  cleanText = expandirDecenasTerminales(cleanText);

  // 5. Convertir a minúsculas para unificar
  cleanText = cleanText.toLowerCase();

  console.log(`📥 Texto preprocesado:\n${cleanText}`);

  try {
    const resultado = Engine.calcular(
      {
        rawInput: cleanText,
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

    const linesOut = (resultado.detalleTexto || '').split('\n');
    for (let line of linesOut) {
      line = line.trim();
      if (line === '') continue;

      const matchJugador = line.match(/^=== JUGADOR:\s*(.+?)\s*===/i);
      if (matchJugador) {
        if (bloqueActual) {
          respuesta += `*${bloqueActual.nombre}*\n`;
          for (const item of lineasAgrupadas) respuesta += `  ${item}\n`;
          respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n\n`;
          lineasAgrupadas = [];
        }
        bloqueActual = { nombre: matchJugador[1], total: 0 };
        continue;
      }

      const matchTipo = line.match(/^(Fijos|Corridos|Centena|Parle):\s*(.*)/i);
      if (matchTipo && bloqueActual) {
        lineasAgrupadas.push(`${matchTipo[1]}: ${matchTipo[2]}`);
        continue;
      }

      const matchTotal = line.match(/^TOTAL\s+(\S+):\s+([\d.]+)/i);
      if (matchTotal && bloqueActual) {
        bloqueActual.total = parseFloat(matchTotal[2]);
        continue;
      }

      if (bloqueActual) lineasAgrupadas.push(line);
    }

    if (bloqueActual) {
      respuesta += `*${bloqueActual.nombre}*\n`;
      for (const item of lineasAgrupadas) respuesta += `  ${item}\n`;
      respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n`;
    }

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
