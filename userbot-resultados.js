// userbot-resultados.js
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { createClient } = require('@supabase/supabase-js');
const { detectarPremios } = require('./premios.js');

const apiId = parseInt(process.env.TG_API_ID || '', 10);
const apiHash = process.env.TG_API_HASH || '';
const sessionString = process.env.TG_SESSION || '';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ORIGEN_ESPERADO = process.env.RESULTADOS_ORIGEN || '@boliterostop_bot';

const TERMINO_GENERICO = {
  midday: 'mediodia', day: 'mediodia', noon: 'mediodia',
  'medio dia': 'mediodia', mediodia: 'mediodia', dia: 'mediodia',
  evening: 'tarde', tarde: 'tarde', atardecer: 'tarde',
  night: 'noche', noche: 'noche',
};

const CONCEPTO_A_SORTEO = {
  florida: { mediodia: 'Día', tarde: 'Noche', noche: 'Noche' },
  'new york': { mediodia: 'Día', tarde: 'Noche', noche: 'Noche' },
  georgia: { mediodia: 'Día', tarde: 'Tarde', noche: 'Noche' },
};

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

function separarLoteriaYTermino(claveLinea) {
  let limpio = limpiarInvisibles(claveLinea).trim();
  limpio = limpio.replace(/^[^\p{L}\p{N}]*/u, '').trim();
  const m = limpio.match(/^(.+?)\s*-\s*(.+)$/u);
  if (!m) return { loteriaNombre: limpio, termino: null };
  const loteriaNombre = m[1].replace(/^[^\p{L}\p{N}]*/u, '').trim();
  const termino = m[2].replace(/[^\p{L}\p{N}]*(?=\s*$)/u, '').trim();
  return { loteriaNombre, termino };
}

const cacheLoteriaId = new Map();
const cacheSorteoId = new Map();

function dumpCodePoints(s) {
  return Array.from(String(s || '')).map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
}

async function obtenerLoteriaId(nombre) {
  const key = normalizar(nombre);
  if (cacheLoteriaId.has(key)) return { id: cacheLoteriaId.get(key) };
  const { data, error } = await supabase.from('loterias').select('id').ilike('nombre', nombre).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: `no existe una lotería con nombre "${nombre}" [${dumpCodePoints(nombre)}] en la tabla loterias`, noExiste: true };
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

async function resolverLoteriaSorteo(claveLinea) {
  const { loteriaNombre, termino } = separarLoteriaYTermino(claveLinea);
  if (!loteriaNombre || !termino) return { error: `no se pudo separar lotería/término de "${claveLinea}"` };

  // PRIMER FILTRO: la lotería debe existir en la BD. Si no existe,
  // el resultado externo se ignora y no se parsea ni se guarda.
  const loteria = await obtenerLoteriaId(loteriaNombre);
  if (loteria.error) {
    if (loteria.noExiste) return { ignorar: true };
    return { error: `buscando lotería "${loteriaNombre}": ${loteria.error}` };
  }

  const loteriaKey = normalizar(loteriaNombre);
  const dict = CONCEPTO_A_SORTEO[loteriaKey];
  if (!dict) return { error: `la lotería "${loteriaNombre}" existe en BD pero no tiene configuración de sorteos` };
  const conceptoKey = normalizar(termino);
  const concepto = TERMINO_GENERICO[conceptoKey];
  if (!concepto) return { error: `término "${termino}" (normalizado "${conceptoKey}") no está en TERMINO_GENERICO` };
  const nombreSorteo = dict[concepto];
  if (!nombreSorteo) return { error: `"${loteriaKey}" no tiene sorteo mapeado para el concepto "${concepto}"` };
  const sorteo = await obtenerSorteoId(loteria.id, nombreSorteo);
  if (sorteo.error) return { error: `buscando sorteo "${nombreSorteo}": ${sorteo.error}` };
  return { loteriaId: loteria.id, sorteoId: sorteo.id };
}

