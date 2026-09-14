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

// Términos en inglés que usa @boliterostop_bot → nombre del sorteo en tu
// catálogo (Día/Tarde/Noche). Georgia tiene 3 sorteos; Florida y New York, 2.
// Las claves se comparan ya normalizadas (minúsculas, sin acentos).
const TERMINO_A_SORTEO = {
  'florida':  { midday: 'Día', day: 'Día', evening: 'Noche', night: 'Noche' },
  'new york': { midday: 'Día', day: 'Día', evening: 'Noche', night: 'Noche' },
  'georgia':  { midday: 'Día', day: 'Día', evening: 'Tarde', night: 'Noche' },
};

function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "Georgia - Night" -> { loteriaNombre: "Georgia", termino: "Night" }
function separarLoteriaYTermino(claveLinea) {
  const m = claveLinea.match(/^(.+?)\s*-\s*(.+)$/);
  if (!m) return { loteriaNombre: claveLinea.trim(), termino: null };
  return { loteriaNombre: m[1].trim(), termino: m[2].trim() };
}

// Cache simple en memoria para no consultar Supabase en cada mensaje.
const cacheLoteriaId = new Map(); // nombreNormalizado -> id
const cacheSorteoId  = new Map(); // `${loteriaId}::nombreNormalizado` -> id

async function obtenerLoteriaId(nombre) {
  const key = normalizar(nombre);
  if (cacheLoteriaId.has(key)) return cacheLoteriaId.get(key);
  const { data, error } = await supabase.from('loterias').select('id').ilike('nombre', nombre).maybeSingle();
  if (error || !data) return null;
  cacheLoteriaId.set(key, data.id);
  return data.id;
}

async function obtenerSorteoId(loteriaId, nombreSorteo) {
  const key = `${loteriaId}::${normalizar(nombreSorteo)}`;
  if (cacheSorteoId.has(key)) return cacheSorteoId.get(key);
  const { data, error } = await supabase.from('sorteos').select('id')
    .eq('loteria_id', loteriaId).ilike('nombre', nombreSorteo).maybeSingle();
  if (error || !data) return null;
  cacheSorteoId.set(key, data.id);
  return data.id;
}

// Resuelve "Georgia - Night" -> { loteriaId, sorteoId } consultando Supabase.
// Devuelve null si la lotería, el término o el sorteo no se pueden mapear.
async function resolverLoteriaSorteo(claveLinea) {
  const { loteriaNombre, termino } = separarLoteriaYTermino(claveLinea);
  if (!loteriaNombre || !termino) return null;

  const loteriaKey = normalizar(loteriaNombre);
  const dict = TERMINO_A_SORTEO[loteriaKey];
  if (!dict) return null; // lotería no está en el catálogo que conocemos

  const nombreSorteo = dict[normalizar(termino)];
  if (!nombreSorteo) return null; // término desconocido para esa lotería

  const loteriaId = await obtenerLoteriaId(loteriaNombre);
  if (!loteriaId) return null;
  const sorteoId = await obtenerSorteoId(loteriaId, nombreSorteo);
  if (!sorteoId) return null;

  return { loteriaId, sorteoId };
}

// Ejemplo real de @boliterostop_bot:
//
//   Georgia - Night
//   Fecha: 26/08/2026
//   Pick 3: `536`
//   Pick 4: `3328`
//   [@boliterostop_bot](https://t.me/boliterostop_bot)
//
// Conversión (misma que usa el pipeline de boliteros.com en LotoPro):
//   centena = Pick 3 completo (3 dígitos)
//   fijo    = últimos 2 dígitos de Pick 3
//   corrido = últimos 2 dígitos de Pick 4
function parsearMensajeResultado(texto) {
  if (!texto) return null;
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lineas.length) return null;

  const mPick3 = texto.match(/pick\s*3\s*:?\s*`?(\d{1,3})`?/i);
  const mPick4 = texto.match(/pick\s*4\s*:?\s*`?(\d{1,4})`?/i);
  if (!mPick3 && !mPick4) return null; // no es un mensaje de resultado reconocible

  const pick3 = mPick3 ? mPick3[1].padStart(3, '0') : null;
  const pick4 = mPick4 ? mPick4[1].padStart(4, '0') : null;

  const centena = pick3 || null;
  const fijo    = pick3 ? pick3.slice(-2) : null;
  const corrido = pick4 ? pick4.slice(-2) : null;

  let fecha = null;
  const mFecha = texto.match(/fecha\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (mFecha) {
    const [, dd, mm, yyyy] = mFecha;
    fecha = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; // ISO yyyy-mm-dd
  }

  // La primera línea no vacía es el nombre de lotería/sorteo, ej. "Georgia - Night"
  return { clave: lineas[0], fijo, corrido, centena, fecha };
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

(async () => {
  if (!apiId || !apiHash || !sessionString) {
    console.error('❌ Faltan TG_API_ID / TG_API_HASH / TG_SESSION. Corre primero generar-session.js.');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  console.log('✅ Userbot conectado, escuchando resultados...');

  client.addEventHandler(async (event) => {
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

    const destino = await resolverLoteriaSorteo(parsed.clave);
    if (!destino) {
      console.log(`⚠️  No se pudo resolver lotería/sorteo para "${parsed.clave}". Revisa TERMINO_A_SORTEO o que exista en tu catálogo.`);
      return;
    }

    await guardarResultado({
      loteriaId: destino.loteriaId, sorteoId: destino.sorteoId,
      fijo: parsed.fijo, corrido: parsed.corrido, centena: parsed.centena,
      fecha: parsed.fecha,
    });
  }, new NewMessage({}));
})();
