const express = require('express');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// 1. SUPABASE
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// 2. MOTOR DSL
// ============================================================
require('./lotopro-core.bundle.js');
const { Engine, Preprocesador } = global;

// ============================================================
// 3. LIMPIAR MONTO
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
// 4. LIMPIEZA DE METADATOS WHATSAPP
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
// 5. DETECCIÓN DE NOMBRES (NO se eliminan)
// ============================================================
function esPosibleNombre(linea) {
  if (!linea) return false;
  const trimmed = linea.trim();
  // Debe tener al menos una letra, sin dígitos
  if (!/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(trimmed)) return false;
  if (/\d/.test(trimmed)) return false;
  // Palabras reservadas del DSL no son nombres
  const reservadas = ['con', 'parle', 'candado', 'total', 'fijo', 'corrido', 'centena', 'parejas', 'terminal', 'decena', 'new', 'york', 'por', 'tarjeta', 'las', 'los', 'y', 'el', 'la'];
  const lower = trimmed.toLowerCase();
  if (reservadas.includes(lower)) return false;
  // Si tiene más de 3 palabras y contiene "de", "en", etc., probable no es nombre
  const palabras = trimmed.split(/\s+/);
  if (palabras.length > 3) return false;
  return true;
}

// ============================================================
// 6. EXPANSIÓN DE ABREVIATURAS (dX, tX)
// ============================================================
function expandirAbreviaturas(texto) {
  let resultado = texto;
  // d2 -> 20 21 22 ... 29
  resultado = resultado.replace(/\b[Dd](\d)\b/g, (match, digito) => {
    const decena = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) nums.push(String(decena * 10 + i).padStart(2, '0'));
    return nums.join(' ');
  });
  // t5 -> 05 15 25 ... 95
  resultado = resultado.replace(/\b[Tt](\d)\b/g, (match, digito) => {
    const terminal = parseInt(digito, 10);
    const nums = [];
    for (let i = 0; i <= 9; i++) nums.push(String(i).padStart(2, '0') + terminal);
    return nums.join(' ');
  });
  return resultado;
}

// ============================================================
// 7. NORMALIZACIÓN DE SÍMBOLOS (🔒 → candado)
// ============================================================
function normalizarSimbolos(texto) {
  return texto.replace(/🔒/g, ' candado ');
}

// ============================================================
// 8. RECONSTRUCCIÓN DE BLOQUES (CONSERVA NOMBRES Y ORDEN)
// ============================================================
function reconstruirBloquesConNombres(texto) {
  const lines = texto.split('\n');
  const resultado = [];
  let bloqueActual = null;   // { nombre, lineasNumeros }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      // Línea vacía: separador entre bloques
      if (bloqueActual && bloqueActual.lineasNumeros.length > 0) {
        // Guardar bloque actual
        if (bloqueActual.nombre) resultado.push(bloqueActual.nombre);
        resultado.push(...bloqueActual.lineasNumeros);
        resultado.push(''); // línea vacía separadora
        bloqueActual = null;
      }
      continue;
    }

    // Determinar si la línea es un nombre o parte de la jugada
    if (esPosibleNombre(line) && (bloqueActual === null || bloqueActual.lineasNumeros.length === 0)) {
      // Es un nombre que inicia un nuevo bloque
      if (bloqueActual && bloqueActual.lineasNumeros.length > 0) {
        // Guardar bloque anterior
        if (bloqueActual.nombre) resultado.push(bloqueActual.nombre);
        resultado.push(...bloqueActual.lineasNumeros);
        resultado.push('');
        bloqueActual = null;
      }
      bloqueActual = { nombre: line, lineasNumeros: [] };
      continue;
    }

    // Es una línea de jugada (contiene números o keywords)
    if (/\d/.test(line) || /(con|parle|candado|total)/i.test(line)) {
      if (!bloqueActual) {
        // Sin nombre asignado, creamos bloque anónimo
        bloqueActual = { nombre: null, lineasNumeros: [] };
      }
      bloqueActual.lineasNumeros.push(line);
      continue;
    }

    // Cualquier otra línea (p.ej. metadata residual) la ignoramos
  }

  // Cerrar último bloque
  if (bloqueActual && bloqueActual.lineasNumeros.length > 0) {
    if (bloqueActual.nombre) resultado.push(bloqueActual.nombre);
    resultado.push(...bloqueActual.lineasNumeros);
  }

  // Unir líneas con saltos
  return resultado.join('\n');
}

// ============================================================
// 9. NORMALIZACIÓN SINTÁCTICA (con X y Y, * → x, parejas, parle)
// ============================================================
function normalizarSintaxis(texto) {
  let lines = texto.split('\n');
  let nuevas = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // * -> x
    line = line.replace(/(\d+)\s*\*\s*(\d+)/g, '$1x$2');

    // con X y Y -> dos líneas (fijo + corrido)
    const matchConY = line.match(/^(.+?)\s+con\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)$/i);
    if (matchConY) {
      const nums = matchConY[1];
      const monto1 = matchConY[2];
      const monto2 = matchConY[3];
      nuevas.push(`${nums} con ${monto1}`);
      nuevas.push(`${nums} corrido con ${monto2}`);
      continue;
    }

    // "Parle" en línea propia + siguiente línea con pares
    if (line.toLowerCase() === 'parle' && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      if (nextLine) {
        nuevas.push(`parle ${nextLine}`);
        i++;
        continue;
      }
    }

    // "parle N" -> "parle con N"
    line = line.replace(/\bparle\s+(\d+)/gi, 'parle con $1');

    // "parejas con N" -> lista completa 00 11 ... 99 parle con N
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
// 10. HELPERS DB
// ============================================================
async function getOrCreateUser(telegramId, username, firstName) {
  let { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  if (error && error.code !== 'PGRST116') return null;
  if (!user) {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ telegram_id: telegramId, username, first_name: firstName, saldo: 0 }])
      .select()
      .single();
    if (insertError) return null;
    user = newUser;
  }
  return user;
}

