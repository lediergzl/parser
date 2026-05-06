const express = require('express');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// 1. Configuración de Supabase
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// 2. Cargar el motor DSL (bundle)
// ============================================================
require('./lotopro-core.bundle.js');
const { Engine, Preprocesador } = global;

// ============================================================
// 3. Función limpiarMonto (manual)
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
// 4. Expansión de decenas y terminales (FUNCIÓN CLAVE)
// ============================================================
function expandirAbreviaturas(texto) {
  // Expande d2 → 20 21 22 ... 29
  let resultado = texto.replace(/\b[Dd](\d)\b/g, (match, digito) => {
    const decena = parseInt(digito, 10);
    const numeros = [];
    for (let i = 0; i <= 9; i++) {
      numeros.push(String(decena * 10 + i).padStart(2, '0'));
    }
    return numeros.join(' ');
  });

  // Expande t5 → 05 15 25 ... 95
  resultado = resultado.replace(/\b[Tt](\d)\b/g, (match, digito) => {
    const terminal = parseInt(digito, 10);
    const numeros = [];
    for (let i = 0; i <= 9; i++) {
      numeros.push(String(i).padStart(2, '0') + terminal);
    }
    return numeros.join(' ');
  });

  return resultado;
}

// ============================================================
// 5. Limpieza de metadatos de WhatsApp
// ============================================================
function stripWhatsAppMeta(line) {
  if (!line) return '';
  let cleaned = line.trim();
  cleaned = cleaned.replace(/^\[\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\]\s*[^:]+:\s*/i, '');
  cleaned = cleaned.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\s*-\s*[^:]+:\s*/i, '');
  cleaned = cleaned.replace(/^\+?\d[\d\s]{6,}:\s*/, '');
  return cleaned.trim();
}

// ============================================================
// 6. Detección de nombres y reconstrucción de bloques
// ============================================================
function reconstruirBloquesConNombres(texto) {
  const lines = texto.split('\n');
  const resultado = [];
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
    // Detecta nombres: solo letras (con acentos), sin dígitos, y no es palabra reservada
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
// 7. Normalización adicional (con X y Y, * → x, etc.)
// ============================================================
function normalizarSintaxis(texto) {
  let lines = texto.split('\n');
  let nuevas = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // * → x
    line = line.replace(/(\d+)\s*\*\s*(\d+)/g, '$1x$2');

    // con X y Y → dos líneas (fijo + corrido)
    const matchConY = line.match(/^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)$/i);
    if (matchConY) {
      const nums = matchConY[1];
      const monto1 = matchConY[2];
      const monto2 = matchConY[3];
      nuevas.push(`${nums} con ${monto1}`);
      nuevas.push(`${nums} corrido con ${monto2}`);
      continue;
    }

    // "Parle" en línea propia
    if (line.toLowerCase() === 'parle' && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      if (nextLine) {
        nuevas.push(`parle ${nextLine}`);
        i++;
        continue;
      }
    }

    // "parle N" → "parle con N"
    line = line.replace(/\bparle\s+(\d+)/gi, 'parle con $1');

    // "parejas con N" → lista completa 00 11 ... 99 parle con N
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

    nuevas.push(line);
  }
  return nuevas.join('\n');
}

// ============================================================
// 8. Helpers de base de datos
// ============================================================
async function getOrCreateUser(telegramId, username, firstName) {
  let { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error al buscar usuario:', error);
    return null;
  }

  if (!user) {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ telegram_id: telegramId, username, first_name: firstName, saldo: 0 }])
      .select()
      .single();

    if (insertError) {
      console.error('Error al crear usuario:', insertError);
      return null;
    }
    user = newUser;
    console.log(`🆕 Nuevo usuario registrado: ${telegramId} (${firstName || username})`);
  }
  return user;
}

async function updateUserSaldo(telegramId, nuevoSaldo) {
  const { error } = await supabase
    .from('users')
    .update({ saldo: nuevoSaldo, updated_at: new Date() })
    .eq('telegram_id', telegramId);
  if (error) console.error('Error al actualizar saldo:', error);
}

async function saveBet(userTelegramId, inputRaw, totalApuesta, detalle, saldoAntes, saldoDespues) {
  const { error } = await supabase.from('bets').insert([{
    user_telegram_id: userTelegramId,
    input_raw: inputRaw,
    total_apuesta: totalApuesta,
    detalle: detalle,
    saldo_antes: saldoAntes,
    saldo_despues: saldoDespues
  }]);
  if (error) console.error('Error al guardar apuesta:', error);
}

// ============================================================
// 9. Verificar dependencias
// ============================================================
if (!Engine || !Preprocesador) {
  console.error('❌ Motor no cargado correctamente');
  process.exit(1);
}
console.log('✅ Motor listo');

// ============================================================
// 10. Configuración del bot y Express
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

// ============================================================
// 11. Comandos
// ============================================================
bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(
    `✅ Bienvenido ${ctx.from.first_name || 'usuario'}.\n` +
    `💰 Tu saldo actual es: $${user.saldo.toFixed(2)}\n\n` +
    `Envía una jugada en formato DSL para apostar.\n` +
    `Usa /deposito <monto> para recargar (solo pruebas).\n` +
    `Usa /saldo para consultar tu saldo.\n` +
    `Usa /historial para ver tus últimas jugadas.\n` +
    `Usa /test para probar la expansión de abreviaturas sin gastar saldo.`
  );
});

bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Tu saldo actual es: $${user.saldo.toFixed(2)}`);
});

bot.command('deposito', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('❌ Uso: /deposito <monto>');
  const monto = parseFloat(args[1]);
  if (isNaN(monto) || monto <= 0) return ctx.reply('❌ Monto inválido.');
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const nuevoSaldo = user.saldo + monto;
  await updateUserSaldo(ctx.from.id, nuevoSaldo);
  ctx.reply(`✅ Se acreditaron $${monto.toFixed(2)}.\n💰 Nuevo saldo: $${nuevoSaldo.toFixed(2)}`);
});

bot.command('historial', async (ctx) => {
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('user_telegram_id', ctx.from.id)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error || !bets || !bets.length) return ctx.reply('📭 No tienes jugadas registradas aún.');
  let msg = '📜 *Tus últimas 5 jugadas:*\n\n';
  bets.forEach(b => {
    msg += `💰 *Monto:* $${b.total_apuesta.toFixed(2)}\n📅 *Fecha:* ${new Date(b.created_at).toLocaleString()}\n📝 *Detalle:*\n${b.detalle?.substring(0, 200) || ''}${b.detalle?.length > 200 ? '…' : ''}\n\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Comando de prueba (no gasta saldo)
bot.command('test', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('❌ Uso: /test <texto_con_abreviaturas> (ej: /test t5 con 10)');
  const testText = args.slice(1).join(' ');
  const expandido = expandirAbreviaturas(testText);
  ctx.reply(`🔍 Texto original: ${testText}\n\n✅ Texto expandido:\n${expandido}`);
});

// ============================================================
// 12. Procesamiento de mensajes (jugadas) con orden CORREGIDO
// ============================================================
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  let rawInput = ctx.message.text;
  if (!rawInput.trim()) return;

  console.log(`\n📥 [${ctx.from.id}] Entrada original:\n${rawInput}`);

  // --- PREPROCESAMIENTO EN ORDEN ---
  // 1. Limpiar metadatos de WhatsApp
  let cleaned = rawInput.split('\n').map(line => stripWhatsAppMeta(line)).filter(l => l.trim()).join('\n');
  console.log(`📥 Después de limpiar WhatsApp:\n${cleaned}`);

  // 2. Expandir dX y tX (¡LO MÁS IMPORTANTE!)
  let expanded = expandirAbreviaturas(cleaned);
  console.log(`📥 Después de expandir abreviaturas:\n${expanded}`);

  // 3. Reconstruir bloques con nombres
  let withNames = reconstruirBloquesConNombres(expanded);
  console.log(`📥 Después de reconstruir nombres:\n${withNames}`);

  // 4. Normalizar sintaxis (con X y Y, * → x, etc.)
  let normalized = normalizarSintaxis(withNames);
  console.log(`📥 Después de normalizar sintaxis:\n${normalized}`);

  // 5. Convertir a minúsculas
  let finalText = normalized.toLowerCase();
  console.log(`📥 Texto FINAL que irá al motor:\n${finalText}`);

  // --- LLAMADA AL MOTOR ---
  let resultado;
  try {
    resultado = Engine.calcular(
      { rawInput: finalText, loteriaId: 1, sorteoId: 1 },
      {
        limpiarMonto,
        Expansion: global.Expansion,
        preprocesarJugada: Preprocesador.preprocesarJugada,
      }
    );
  } catch (err) {
    console.error('🔥 Error en motor:', err);
    return ctx.reply(`❌ Error interno del motor: ${err.message}`);
  }

  if (!resultado.ok) {
    const errorMsg = resultado.errors?.map(e => e.message).join('\n') || resultado.message;
    return ctx.reply(`❌ Error en la jugada:\n${errorMsg}`);
  }

  const totalApuesta = resultado.totalGeneral;
  if (totalApuesta === 0) {
    return ctx.reply('❌ La jugada no tiene monto válido. Revisa la sintaxis.');
  }

  // --- VERIFICAR SALDO Y APOSTAR ---
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < totalApuesta) {
    return ctx.reply(
      `❌ Saldo insuficiente.\n` +
      `💰 Necesitas: $${totalApuesta.toFixed(2)}\n` +
      `💰 Tu saldo: $${user.saldo.toFixed(2)}\n` +
      `Usa /deposito para recargar.`
    );
  }

  const saldoAntes = user.saldo;
  const saldoDespues = saldoAntes - totalApuesta;
  await updateUserSaldo(ctx.from.id, saldoDespues);
  await saveBet(ctx.from.id, rawInput, totalApuesta, resultado.detalleTexto || '', saldoAntes, saldoDespues);

  // --- FORMATEAR RESPUESTA ---
  let respuesta = `💰 *Total apostado:* $${totalApuesta.toFixed(2)}\n`;
  respuesta += `💰 *Saldo restante:* $${saldoDespues.toFixed(2)}\n\n`;

  let bloqueActual = null;
  let lineasAgrupadas = [];
  const linesOut = (resultado.detalleTexto || '').split('\n');
  for (let line of linesOut) {
    line = line.trim();
    if (!line) continue;
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

  respuesta += `\n✅ *Jugada registrada correctamente.*`;
  await ctx.reply(respuesta, { parse_mode: 'Markdown' });
});

// ============================================================
// 13. Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`✅ Webhook en POST ${webhookPath}`);
});
