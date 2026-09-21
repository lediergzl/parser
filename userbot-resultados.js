// userbot-resultados.js
// ----------------------------------------------------------------------------
// Userbot MTProto que escucha los resultados publicados por @boliterostop_bot.
// Guarda el resultado en Supabase, ejecuta la detección de premios y avisa a
// los administradores mediante el bot normal de Telegraf.
// ----------------------------------------------------------------------------
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { createClient } = require('@supabase/supabase-js');
const { detectarPremios } = require('./premios.js');
const bus = require('./lib/event-bus');

const apiId = parseInt(process.env.TG_API_ID || '', 10);
const apiHash = process.env.TG_API_HASH || '';
const sessionString = process.env.TG_SESSION || '';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ORIGEN_ESPERADO = process.env.RESULTADOS_ORIGEN || '@boliterostop_bot';
const CHATS_RESULTADOS = Array.from(new Set(
  (process.env.RESULTADOS_CHATS || ORIGEN_ESPERADO)
    .split(',').map(x => x.trim()).filter(Boolean)
    .concat(ORIGEN_ESPERADO)
));
const TZ_CUBA = 'America/Havana';

const TERMINO_GENERICO = {
  midday: 'mediodia',
  day: 'mediodia',
  noon: 'mediodia',
  'medio dia': 'mediodia',
  mediodia: 'mediodia',
  dia: 'mediodia',
  evening: 'tarde',
  tarde: 'tarde',
  atardecer: 'tarde',
  night: 'noche',
  noche: 'noche',
  morning: 'manana',
  manana: 'manana',
};

const CONCEPTO_A_SORTEO = {
  florida: { mediodia: 'Día', tarde: 'Noche', noche: 'Noche' },
  'new york': { mediodia: 'Día', tarde: 'Noche', noche: 'Noche' },
  georgia: { mediodia: 'Día', tarde: 'Tarde', noche: 'Noche' },
  tennessee: { manana: 'Morning', mediodia: 'Day', tarde: 'Evening', noche: 'Night' },
};