function parsearMensajeResultado(texto) {
  if (!texto) return null;
  texto = limpiarInvisibles(texto);
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lineas.length) return null;
  const mPick3 = texto.match(/pick\s*3\s*:?\s*`?(\d{1,3})`?/i);
  const mPick4 = texto.match(/pick\s*4\s*:?\s*`?(\d{1,4})`?/i);
  if (!mPick3 && !mPick4) return null;
  const pick3 = mPick3 ? mPick3[1].padStart(3, '0') : null;
  const pick4 = mPick4 ? mPick4[1].padStart(4, '0') : null;
  const centena = pick3 || null;
  const fijo = pick3 ? pick3.slice(-2) : null;
  const corrido = pick4 ? pick4.slice(-2) : null;
  let fecha = null;
  const mFecha = texto.match(/fecha\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (mFecha) {
    const [, dd, mm, yyyy] = mFecha;
    fecha = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return { clave: lineas[0], fijo, corrido, centena, fecha };
}

async function guardarResultado({ loteriaId, sorteoId, fijo, corrido, centena, fecha }) {
  const fechaFinal = fecha || new Date().toISOString().slice(0, 10);
  const { data: resultado, error } = await supabase.from('resultados_sorteo').upsert([{
    loteria_id: loteriaId, sorteo_id: sorteoId, fecha: fechaFinal,
    numero_ganado: { fijo, corrido, centena }, fuente: 'bot_externo',
  }], { onConflict: 'loteria_id,sorteo_id,fecha' }).select('*').single();
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
    return;
  }
  global.__USERBOT_CLIENT__ = client;
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

      // El primer renglón identifica la lotería. La consultamos en BD ANTES
      // de hacer cualquier parseo del resultado. Las loterías no registradas
      // se ignoran completamente.
      const texto = limpiarInvisibles(msg.message);
      const primeraLinea = texto.split('\n').map(l => l.trim()).find(Boolean) || '';
      const destino = await resolverLoteriaSorteo(primeraLinea);
      if (destino.ignorar) {
        console.log(`⏭️ Resultado ignorado: la lotería de "${primeraLinea}" no existe en la BD.`);
        return;
      }
      if (destino.error) {
        console.log(`⚠️ No se pudo resolver lotería/sorteo para "${primeraLinea}": ${destino.error}`);
        return;
      }

      console.log('📩 Resultado aceptado de', username, ':\n', msg.message, '\n---');
      const parsed = parsearMensajeResultado(texto);
      if (!parsed) {
        console.log('⚠️ No se pudo parsear el resultado de una lotería registrada.');
        return;
      }
      await guardarResultado({ loteriaId: destino.loteriaId, sorteoId: destino.sorteoId, fijo: parsed.fijo, corrido: parsed.corrido, centena: parsed.centena, fecha: parsed.fecha });
    } catch (e) {
      console.error('❌ Error procesando mensaje de resultado:', e);
    }
  }, new NewMessage({}));
}

async function buscarUltimoResultadoEnChat(chat) {
  const client = global.__USERBOT_CLIENT__;
  if (!client) return { ok: false, message: 'El userbot no está conectado (revisa TG_API_ID / TG_API_HASH / TG_SESSION).' };
  let me;
  try { me = await client.getMe(); } catch (e) { return { ok: false, message: `No se pudo verificar la cuenta del userbot: ${e.message}` }; }
  if (me?.bot) return { ok: false, message: `⚠️ La sesión TG_SESSION está autenticada como BOT (@${me.username || '?'}), no como cuenta de usuario. Hay que regenerarla con generar-session.js usando el teléfono, no un token de bot.` };
  let entity;
  try { entity = await client.getEntity(chat); } catch (e) { return { ok: false, message: `No se pudo acceder a "${chat}". ¿La cuenta del userbot está unida a ese grupo? (${e.message})` }; }
  const mensajes = await client.getMessages(entity, { limit: 50 });
  let encontrado = null;
  for (const msg of mensajes) {
    if (!msg.message) continue;
    const remitente = await msg.getSender();
    const username = remitente?.username ? `@${remitente.username}` : null;
    if (username === ORIGEN_ESPERADO) { encontrado = msg; break; }
  }
  if (!encontrado) return { ok: false, message: `No encontré ningún mensaje de ${ORIGEN_ESPERADO} en los últimos 50 mensajes de "${chat}".` };
  const texto = limpiarInvisibles(encontrado.message);
  const primeraLinea = texto.split('\n').map(l => l.trim()).find(Boolean) || '';
  const destino = await resolverLoteriaSorteo(primeraLinea);
  if (destino.ignorar) return { ok: false, message: `La lotería de "${primeraLinea}" no existe en la BD; resultado ignorado.` };
  if (destino.error) return { ok: false, message: `No se pudo resolver lotería/sorteo para "${primeraLinea}": ${destino.error}`, texto: encontrado.message };
  const parsed = parsearMensajeResultado(texto);
  if (!parsed) return { ok: false, message: 'No se pudo parsear ese mensaje con el formato esperado.', texto: encontrado.message };
  await guardarResultado({ loteriaId: destino.loteriaId, sorteoId: destino.sorteoId, fijo: parsed.fijo, corrido: parsed.corrido, centena: parsed.centena, fecha: parsed.fecha });
  return { ok: true, texto: encontrado.message, parsed, destino };
}

module.exports = { iniciarUserbotResultados, crearClienteConectado, buscarUltimoResultadoEnChat, parsearMensajeResultado, resolverLoteriaSorteo, guardarResultado, ORIGEN_ESPERADO };

if (require.main === module) {
  iniciarUserbotResultados().catch(e => { console.error('❌ Userbot no pudo iniciar:', e); });
}
