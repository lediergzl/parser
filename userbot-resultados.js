// userbot-resultados.js
// ----------------------------------------------------------------------------
// Proceso INDEPENDIENTE (correr con `node userbot-resultados.js`, separado
// del bot de Telegraf). Usa una sesión de usuario real (MTProto vía GramJS)
// porque un bot normal NO puede recibir mensajes de otro bot en un canal.
//
// Qué hace:
//   1. Se conecta con la sesión generada por generar-session.js
//   2. Escucha mensajes nuevos de @boliterostop_bot (en el canal/grupo donde
//      publica, o en DM si te escribe en privado — ajusta CHATS_A_ESCUCHAR)
//   3. Parsea el texto del resultado → { loteriaNombre, sorteoNombre, fijo, corrido, centena }
//   4. Mapea loteriaNombre/sorteoNombre a tus loteria_id/sorteo_id reales
//   5. Inserta/actualiza en `resultados_sorteo` con fuente: 'bot_externo'
//   6. Llama la misma lógica de detección de premios que ya usa /resultado
//
// Requiere: npm install telegram @supabase/supabase-js
//
// ⚠️ PENDIENTE: parsearMensajeResultado() está sin terminar — necesito un
// mensaje real de @boliterostop_bot para escribir el regex correcto.
// Como está, SOLO loguea el texto crudo por consola para que puedas
// copiarlo y mandármelo; no inserta nada todavía (ver TODO más abajo).
// ----------------------------------------------------------------------------
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { createClient } = require('@supabase/supabase-js');
const { detectarPremios } = require('./premios.js');

const apiId = parseInt(process.env.TG_API_ID || '', 10);
const apiHash = process.env.TG_API_HASH || '';
const sessionString = process.env.TG_SESSION || '';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Usuario/canal cuyos mensajes nos interesan. Puede ser '@boliterostop_bot'
// directamente (si te escribe en DM) o el username/ID del canal/grupo donde
// publica (si ahí es donde lo viste).
const ORIGEN_ESPERADO = process.env.RESULTADOS_ORIGEN || '@boliterostop_bot';

// El bot mezcla inglés y español según la lotería ("Georgia - Night" vs
// "New York - Medio Día"), así que primero se normaliza el término a un
// concepto genérico (mediodia/tarde/noche) y luego cada lotería lo mapea a
// su sorteo real. Georgia tiene 3 sorteos; Florida y New York, 2 (sin
// "Tarde" — "evening"/"tarde" en esas dos cae en "Noche").
const TERMINO_GENERICO = {
  midday: 'mediodia', day: 'mediodia', noon: 'mediodia',
  'medio dia': 'mediodia', mediodia: 'mediodia', dia: 'mediodia',
  evening: 'tarde', tarde: 'tarde', atardecer: 'tarde',
  night: 'noche', noche: 'noche',
};

const CONCEPTO_A_SORTEO = {
  'florida':  { mediodia: 'Día', tarde: 'Noche', noche: 'Noche' },
  'new york': { mediodia: 'Día', tarde: 'Noche', noche: 'Noche' },
  'georgia':  { mediodia: 'Día', tarde: 'Tarde', noche: 'Noche' },
};

// El bot a veces usa caracteres Unicode invisibles/anchos raros para
// espaciar el texto (zero-width space, NBSP, etc.) que el .trim() normal de
// JS NO elimina — mismo patrón que ya existe en lotopro-core.bundle.js
// (normalizeSpaces). Sin esto, "New York" con un invisible pegado adelante
// nunca hace match exacto contra la fila real de la tabla loterias.
function limpiarInvisibles(s) {
  return String(s || '')
    .replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/g, '')
    .replace(/[\u00A0\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, ' ');
}