const LOTERIA_DISPLAY = {
  florida: 'Florida',
  'new york': 'New York',
  georgia: 'Georgia',
  tennessee: 'Tennessee',
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

function contieneSecuencia(tokens, frase) {
  const partes = frase.split(' ');
  for (let i = 0; i <= tokens.length - partes.length; i++) {
    if (partes.every((p, j) => tokens[i + j] === p)) return true;
  }
  return false;
}

const cacheLoteriaId = new Map();
const cacheSorteoId = new Map();

function dumpCodePoints(s) {
  return Array.from(String(s || ''))
    .map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');
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

async function resolverLoteriaSorteo(loteriaNombre, nombreSorteo) {
  const loteria = await obtenerLoteriaId(loteriaNombre);
  if (loteria.error) return { error: `buscando lotería "${loteriaNombre}": ${loteria.error}` };
  const sorteo = await obtenerSorteoId(loteria.id, nombreSorteo);
  if (sorteo.error) return { error: `buscando sorteo "${nombreSorteo}": ${sorteo.error}` };
  return { loteriaId: loteria.id, sorteoId: sorteo.id };
}

function extraerNumero(texto, tipo) {
  const re = new RegExp(`(?:${tipo})\\s*(?:3|4)?\\s*(?:[:=\\-]|=>)?\\s*(\\d{${tipo === 'pick3' ? 3 : 4}})(?!\\d)`, 'i');
  const m = texto.match(re);
  return m ? m[1] : null;
}

function parsearMensajeResultado(texto) {
  if (!texto) return null;
  texto = limpiarInvisibles(texto);
  const normalizado = normalizar(texto);
  const tokens = normalizado.split(' ').filter(Boolean);

  let loteriaKey = null;
  for (const key of Object.keys(CONCEPTO_A_SORTEO)) {
    if (contieneSecuencia(tokens, key)) { loteriaKey = key; break; }
  }
  if (!loteriaKey) return null;

  const terminos = Object.keys(TERMINO_GENERICO).sort((a, b) => b.split(' ').length - a.split(' ').length);
  let concepto = null;
  for (const term of terminos) {
    if (contieneSecuencia(tokens, term)) { concepto = TERMINO_GENERICO[term]; break; }
  }
  if (!concepto) return null;

  const nombreSorteo = CONCEPTO_A_SORTEO[loteriaKey][concepto];
  if (!nombreSorteo) return null;

  const mPick3 = texto.match(/pick\s*3\s*(?:[:=\-]|=>)?\s*(\d{3})(?!\d)/i);
  const mPick4 = texto.match(/pick\s*4\s*(?:[:=\-]|=>)?\s*(\d{4})(?!\d)/i);
  if (!mPick3 && !mPick4) return null;

  const pick3 = mPick3 ? mPick3[1] : null;
  const pick4 = mPick4 ? mPick4[1] : null;
  const centena = pick3 || null;
  const fijo = pick3 ? pick3.slice(-2) : null;
  const corrido = pick4 ? [pick4.slice(0, 2), pick4.slice(2, 4)] : [];

  const fecha = parsearFechaTexto(texto, new Date());

  return { loteriaNombre: LOTERIA_DISPLAY[loteriaKey], nombreSorteo, fijo, corrido, centena, fecha };
}

function fechaCubaDe(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_CUBA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function fechaActualCuba() {
  return fechaCubaDe(new Date());
}

function parsearFechaTexto(texto, referencia = new Date()) {
  const s = limpiarInvisibles(texto);
  const candidatos = [];

  const iso = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    candidatos.push(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }

  const m = s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    // Las publicaciones de las loterías de EE. UU. usan normalmente MM/DD.
    if (a <= 12) candidatos.push(new Date(y, a - 1, b));
    if (b <= 12) candidatos.push(new Date(y, b - 1, a));
  }

  const ref = referencia instanceof Date ? referencia : new Date(referencia);
  const refMs = ref.getTime();
  const validos = candidatos.filter(d =>
    !Number.isNaN(d.getTime()) && Math.abs(d.getTime() - refMs) <= 7 * 86400000
  );
  if (validos.length) {
    validos.sort((x, y) => Math.abs(x.getTime() - refMs) - Math.abs(y.getTime() - refMs));
    return validos[0].toISOString().slice(0, 10);
  }

  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
  return null;
}

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
}

async function anunciarResultadoAAdmins({ loteriaNombre, nombreSorteo, fecha, fijo, corrido, centena, ganadores, registrados }) {
  const bot = global.__LOTO_BOT__;
  const adminIds = getAdminIds();
  if (!bot?.telegram?.sendMessage || adminIds.length === 0) {
    console.warn('⚠️ No se pudo anunciar el resultado a los admins (bot o ADMIN_IDS no disponibles).');
    return;
  }

  const corridoTexto = Array.isArray(corrido) ? corrido.join(', ') : String(corrido || '—');
  const texto = [
    '🎲 *Resultado recibido*', '',
    `🎰 Lotería: *${loteriaNombre}*`,
    `🕒 Sorteo: *${nombreSorteo}*`,
    `📅 Fecha: *${fecha}*`, '',
    `Fijo: *${fijo || '—'}*`,
    `Corridos: *${corridoTexto}*`,
    `Centena: *${centena || '—'}*`, '',
    ganadores > 0
      ? `🏆 Ganadores detectados: *${ganadores}* (premios nuevos: ${registrados})`
      : '✅ Sin jugadas ganadoras en este sorteo.'
  ].join('\n');

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, texto, { parse_mode: 'Markdown' });
      console.log(`📤 Resultado enviado al bot de Telegram/admin ${adminId}.`);
    } catch (e) {
      console.error(`❌ No se pudo anunciar el resultado al admin ${adminId}:`, e?.message || e);
    }
  }
}

const resultadosAnunciados = new Set();
const mensajesProcesados = new Set();
let sincronizacionResultadosEnCurso = false;
let temporizadorSincronizacionResultados = null;

function normalizarNumeroGanado(n) {
  const corrido = Array.isArray(n?.corrido) ? n.corrido.map(String) : [];
  return {
    fijo: n?.fijo == null ? null : String(n.fijo),
    corrido,
    centena: n?.centena == null ? null : String(n.centena),
  };
}

