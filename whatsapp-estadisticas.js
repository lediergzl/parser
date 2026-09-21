// Captura las publicaciones diarias de ESTADISTICAS_ORIGEN y las entrega
// solamente a comerciales cuyo módulo esté habilitado y vigente.
const { createClient } = require('@supabase/supabase-js');
const { NewMessage } = require('telegram/events');
const { utils: tgUtils } = require('telegram');

const TZ_CUBA = 'America/Havana';
const ORIGEN = String(process.env.ESTADISTICAS_ORIGEN || '@rolottery').trim();
const INTERVALO_MS = Math.max(60000, Number(process.env.ESTADISTICAS_INTERVALO_MS || 180000));
// Cada ciclo procesa como máximo un lote. Si existe una cola vieja acumulada,
// NO se debe seguir drenando indefinidamente: primero se publica el lote actual
// y después se espera al siguiente bloque real de publicaciones.
// Las estadísticas se publican por lotes: se toma un grupo de publicaciones,
// se entrega y después se espera al siguiente ciclo. Esto evita inundar el grupo
// con un mensaje por cada publicación recién capturada.
const LOTE_PUBLICACIONES = Math.max(1, Math.min(50, Number(process.env.ESTADISTICAS_LOTE_PUBLICACIONES || 10)));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);
let entidadOrigen = null;
let handlerRegistrado = false;
let timer = null;
let sincronizacionEnCurso = false;

function fechaCuba(v) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_CUBA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(v instanceof Date ? v : new Date(v)); }
function hoyCuba() { return fechaCuba(new Date()); }
function tipoMensaje(msg) {
  if (msg && msg.media && msg.media.className === 'MessageMediaPhoto') return 'foto';
  if (msg && msg.media && msg.media.className === 'MessageMediaDocument') return 'documento';
  if (msg && msg.media) return 'multimedia';
  return 'texto';
}
function enlaceMensaje(msg) {
  const username = entidadOrigen && entidadOrigen.username ? String(entidadOrigen.username) : '';
  return username && msg && msg.id ? 'https://t.me/' + username + '/' + msg.id : null;
}
function formatoWhatsApp(post) {
  const partes = ['📊 *ESTADÍSTICAS*'];
  if (post.texto) partes.push(post.texto);
  if (post.tipo !== 'texto') partes.push('📎 Publicación con multimedia.');
  return partes.join('\n\n');
}

async function payloadWhatsApp(post) {
  const texto = formatoWhatsApp(post);
  if (post.tipo === 'texto' || !global.__USERBOT_CLIENT__ || !entidadOrigen) return { text: texto };

  try {
    const mensajes = await global.__USERBOT_CLIENT__.getMessages(entidadOrigen, { ids: [Number(post.telegram_message_id)] });
    const msg = Array.isArray(mensajes) ? mensajes[0] : mensajes;
    if (!msg || !msg.media || typeof msg.downloadMedia !== 'function') return { text: texto };

    const buffer = await msg.downloadMedia({});
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return { text: texto };
    const maxBytes = 20 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      console.warn('📎 Multimedia de estadísticas demasiado grande (' + buffer.length + ' bytes); se envía enlace.');
      return { text: texto };
    }

    if (post.tipo === 'foto') return { image: buffer, caption: texto };

    const media = msg.media;
    const mime = String(media.mimeType || 'application/octet-stream');
    let fileName = 'estadistica-' + post.telegram_message_id;
    const attrs = Array.isArray(media.attributes) ? media.attributes : [];
    const attrFile = attrs.find(x => x && x.className === 'DocumentAttributeFilename' && x.fileName);
    if (attrFile) fileName = String(attrFile.fileName);

    if (mime.startsWith('video/')) return { video: buffer, mimetype: mime, caption: texto };

    if (mime.startsWith('audio/')) return { audio: buffer, mimetype: mime };

    return { document: buffer, mimetype: mime, fileName: fileName, caption: texto };
  } catch (e) {
    console.warn('⚠️ No se pudo descargar multimedia de la estadística; se envía solo el texto:', e && e.message ? e.message : e);
    return { text: texto };
  }
}