async function updateUserSaldo(telegramId, nuevoSaldo) {
  await supabase.from('users').update({ saldo: nuevoSaldo, updated_at: new Date() }).eq('telegram_id', telegramId);
}

async function saveBet(userTelegramId, inputRaw, totalApuesta, detalle, saldoAntes, saldoDespues) {
  await supabase.from('bets').insert([{
    user_telegram_id: userTelegramId,
    input_raw: inputRaw,
    total_apuesta: totalApuesta,
    detalle: detalle,
    saldo_antes: saldoAntes,
    saldo_despues: saldoDespues
  }]);
}

// ============================================================
// 11. CONFIGURAR BOT Y EXPRESS
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ Token no definido'); process.exit(1); }
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use((req, res, next) => { console.log(`📨 [${req.method}] ${req.path}`); next(); });
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('🤖 LotoPro Bot'));

const webhookPath = '/webhook';
app.post(webhookPath, (req, res) => { bot.webhookCallback(webhookPath)(req, res); });

// Comandos
bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`✅ Bienvenido ${ctx.from.first_name}.\n💰 Saldo: $${user.saldo.toFixed(2)}\n\nEnvía una jugada.\n/deposito <monto>\n/saldo\n/historial\n/test <texto>`);
});
bot.command('saldo', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(`💰 Saldo: $${user.saldo.toFixed(2)}`);
});
bot.command('deposito', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Uso: /deposito <monto>');
  const monto = parseFloat(args[1]);
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido');
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const nuevo = user.saldo + monto;
  await updateUserSaldo(ctx.from.id, nuevo);
  ctx.reply(`✅ Depositado $${monto.toFixed(2)}. Nuevo saldo: $${nuevo.toFixed(2)}`);
});
bot.command('historial', async (ctx) => {
  const { data: bets } = await supabase.from('bets').select('*').eq('user_telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(5);
  if (!bets?.length) return ctx.reply('No hay jugadas.');
  let msg = '📜 *Últimas 5 jugadas:*\n\n';
  bets.forEach(b => { msg += `💰 $${b.total_apuesta.toFixed(2)} - ${new Date(b.created_at).toLocaleString()}\n${b.detalle?.substring(0,100)}…\n\n`; });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});
bot.command('test', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Uso: /test <texto>');
  const testText = args.slice(1).join(' ');
  const expandido = expandirAbreviaturas(testText);
  ctx.reply(`🔍 Original: ${testText}\n✅ Expandido: ${expandido}`);
});

// ============================================================
// 12. PROCESAMIENTO PRINCIPAL (PIPELINE CORREGIDO)
// ============================================================
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  let raw = ctx.message.text;
  if (!raw.trim()) return;

  console.log(`\n📥 [${ctx.from.id}] RAW:\n${raw}`);

  // Paso 1: limpiar metadatos WhatsApp
  let cleaned = raw.split('\n').map(l => stripWhatsAppMeta(l)).filter(l => l.trim()).join('\n');
  console.log(`📥 Cleaned:\n${cleaned}`);

  // Paso 2: normalizar símbolos (🔒 → candado)
  let withSymbols = normalizarSimbolos(cleaned);
  console.log(`📥 After symbols:\n${withSymbols}`);

  // Paso 3: expandir abreviaturas (dX, tX)
  let expanded = expandirAbreviaturas(withSymbols);
  console.log(`📥 Expanded:\n${expanded}`);

  // Paso 4: reconstruir bloques conservando nombres y orden
  let withNames = reconstruirBloquesConNombres(expanded);
  console.log(`📥 With names:\n${withNames}`);

  // Paso 5: normalizar sintaxis (con X y Y, * → x, parle, parejas)
  let normalized = normalizarSintaxis(withNames);
  console.log(`📥 Normalized:\n${normalized}`);

  // Paso 6: convertir a minúsculas para el motor
  let final = normalized.toLowerCase();
  console.log(`📥 FINAL:\n${final}`);

  // Llamar al motor
  let result;
  try {
    result = Engine.calcular(
      { rawInput: final, loteriaId: 1, sorteoId: 1 },
      { limpiarMonto, Expansion: global.Expansion, preprocesarJugada: Preprocesador.preprocesarJugada }
    );
  } catch (err) {
    console.error(err);
    return ctx.reply(`❌ Error interno: ${err.message}`);
  }

  if (!result.ok) {
    const errorMsg = result.errors?.map(e => e.message).join('\n') || result.message;
    return ctx.reply(`❌ ${errorMsg}`);
  }

  const total = result.totalGeneral;
  if (total === 0) return ctx.reply('❌ Monto cero. Revisa sintaxis.');

  const user = await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  if (user.saldo < total) {
    return ctx.reply(`❌ Saldo insuficiente. Necesitas $${total.toFixed(2)}, tienes $${user.saldo.toFixed(2)}. Usa /deposito`);
  }

  const antes = user.saldo;
  const despues = antes - total;
  await updateUserSaldo(ctx.from.id, despues);
  await saveBet(ctx.from.id, raw, total, result.detalleTexto || '', antes, despues);

  // Formateo de respuesta (sin duplicados)
  let respuesta = `💰 *Total apostado:* $${total.toFixed(2)}\n💰 *Saldo restante:* $${despues.toFixed(2)}\n\n`;
  let bloqueActual = null;
  let lineasAgrupadas = [];

  const linesOut = (result.detalleTexto || '').split('\n');
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}, webhook ${webhookPath}`));