function numerosResultadoIguales(a, b) {
  const x = normalizarNumeroGanado(a);
  const y = normalizarNumeroGanado(b);
  return x.fijo === y.fijo &&
    x.centena === y.centena &&
    x.corrido.length === y.corrido.length &&
    x.corrido.every((v, i) => v === y.corrido[i]);
}

async function buscarResultadoExistente(loteriaId, sorteoId, fecha) {
  const { data, error } = await supabase.from('resultados_sorteo')
    .select('*')
    .eq('loteria_id', loteriaId)
    .eq('sorteo_id', sorteoId)
    .eq('fecha', fecha)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function guardarResultado({ loteriaNombre, nombreSorteo, loteriaId, sorteoId, fijo, corrido, centena, fecha }) {
  const fechaFinal = fecha || fechaActualCuba();
  const numeroGanado = normalizarNumeroGanado({ fijo, corrido, centena });

  let existente;
  try {
    existente = await buscarResultadoExistente(loteriaId, sorteoId, fechaFinal);
  } catch (e) {
    console.error('❌ Error consultando resultado existente:', e);
    return { ok: false, error: e };
  }

  const esMismoResultado = existente && numerosResultadoIguales(existente.numero_ganado, numeroGanado);
  let resultado = existente;
  let nuevo = false;

  if (!esMismoResultado) {
    const { data, error } = await supabase.from('resultados_sorteo')
      .upsert([{
        loteria_id: loteriaId,
        sorteo_id: sorteoId,
        fecha: fechaFinal,
        numero_ganado: numeroGanado,
        fuente: 'bot_externo',
      }], { onConflict: 'loteria_id,sorteo_id,fecha' })
      .select('*').single();

    if (error) {
      console.error('❌ Error guardando resultado:', error);
      return { ok: false, error };
    }

    resultado = data;
    nuevo = !existente;
    console.log(`✅ Resultado guardado/actualizado: loteria=${loteriaId} sorteo=${sorteoId} fecha=${fechaFinal} fijo=${fijo} corrido=${corrido.join(', ')} centena=${centena}`);
  } else {
    console.log(`ℹ️ Resultado ya estaba registrado: loteria=${loteriaId} sorteo=${sorteoId} fecha=${fechaFinal}.`);
  }

  if (!resultado) return { ok: false, error: new Error('Supabase no devolvió el resultado guardado.') };

  if (!esMismoResultado && !resultadosAnunciados.has(resultado.id)) {
    resultadosAnunciados.add(resultado.id);
    const payload = {
      resultadoId: resultado.id,
      loteriaNombre,
      nombreSorteo,
      fecha: fechaFinal,
      fijo,
      corrido,
      centena,
      loteriaId,
      sorteoId,
    };
    // El evento de RESULTADO es independiente de PREMIOS.
    // Se emite después de persistir el resultado para que WhatsApp pueda
    // guardarlo en su outbox persistente.
    bus.emit('resultado:recibido', payload);
    await anunciarResultadoAAdmins(payload);
  }

  try {
    const resumen = await detectarPremios(supabase, resultado);
    console.log(
      '🔍 Detección de premios completada: ' +
      (resumen?.ganadores?.length || 0) + ' ganador(es), ' +
      (resumen?.registrados?.length || 0) + ' premio(s) nuevo(s).'
    );
  } catch (e) {
    console.error('⚠️ Error detectando premios:', e);
  }

  return { ok: true, nuevo, resultado };
}

async function procesarMensajeResultado(msg, origen = 'evento', idOrigen = null) {
  if (!msg?.message) return false;

  const chatId = msg?.chatId != null
    ? String(msg.chatId)
    : String(msg?.peerId?.channelId ?? msg?.peerId?.chatId ?? '');
  const mensajeId = msg.id != null ? `${chatId}:${msg.id}` : null;
  if (mensajeId && mensajesProcesados.has(mensajeId)) return false;

  const parsed = parsearMensajeResultado(msg.message);
  if (!parsed) return false;

  if (idOrigen != null) {
    try {
      const remitente = await msg.getSender();
      const senderId = remitente?.id != null ? String(remitente.id) : null;
      const username = remitente?.username ? `@${remitente.username}` : null;
      if (senderId !== String(idOrigen) && username !== ORIGEN_ESPERADO) return false;
    } catch (_) {
      return false;
    }
  }

  console.log(`📩 Resultado recibido/recuperado desde ${ORIGEN_ESPERADO} [${origen}]`);
  console.log(msg.message);
  console.log('✅ Resultado reconocido:', JSON.stringify(parsed));

  const destino = await resolverLoteriaSorteo(parsed.loteriaNombre, parsed.nombreSorteo);
  if (destino.error) {
    console.log(`⚠️ No se pudo resolver lotería/sorteo para "${parsed.loteriaNombre} - ${parsed.nombreSorteo}": ${destino.error}`);
    return false;
  }

  const guardado = await guardarResultado({
    loteriaNombre: parsed.loteriaNombre,
    nombreSorteo: parsed.nombreSorteo,
    loteriaId: destino.loteriaId,
    sorteoId: destino.sorteoId,
    fijo: parsed.fijo,
    corrido: parsed.corrido,
    centena: parsed.centena,
    fecha: parsed.fecha,
  });

  // Solo marcar el mensaje como procesado después de que Supabase confirme.
  if (!guardado?.ok) return false;
  if (mensajeId) mensajesProcesados.add(mensajeId);
  return true;
}

async function sincronizarResultadosRecientes(entidades) {
  if (!entidades?.length || sincronizacionResultadosEnCurso) return;
  sincronizacionResultadosEnCurso = true;

  try {
    let reconocidos = 0;
    for (const item of entidades) {
      const mensajes = await global.__USERBOT_CLIENT__.getMessages(item.entity, { limit: 150 });

      for (const msg of [...mensajes].reverse()) {
        if (!msg?.message) continue;

        const fechaMsg = msg.date instanceof Date
          ? msg.date
          : (msg.date ? new Date(msg.date * 1000) : null);

        if (fechaMsg && (Date.now() - fechaMsg.getTime()) > 36 * 60 * 60 * 1000) continue;
        if (fechaMsg && (Date.now() - fechaMsg.getTime()) < -10 * 60 * 1000) continue;

        try {
          if (await procesarMensajeResultado(msg, 'sincronización', item.id)) reconocidos++;
        } catch (e) {
          console.error('❌ Error recuperando un mensaje de resultado:', e?.stack || e);
        }
      }
    }

    if (reconocidos > 0) console.log(`🔄 Sincronización: ${reconocidos} resultado(s) recuperado(s).`);
  } catch (e) {
    console.error('⚠️ No se pudo sincronizar resultados recientes desde Telegram:', e?.stack || e);
  } finally {
    sincronizacionResultadosEnCurso = false;
  }
}

async function crearClienteConectado() {
  if (!apiId || !apiHash || !sessionString) {
    console.warn('⚠️ Faltan TG_API_ID / TG_API_HASH / TG_SESSION.');
    return null;
  }
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );
  await client.connect();
  return client;
}