function normalizar(s) {
  return limpiarInvisibles(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const LOTERIA_DISPLAY = { florida: 'Florida', 'new york': 'New York', georgia: 'Georgia' };

// Busca si la secuencia de palabras `frase` (ej. "new york", "medio dia")
// aparece como tokens consecutivos dentro de `tokens`. Evita falsos positivos
// de substring (que "florida" nunca "contenga" "dia" por casualidad, etc.)
// porque compara token por token, no substring crudo.
function contieneSecuencia(tokens, frase) {
  const partes = frase.split(' ');
  for (let i = 0; i <= tokens.length - partes.length; i++) {
    if (partes.every((p, j) => tokens[i + j] === p)) return true;
  }
  return false;
}

// Cache simple en memoria para no consultar Supabase en cada mensaje.
const cacheLoteriaId = new Map(); // nombreNormalizado -> id
const cacheSorteoId  = new Map(); // `${loteriaId}::nombreNormalizado` -> id

function dumpCodePoints(s) {
  return Array.from(String(s || '')).map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
}

async function obtenerLoteriaId(nombre) {
  const key = normalizar(nombre);
  if (cacheLoteriaId.has(key)) return { id: cacheLoteriaId.get(key) };
  const { data, error } = await supabase.from('loterias').select('id').ilike('nombre', nombre).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: `no existe una lotería con nombre "${nombre}" [${dumpCodePoints(nombre)}] en la tabla loterias` };
  cacheLoteriaId.set(key, data.id);
  return { id: data.id };
}

async function obtenerSorteoId(loteriaId, nombreSorteo) {
  const key = `${loteriaId}::${normalizar(nombreSorteo)}`;
  if (cacheSorteoId.has(key)) return { id: cacheSorteoId.get(key) };
  const { data, error } = await supabase.from('sorteos').select('id')
    .eq('loteria_id', loteriaId).ilike('nombre', nombreSorteo).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: `no existe un sorteo "${nombreSorteo}" para loteria_id=${loteriaId} en la tabla sorteos` };
  cacheSorteoId.set(key, data.id);
  return { id: data.id };
}

// Consulta Supabase para loteriaNombre/nombreSorteo YA resueltos por
// parsearMensajeResultado. Devuelve { error: '<motivo>' } si algo no
// se puede mapear, para poder diagnosticar exactamente en qué paso falló
// (nunca un null mudo).
async function resolverLoteriaSorteo(loteriaNombre, nombreSorteo) {
  const loteria = await obtenerLoteriaId(loteriaNombre);
  if (loteria.error) return { error: `buscando lotería "${loteriaNombre}": ${loteria.error}` };
  const sorteo = await obtenerSorteoId(loteria.id, nombreSorteo);
  if (sorteo.error) return { error: `buscando sorteo "${nombreSorteo}": ${sorteo.error}` };

  return { loteriaId: loteria.id, sorteoId: sorteo.id };
}

// El bot usa formatos distintos según la lotería. Confirmados hasta ahora:
//
//   Georgia - Night                    FLORIDA
//   Fecha: 26/08/2026                  Noche
//   Pick 3: `536`                      Pick 3 ➪ 405 - 2
//   Pick 4: `3328`                     Pick 4 ➪ 6868 - 2
//
// En vez de asumir una estructura de líneas fija, se busca lotería/término/
// picks en CUALQUIER parte del texto, por tokens — así sirve para ambos
// formatos (y para variantes futuras) sin tener que parchear cada vez.
//
// Conversión (misma que usa el pipeline de boliteros.com en LotoPro):
//   centena = Pick 3 completo (3 dígitos)
//   fijo    = últimos 2 dígitos de Pick 3
//   corrido = últimos 2 dígitos de Pick 4
function parsearMensajeResultado(texto) {
  if (!texto) return null;
  texto = limpiarInvisibles(texto);
  const tokens = normalizar(texto).split(' ').filter(Boolean);

  let loteriaKey = null;
  for (const key of Object.keys(CONCEPTO_A_SORTEO)) {
    if (contieneSecuencia(tokens, key)) { loteriaKey = key; break; }
  }
  if (!loteriaKey) return null; // ninguna lotería conocida mencionada

  // Términos multi-palabra primero ("medio dia" antes que "dia" suelto).
  const terminos = Object.keys(TERMINO_GENERICO).sort((a, b) => b.split(' ').length - a.split(' ').length);
  let concepto = null;
  for (const term of terminos) {
    if (contieneSecuencia(tokens, term)) { concepto = TERMINO_GENERICO[term]; break; }
  }
  if (!concepto) return null; // ningún término de sorteo reconocido

  const nombreSorteo = CONCEPTO_A_SORTEO[loteriaKey][concepto];
  if (!nombreSorteo) return null; // esa lotería no tiene ese sorteo en el catálogo

  // \D*? (no-dígito, perezoso) salta cualquier separador (":", "➪", backtick,
  // espacios) hasta el primer número, sirve para ambos formatos por igual.
  const mPick3 = texto.match(/pick\s*3\D*?(\d{1,3})/i);
  const mPick4 = texto.match(/pick\s*4\D*?(\d{1,4})/i);
  if (!mPick3 && !mPick4) return null;

  const pick3 = mPick3 ? mPick3[1].padStart(3, '0') : null;
  const pick4 = mPick4 ? mPick4[1].padStart(4, '0') : null;

  const centena = pick3 || null;
  const fijo    = pick3 ? pick3.slice(-2) : null;
  const corrido = pick4 ? pick4.slice(-2) : null;

  let fecha = null;
  const mFecha = texto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mFecha) {
    const [, dd, mm, yyyy] = mFecha;
    fecha = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; // ISO yyyy-mm-dd
  }

  return { loteriaNombre: LOTERIA_DISPLAY[loteriaKey], nombreSorteo, fijo, corrido, centena, fecha };
}