async function guardarPost(msg) {
  const chatId = String(msg.chatId != null ? msg.chatId : '');
  const messageId = Number(msg.id);
  if (!chatId || !Number.isFinite(messageId)) return null;
  const fecha = msg.date instanceof Date ? msg.date : (msg.date ? new Date(Number(msg.date) * 1000) : new Date());
  if (fechaCuba(fecha) !== hoyCuba()) return null;
  const payload = { telegram_chat_id: chatId, telegram_message_id: messageId, fecha_publicacion: fecha.toISOString(), fecha_cuba: fechaCuba(fecha), texto: String(msg.message || '').trim(), enlace_telegram: enlaceMensaje(msg), tipo: tipoMensaje(msg) };
  const { data, error } = await supabase.from('whatsapp_estadisticas_posts').upsert(payload, { onConflict: 'telegram_chat_id,telegram_message_id', ignoreDuplicates: true }).select('id,telegram_chat_id,telegram_message_id,fecha_cuba,texto,enlace_telegram,tipo').maybeSingle();
  if (error) throw error;
  if (data) return data;
  const existente = await supabase.from('whatsapp_estadisticas_posts').select('id,telegram_chat_id,telegram_message_id,fecha_cuba,texto,enlace_telegram,tipo').eq('telegram_chat_id', chatId).eq('telegram_message_id', messageId).maybeSingle();
  if (existente.error) throw existente.error;
  return existente.data || null;
}

async function destinosActivos() {
  const ahora = new Date().toISOString();
  const mods = await supabase.from('whatsapp_estadisticas_modulo').select('comercial_telegram_id,fecha_inicio,fecha_vencimiento').eq('habilitado', true).or('fecha_vencimiento.is.null,fecha_vencimiento.gte.' + ahora);
  if (mods.error) throw mods.error;
  if (!mods.data || !mods.data.length) return [];
  const ids = mods.data.map(x => Number(x.comercial_telegram_id)).filter(Number.isFinite);
  const grupos = await supabase.from('whatsapp_comercial_resultados').select('comercial_telegram_id,destino_id,nombre,activo').in('comercial_telegram_id', ids).eq('activo', true);
  if (grupos.error) throw grupos.error;
  const mapa = new Map((grupos.data || []).map(g => [Number(g.comercial_telegram_id), g]));
  return mods.data.map(m => { const g = mapa.get(Number(m.comercial_telegram_id)); return g ? { comercial_telegram_id: Number(m.comercial_telegram_id), destino_id: String(g.destino_id).trim(), nombre: g.nombre || g.destino_id } : null; }).filter(Boolean);
}

async function encolar(post) {
  const destinos = await destinosActivos();
  if (!destinos.length) return 0;
  const filas = destinos.map(d => ({ post_id: Number(post.id), comercial_telegram_id: d.comercial_telegram_id, destino_id: d.destino_id, estado: 'pendiente', intentos: 0 }));
  const r = await supabase.from('whatsapp_estadisticas_outbox').upsert(filas, { onConflict: 'post_id,comercial_telegram_id', ignoreDuplicates: true });
  if (r.error) throw r.error;
  return filas.length;
}

async function capturar(msg, origen) {
  if (!msg || !msg.id) return false;
  try {
    const post = await guardarPost(msg);
    if (!post) return false;
    const n = await encolar(post);
    console.log('📊 Estadística ' + origen + ': msg=' + msg.id + ' tipo=' + post.tipo + ' destinos=' + n);
    return true;
  } catch (e) { console.error('❌ Error capturando estadística:', e && e.stack ? e.stack : e); return false; }
}

async function sincronizarHoy() {
  const client = global.__USERBOT_CLIENT__;
  if (!client || !entidadOrigen || sincronizacionEnCurso) return;
  sincronizacionEnCurso = true;
  try {
    const mensajes = await client.getMessages(entidadOrigen, { limit: 500 });
    let n = 0;
    for (const msg of [...mensajes].reverse()) {
      const fecha = msg.date instanceof Date ? msg.date : (msg.date ? new Date(Number(msg.date) * 1000) : null);
      if (fecha && fechaCuba(fecha) !== hoyCuba()) continue;
      if (!msg.message && !msg.media) continue;
      if (await capturar(msg, 'recuperación')) n++;
    }
    if (n) console.log('🔄 Estadísticas: ' + n + ' publicación(es) recuperada(s).');
  } catch (e) { console.error('⚠️ Error recuperando estadísticas:', e && e.stack ? e.stack : e); }
  finally { sincronizacionEnCurso = false; }
}