async function iniciarUserbotResultados() {
  const client = await crearClienteConectado();
  if (!client) {
    console.warn('   Corre generar-session.js una vez (localmente, con consola) y define esas 3 variables.');
    return;
  }

  global.__USERBOT_CLIENT__ = client;

  const entidadesResultados = [];
  for (const chat of CHATS_RESULTADOS) {
    try {
      const entidad = await client.getEntity(chat);
      let idOrigen = null;
      try {
        const origen = await client.getEntity(ORIGEN_ESPERADO);
        idOrigen = origen?.id != null ? String(origen.id) : null;
      } catch (_) {}

      entidadesResultados.push({ entity: entidad, id: idOrigen });
      console.log(`🎯 Chat de resultados resuelto: ${chat}${idOrigen ? ` | origen ${ORIGEN_ESPERADO} id ${idOrigen}` : ''}`);
    } catch (e) {
      console.error(`❌ No se pudo resolver el chat de resultados ${chat}:`, e?.message || e);
    }
  }

  try {
    const me = await client.getMe();
    console.log(`✅ Userbot conectado como ${me?.bot ? 'BOT ⚠️ (debería ser cuenta de usuario)' : 'usuario'}: @${me?.username || '?'} (id ${me?.id})`);
  } catch (e) {
    console.warn('⚠️ No se pudo verificar la identidad de la sesión del userbot:', e.message);
  }

  console.log('👂 Escuchando resultados en:', CHATS_RESULTADOS.join(', '));

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.message) return;

      const chatId = msg?.chatId != null ? String(msg.chatId) : String(msg?.peerId?.channelId ?? msg?.peerId?.chatId ?? '');
      const pertenece = entidadesResultados.some(item =>
        item.entity?.id != null && String(item.entity.id) === chatId
      );
      if (!pertenece) return;

      await procesarMensajeResultado(msg, 'evento', entidadesResultados.find(item =>
        item.entity?.id != null && String(item.entity.id) === chatId
      )?.id);
    } catch (e) {
      console.error('❌ Error procesando mensaje de resultado:', e && e.stack ? e.stack : e);
    }
  }, new NewMessage({}));

  await sincronizarResultadosRecientes(entidadesResultados);
  temporizadorSincronizacionResultados = setInterval(() => {
    sincronizarResultadosRecientes(entidadesResultados).catch(e =>
      console.error('⚠️ Error en sincronización programada de resultados:', e?.stack || e)
    );
  }, 30 * 1000);
  if (temporizadorSincronizacionResultados.unref) temporizadorSincronizacionResultados.unref();

  console.log('🔄 Recuperación automática de resultados activa cada 30 segundos.');
}