async function guardarResultado({ loteriaId, sorteoId, fijo, corrido, centena, fecha }) {
  const fechaFinal = fecha || new Date().toISOString().slice(0, 10);
  const { data: resultado, error } = await supabase.from('resultados_sorteo')
    .upsert([{
      loteria_id: loteriaId, sorteo_id: sorteoId, fecha: fechaFinal,
      numero_ganado: { fijo, corrido, centena }, fuente: 'bot_externo',
    }], { onConflict: 'loteria_id,sorteo_id,fecha' })
    .select('*').single();

  if (error) { console.error('❌ Error guardando resultado:', error); return; }
  console.log(`✅ Resultado guardado: loteria=${loteriaId} sorteo=${sorteoId} fecha=${fechaFinal} fijo=${fijo} corrido=${corrido} centena=${centena}`);

  try {
    await detectarPremios(supabase, resultado);
    console.log('🔍 Detección de premios completada.');
  } catch (e) {
    console.error('⚠️ Error detectando premios:', e);
  }
}

async function crearClienteConectado() {
  if (!apiId || !apiHash || !sessionString) {
    console.warn('⚠️  Faltan TG_API_ID / TG_API_HASH / TG_SESSION.');
    return null;
  }
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  return client;
}

async function iniciarUserbotResultados() {
  const client = await crearClienteConectado();
  if (!client) {
    console.warn('    Corre generar-session.js una vez (localmente, con consola) y define esas 3 variables.');
    return; // nunca tumba el proceso principal por esto
  }
  global.__USERBOT_CLIENT__ = client; // reutilizable por comandos manuales (ej. /probar_resultado)
  try {
    const me = await client.getMe();
    console.log(`✅ Userbot conectado como ${me?.bot ? 'BOT ⚠️ (debería ser cuenta de usuario)' : 'usuario'}: @${me?.username || '?'} (id ${me?.id})`);
  } catch (e) {
    console.warn('⚠️ No se pudo verificar la identidad de la sesión del userbot:', e.message);
  }
  console.log('👂 Escuchando resultados de', ORIGEN_ESPERADO);

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.message) return;

      const remitente = await msg.getSender();
      const username = remitente?.username ? `@${remitente.username}` : null;
      if (username !== ORIGEN_ESPERADO) return;

      console.log('📩 Mensaje de', username, ':\n', msg.message, '\n---');

      const parsed = parsearMensajeResultado(msg.message);
      if (!parsed) {
        console.log('⚠️  No se pudo parsear (parser pendiente de completar). Texto crudo arriba ☝️');
        return;
      }

      const destino = await resolverLoteriaSorteo(parsed.loteriaNombre, parsed.nombreSorteo);
      if (destino.error) {
        console.log(`⚠️  No se pudo resolver lotería/sorteo para "${parsed.loteriaNombre} - ${parsed.nombreSorteo}": ${destino.error}`);
        return;
      }

      await guardarResultado({
        loteriaId: destino.loteriaId, sorteoId: destino.sorteoId,
        fijo: parsed.fijo, corrido: parsed.corrido, centena: parsed.centena,
        fecha: parsed.fecha,
      });
    } catch (e) {
      // Un error acá NUNCA debe tumbar el bot principal.
      console.error('❌ Error procesando mensaje de resultado:', e);
    }
  }, new NewMessage({}));
}