async function drenarOutbox() {
  let sender;
  try { sender = require('./whatsapp-comerciales'); } catch (e) { console.error('❌ Transporte estadísticas:', e.message || e); return; }

  // Solo tomamos el bloque que estaba pendiente al comenzar este ciclo.
  // No seguimos encadenando lotes de una cola histórica.
  const r = await supabase
    .from('whatsapp_estadisticas_outbox')
    .select('id,post_id,comercial_telegram_id,destino_id,intentos')
    .eq('estado','pendiente')
    .order('creado_at',{ascending:true})
    .limit(10);

  if (r.error) { console.error('❌ Outbox estadísticas:', r.error.message || r.error); return; }
  if (!r.data?.length) return;

  const items = r.data;
  const payloadCache = new Map();

  console.log('📦 Estadísticas: tomando un solo lote de ' + items.length + ' publicación(es).');

  for (const item of items) {
    const m = await supabase
      .from('whatsapp_estadisticas_modulo')
      .select('habilitado,fecha_inicio,fecha_vencimiento')
      .eq('comercial_telegram_id',item.comercial_telegram_id)
      .maybeSingle();

    const vigente = m.data &&
      m.data.habilitado &&
      (!m.data.fecha_inicio || new Date(m.data.fecha_inicio).getTime() <= Date.now()) &&
      (!m.data.fecha_vencimiento || new Date(m.data.fecha_vencimiento).getTime() >= Date.now());

    if (!vigente) {
      await supabase.from('whatsapp_estadisticas_outbox')
        .update({estado:'omitido',ultimo_error:'Módulo no vigente.'})
        .eq('id',item.id).eq('estado','pendiente');
      continue;
    }

    const p = await supabase
      .from('whatsapp_estadisticas_posts')
      .select('id,telegram_chat_id,telegram_message_id,texto,enlace_telegram,tipo')
      .eq('id',item.post_id)
      .maybeSingle();

    if (!p.data) {
      await supabase.from('whatsapp_estadisticas_outbox')
        .update({estado:'omitido',ultimo_error:'Publicación no encontrada.'})
        .eq('id',item.id).eq('estado','pendiente');
      continue;
    }

    const intento = Number(item.intentos || 0) + 1;
    const reservado = await supabase.from('whatsapp_estadisticas_outbox')
      .update({
        estado:'enviando',
        intentos:intento,
        ultimo_intento_at:new Date().toISOString(),
        ultimo_error:null
      })
      .eq('id',item.id).eq('estado','pendiente');

    if (reservado.error) continue;

    try {
      let payload = payloadCache.get(Number(item.post_id));
      if (!payload) {
        payload = await payloadWhatsApp(p.data);
        payloadCache.set(Number(item.post_id), payload);
      }

      await sender.enviarMensajePorDestino(supabase, item.destino_id, '', {payload});

      await supabase.from('whatsapp_estadisticas_outbox')
        .update({estado:'enviado',enviado_at:new Date().toISOString(),ultimo_error:null})
        .eq('id',item.id).eq('estado','enviando');

      console.log('📊 Estadística enviada: comercial=' + item.comercial_telegram_id + ' destino=' + item.destino_id + ' post=' + item.post_id);
    } catch (e) {
      await supabase.from('whatsapp_estadisticas_outbox')
        .update({estado:'pendiente',ultimo_error:String(e && e.message || e).slice(0,1000)})
        .eq('id',item.id).eq('estado','enviando');
      console.error('⚠️ Estadística pendiente:', e.message || e);
    }
  }

  console.log('⏸️ Estadísticas: lote terminado. No se enviará otro hasta el próximo ciclo de ' + Math.round(INTERVALO_MS / 60000) + ' min.');
}