async function buscarUltimoResultadoEnChat(chat) {
  const client = global.__USERBOT_CLIENT__;
  if (!client) {
    return { ok: false, message: 'El userbot no está conectado (revisa TG_API_ID / TG_API_HASH / TG_SESSION).' };
  }

  let me;
  try {
    me = await client.getMe();
  } catch (e) {
    return { ok: false, message: `No se pudo verificar la cuenta del userbot: ${e.message}` };
  }
  if (me?.bot) {
    return { ok: false, message: `⚠️ La sesión TG_SESSION está autenticada como BOT (@${me.username || '?'}) , no como cuenta de usuario. Hay que regenerarla con generar-session.js usando el teléfono, no un token de bot.` };
  }

  let entity;
  try {
    entity = await client.getEntity(chat);
  } catch (e) {
    return { ok: false, message: `No se pudo acceder a "${chat}". ¿La cuenta del userbot está unida a ese grupo? (${e.message})` };
  }

  const mensajes = await client.getMessages(entity, { limit: 50 });
  let encontrado = null;
  for (const msg of mensajes) {
    if (!msg.message) continue;
    const remitente = await msg.getSender();
    const username = remitente?.username ? `@${remitente.username}` : null;
    if (username !== ORIGEN_ESPERADO) continue;
    if (!parsearMensajeResultado(msg.message)) continue;
    encontrado = msg;
    break;
  }

  if (!encontrado) {
    return { ok: false, message: `No encontré ningún mensaje de resultado válido de ${ORIGEN_ESPERADO} en los últimos 50 mensajes de "${chat}".` };
  }

  const parsed = parsearMensajeResultado(encontrado.message);
  if (!parsed) return { ok: false, message: 'No se pudo parsear ese mensaje con el formato esperado.', texto: encontrado.message };

  const destino = await resolverLoteriaSorteo(parsed.loteriaNombre, parsed.nombreSorteo);
  if (destino.error) return { ok: false, message: `No se pudo resolver lotería/sorteo para "${parsed.loteriaNombre} - ${parsed.nombreSorteo}": ${destino.error}`, texto: encontrado.message, parsed };

  await guardarResultado({
    loteriaNombre: parsed.loteriaNombre,
    nombreSorteo: parsed.nombreSorteo,
    loteriaId: destino.loteriaId,
    sorteoId: destino.sorteoId,
    fijo: parsed.fijo,
    corrido: parsed.corrido,
    centena: parsed.centena,
    fecha: parsed.fecha,
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

if (require.main === module) {
  iniciarUserbotResultados().catch(e => {
    console.error('❌ Userbot no pudo iniciar:', e);
  });
}