// Reusa el cliente YA conectado por iniciarUserbotResultados (no abre una
// segunda conexión con la misma sesión, eso puede provocar desconexiones).
// Pensado para dispararse manualmente, ej. desde un comando /probar_resultado.
async function buscarUltimoResultadoEnChat(chat) {
  const client = global.__USERBOT_CLIENT__;
  if (!client) {
    return { ok: false, message: 'El userbot no está conectado (revisa TG_API_ID / TG_API_HASH / TG_SESSION).' };
  }

  // Diagnóstico: confirmar que la sesión es una cuenta de USUARIO real, no
  // un bot — BOT_METHOD_INVALID en getMessages casi siempre significa que
  // la sesión terminó autenticada como bot en vez de como usuario.
  let me;
  try {
    me = await client.getMe();
  } catch (e) {
    return { ok: false, message: `No se pudo verificar la cuenta del userbot: ${e.message}` };
  }
  if (me?.bot) {
    return { ok: false, message: `⚠️ La sesión TG_SESSION está autenticada como BOT (@${me.username || '?'}), no como cuenta de usuario. Hay que regenerarla con generar-session.js usando el teléfono, no un token de bot.` };
  }

  let entity;
  try {
    entity = await client.getEntity(chat);
  } catch (e) {
    return { ok: false, message: `No se pudo acceder a "${chat}". ¿La cuenta del userbot está unida a ese grupo? (${e.message})` };
  }

  const mensajes = await client.getMessages(entity, { limit: 50 });  let encontrado = null;
  for (const msg of mensajes) { // del más reciente al más viejo
    if (!msg.message) continue;
    const remitente = await msg.getSender();
    const username = remitente?.username ? `@${remitente.username}` : null;
    if (username === ORIGEN_ESPERADO) { encontrado = msg; break; }
  }
  if (!encontrado) {
    return { ok: false, message: `No encontré ningún mensaje de ${ORIGEN_ESPERADO} en los últimos 50 mensajes de "${chat}".` };
  }

  const parsed = parsearMensajeResultado(encontrado.message);
  if (!parsed) return { ok: false, message: 'No se pudo parsear ese mensaje con el formato esperado.', texto: encontrado.message };

  const destino = await resolverLoteriaSorteo(parsed.loteriaNombre, parsed.nombreSorteo);
  if (destino.error) return { ok: false, message: `No se pudo resolver lotería/sorteo para "${parsed.loteriaNombre} - ${parsed.nombreSorteo}": ${destino.error}`, texto: encontrado.message, parsed };

  await guardarResultado({
    loteriaId: destino.loteriaId, sorteoId: destino.sorteoId,
    fijo: parsed.fijo, corrido: parsed.corrido, centena: parsed.centena, fecha: parsed.fecha,
  });

  return { ok: true, texto: encontrado.message, parsed, destino };
}

module.exports = {
  iniciarUserbotResultados,
  crearClienteConectado,
  buscarUltimoResultadoEnChat,
  parsearMensajeResultado,
  resolverLoteriaSorteo,
  guardarResultado,
  ORIGEN_ESPERADO,
};

// Permite seguir usándolo como script independiente (`node userbot-resultados.js`)
// además de requerirlo desde bet-bootstrap.js o desde test-ultimo-resultado.js.
if (require.main === module) {
  iniciarUserbotResultados().catch(e => { console.error('❌ Userbot no pudo iniciar:', e); });
}