function esAdmin(ctx) { return String(process.env.ADMIN_IDS || '').split(',').map(x => Number(x.trim())).filter(Number.isFinite).includes(Number(ctx && ctx.from && ctx.from.id)); }
async function registrarComandos(bot) {
  if (!bot || !bot.command) return;
  bot.command('estadisticas', async ctx => {
    if (!esAdmin(ctx)) return;
    const p = String(ctx.message && ctx.message.text || '').trim().split(/\s+/);
    const accion = String(p[1] || 'estado').toLowerCase();
    const id = Number(p[2]);
    try {
      if (accion === 'activar') {
        const dias = Math.max(1, Math.min(3650, Number(p[3] || 30)));
        if (!Number.isFinite(id)) return ctx.reply('Uso: /estadisticas activar ID_COMERCIAL DIAS');
        const inicio = new Date(); const fin = new Date(inicio.getTime() + dias * 86400000);
        const r = await supabase.from('whatsapp_estadisticas_modulo').upsert({comercial_telegram_id:id,habilitado:true,fecha_inicio:inicio.toISOString(),fecha_vencimiento:fin.toISOString(),actualizado_por:Number(ctx.from.id),updated_at:new Date().toISOString()},{onConflict:'comercial_telegram_id'});
        if (r.error) throw r.error;
        return ctx.reply('✅ Estadísticas activadas para ' + id + ' por ' + dias + ' día(s). Vence: ' + fin.toLocaleString('es-CU',{timeZone:TZ_CUBA}));
      }
      if (accion === 'desactivar') {
        if (!Number.isFinite(id)) return ctx.reply('Uso: /estadisticas desactivar ID_COMERCIAL');
        const r = await supabase.from('whatsapp_estadisticas_modulo').update({habilitado:false,actualizado_por:Number(ctx.from.id),updated_at:new Date().toISOString()}).eq('comercial_telegram_id',id);
        if (r.error) throw r.error; return ctx.reply('🛑 Estadísticas desactivadas para ' + id + '.');
      }
      if (accion === 'estado') {
        if (!Number.isFinite(id)) return ctx.reply('Uso: /estadisticas estado ID_COMERCIAL');
        const r = await supabase.from('whatsapp_estadisticas_modulo').select('*').eq('comercial_telegram_id',id).maybeSingle();
        if (r.error) throw r.error; if (!r.data) return ctx.reply('ℹ️ El comercial ' + id + ' no tiene el módulo configurado.');
        const vigente = r.data.habilitado && (!r.data.fecha_vencimiento || new Date(r.data.fecha_vencimiento).getTime() >= Date.now());
        return ctx.reply(['📊 Estadísticas — ' + id,'Estado: ' + (vigente ? '🟢 HABILITADO' : '🔴 NO VIGENTE'),'Inicio: ' + (r.data.fecha_inicio ? new Date(r.data.fecha_inicio).toLocaleString('es-CU',{timeZone:TZ_CUBA}) : '—'),'Vencimiento: ' + (r.data.fecha_vencimiento ? new Date(r.data.fecha_vencimiento).toLocaleString('es-CU',{timeZone:TZ_CUBA}) : 'sin vencimiento')].join('\n'));
      }
      return ctx.reply('/estadisticas activar ID DIAS\n/estadisticas desactivar ID\n/estadisticas estado ID');
    } catch (e) { console.error('❌ Error módulo estadísticas:',e && e.stack ? e.stack : e); return ctx.reply('❌ No se pudo actualizar el módulo de estadísticas.'); }
  });
}

async function iniciarEstadisticas() {
  const client = global.__USERBOT_CLIENT__;
  if (!client) return false;
  try {
    entidadOrigen = await client.getEntity(ORIGEN);
    console.log('📊 Canal de estadísticas resuelto: ' + ORIGEN);
    if (!handlerRegistrado) {
      client.addEventHandler(async event => {
        try {
          const msg = event && event.message; if (!msg || !msg.id) return;
          const esperado = tgUtils.getPeerId(entidadOrigen);
          const chatId = msg.chatId != null ? String(msg.chatId) : '';
          if (chatId !== String(esperado)) return;
          await capturar(msg,'evento');
        } catch (e) { console.error('❌ Error evento estadísticas:',e && e.stack ? e.stack : e); }
      }, new NewMessage({}));
      handlerRegistrado = true;
    }
    await sincronizarHoy();
    if (!timer) { timer = setInterval(() => { sincronizarHoy().catch(()=>{}); drenarOutbox().catch(()=>{}); }, INTERVALO_MS); if (timer.unref) timer.unref(); }
    await drenarOutbox();
    console.log('📊 Módulo estadísticas activo: ' + ORIGEN);
    return true;
  } catch (e) { console.error('❌ No se pudo iniciar estadísticas:',e && e.stack ? e.stack : e); return false; }
}
module.exports = { iniciarEstadisticas, registrarComandos };