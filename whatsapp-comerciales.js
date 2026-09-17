const { createClient } = require('@supabase/supabase-js');
const { useSupabaseAuthState } = require('./lib/wa-session-store');
const { DisconnectReason } = require('@whiskeysockets/baileys');

const sockets = new Map();
const reconnectTimers = new Map();
const activeBettingChats = new Set();

function enabled() {
  return String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() === 'true';
}

function admins() {
  return String(process.env.ADMIN_IDS || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite);
}

function supa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);
}

function textFromMessage(message) {
  const remoteJid = String(message?.key?.remoteJid || '').trim();
  if (remoteJid.endsWith('@g.us')) return '';
  const m = message?.message;
  if (!m) return '';
  return String(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '').trim();
}

function senderName(message) {
  return String(message?.pushName || message?.verifiedBizName || '').trim();
}

function bettingChatKey(comercialId, whatsappJid) {
  return `${Number(comercialId)}:${String(whatsappJid || '').trim()}`;
}

function normalizeCommand(texto) {
  return String(texto || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function telegramText(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: String(chatId), text }) });
}

async function commercialRole(db, id) {
  if (admins().includes(Number(id))) return 'admin';
  const { data } = await db.from('users').select('role').eq('telegram_id', id).maybeSingle();
  return data?.role || 'cliente';
}

async function buscarClienteWhatsApp(db, comercialId, senderJid) {
  const jid = String(senderJid || '').trim();
  if (!jid) throw new Error('No se pudo identificar el WhatsApp del cliente.');
  const { data, error } = await db.from('clientes_banca').select('*').eq('comercial_telegram_id', comercialId).eq('whatsapp_jid', jid).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Este WhatsApp no está registrado con el comercial. Debes registrarte y realizar un depósito antes de jugar.');
  return data;
}

async function obtenerPreferenciaWhatsApp(db, comercialId, whatsappJid) {
  const { data, error } = await db.from('whatsapp_cliente_preferencias').select('comercial_telegram_id,whatsapp_jid,loteria_id,sorteo_id,moneda,updated_at').eq('comercial_telegram_id', comercialId).eq('whatsapp_jid', whatsappJid).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function guardarPreferenciaWhatsApp(db, comercialId, whatsappJid, patch) {
  const actual = await obtenerPreferenciaWhatsApp(db, comercialId, whatsappJid);
  const payload = {
    comercial_telegram_id: Number(comercialId),
    whatsapp_jid: String(whatsappJid),
    loteria_id: patch.loteria_id !== undefined ? patch.loteria_id : actual?.loteria_id || null,
    sorteo_id: patch.sorteo_id !== undefined ? patch.sorteo_id : actual?.sorteo_id || null,
    moneda: patch.moneda !== undefined ? patch.moneda : actual?.moneda || 'cup',
    updated_at: new Date().toISOString()
  };
  const { data, error } = await db.from('whatsapp_cliente_preferencias').upsert(payload, { onConflict: 'comercial_telegram_id,whatsapp_jid' }).select('*').single();
  if (error) throw error;
  return data;
}

async function reiniciarSesionWhatsApp(db, comercialId, jid) {
  await guardarPreferenciaWhatsApp(db, comercialId, jid, { loteria_id: null, sorteo_id: null });
}

async function listarLoteriasWhatsApp(db) {
  const { data, error } = await db.from('loterias').select('id,nombre').eq('activo', true).order('id');
  if (error) throw error;
  return data || [];
}

async function listarSorteosWhatsApp(db, loteriaId) {
  const { data, error } = await db.from('sorteos').select('id,nombre,hora_apertura,hora_cierre,activo,loteria_id').eq('loteria_id', loteriaId).eq('activo', true).order('hora_apertura');
  if (error) throw error;
  return data || [];
}

function formatoHora(valor) { return valor ? String(valor).slice(0, 5) : '--:--'; }

async function enviarSeleccionLoterias(sock, remoteJid, db) {
  const loterias = await listarLoteriasWhatsApp(db);
  if (!loterias.length) return sock.sendMessage(remoteJid, { text: '⚠️ No hay loterías activas disponibles.' });
  return sock.sendMessage(remoteJid, { text: ['🎲 LOTERÍAS DISPONIBLES', '', ...loterias.map(l => `${l.id}. ${l.nombre}`), '', 'Para seleccionar escribe:', '/loteria ID', '', 'Ejemplo: /loteria 1'].join('\n') });
}

async function enviarSeleccionSorteos(sock, remoteJid, db, loteriaId) {
  const { data: loteria } = await db.from('loterias').select('id,nombre').eq('id', loteriaId).eq('activo', true).maybeSingle();
  if (!loteria) return sock.sendMessage(remoteJid, { text: '❌ La lotería seleccionada no existe o está inactiva. Usa /loterias.' });
  const sorteos = await listarSorteosWhatsApp(db, loteriaId);
  if (!sorteos.length) return sock.sendMessage(remoteJid, { text: `⚠️ ${loteria.nombre} no tiene sorteos activos.` });
  return sock.sendMessage(remoteJid, { text: [`🎰 ${loteria.nombre}`, 'Sorteos disponibles:', '', ...sorteos.map(s => `${s.id}. ${s.nombre} — ${formatoHora(s.hora_apertura)}-${formatoHora(s.hora_cierre)}`), '', 'Para seleccionar escribe:', '/sorteo ID', '', 'Ejemplo: /sorteo 3'].join('\n') });
}

async function enviarEstadoCliente(sock, remoteJid, db, comercialId, jid) {
  const pref = await obtenerPreferenciaWhatsApp(db, comercialId, jid);
  let texto = '⚙️ CONFIGURACIÓN DE JUEGO\n\n';
  if (!pref?.loteria_id) texto += '🎲 Lotería: NO SELECCIONADA\n';
  else { const { data: loteria } = await db.from('loterias').select('nombre').eq('id', pref.loteria_id).maybeSingle(); texto += `🎲 Lotería: ${loteria?.nombre || pref.loteria_id}\n`; }
  if (!pref?.sorteo_id) texto += '🎰 Sorteo: NO SELECCIONADO\n';
  else { const { data: sorteo } = await db.from('sorteos').select('nombre,hora_apertura,hora_cierre,activo').eq('id', pref.sorteo_id).maybeSingle(); texto += `🎰 Sorteo: ${sorteo?.nombre || pref.sorteo_id}\n`; if (sorteo) texto += `⏰ Horario: ${formatoHora(sorteo.hora_apertura)}-${formatoHora(sorteo.hora_cierre)}\n`; }
  try { const cliente = await buscarClienteWhatsApp(db, comercialId, jid); texto += `💰 Saldo: $${Number(cliente.saldo || 0).toFixed(2)}\n`; } catch (_) { texto += '👤 Cuenta: NO REGISTRADA\n'; }
  if (pref?.updated_at) texto += `🕒 Última selección: ${new Date(pref.updated_at).toLocaleString('es-CU', { timeZone: 'America/Havana' })}\n`;
  return sock.sendMessage(remoteJid, { text: texto });
}

async function registrarBetAtomica(db, args) {
  const { data, error } = await db.rpc('registrar_bet_comercial_atomica', {
    p_comercial_telegram_id: args.comercialId,
    p_cliente_banca_id: args.clienteBancaId,
    p_loteria_id: args.loteriaId,
    p_sorteo_id: args.sorteoId,
    p_fecha_apuesta: args.fecha,
    p_input_raw: args.inputRaw,
    p_total_apuesta: args.totalApuesta,
    p_detalle: args.detalle,
    p_moneda: args.moneda || 'cup'
  });
  if (error) throw error;
  const r = Array.isArray(data) ? data[0] : data;
  if (!r?.ok || !r.bet_id) throw new Error(r?.message || 'La base de datos no confirmó la apuesta.');
  return { id: Number(r.bet_id), saldoAntes: Number(r.saldo_antes || 0), credito: Number(r.credito || 0), saldoDespues: Number(r.saldo_despues || 0) };
}

async function validarSorteoAbierto(db, sorteoId, loteriaId) {
  const { data: sorteo, error } = await db.from('sorteos').select('id,nombre,loteria_id,hora_apertura,hora_cierre,activo').eq('id', sorteoId).maybeSingle();
  if (error) throw error;
  if (!sorteo || !sorteo.activo) throw new Error('El sorteo seleccionado no está activo.');
  if (Number(sorteo.loteria_id) !== Number(loteriaId)) throw new Error('El sorteo seleccionado no pertenece a la lotería elegida.');
  if (sorteo.hora_apertura && sorteo.hora_cierre) {
    const ahora = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const [ah, am] = String(sorteo.hora_apertura).slice(0,5).split(':').map(Number);
    const [ch, cm] = String(sorteo.hora_cierre).slice(0,5).split(':').map(Number);
    const [xh, xm] = ahora.split(':').map(Number);
    const actual = xh * 60 + xm;
    const apertura = ah * 60 + am;
    const cierre = ch * 60 + cm;
    const abierto = cierre >= apertura ? actual >= apertura && actual < cierre : actual >= apertura || actual < cierre;
    if (!abierto) throw new Error(`El sorteo ${sorteo.nombre} está cerrado. Horario: ${formatoHora(sorteo.hora_apertura)}-${formatoHora(sorteo.hora_cierre)} (Cuba).`);
  }
  return sorteo;
}

async function procesarJugadaWhatsApp({ comercialId, texto, senderJid }) {
  const db = supa();
  const cliente = await buscarClienteWhatsApp(db, comercialId, senderJid);
  const saldo = Number(cliente.saldo || 0);
  if (!Number.isFinite(saldo) || saldo <= 0) throw new Error('No tienes saldo disponible. Debes realizar un depósito antes de jugar.');
  const pref = await obtenerPreferenciaWhatsApp(db, comercialId, senderJid);
  if (!pref?.loteria_id || !pref?.sorteo_id) throw new Error('Primero debes seleccionar la lotería y el sorteo antes de enviar una jugada. Usa /loterias.');
  const sorteo = await validarSorteoAbierto(db, pref.sorteo_id, pref.loteria_id);
  const Engine = global.Engine, Preprocesador = global.Preprocesador, Utils = global.Utils, Expansion = global.Expansion;
  if (!Engine?.calcular || !Preprocesador?.preprocesarJugada || !Utils?.limpiarMonto || !Expansion) throw new Error('Motor LotoPro no disponible.');
  const result = Engine.calcular({ rawInput: texto, loteriaId: pref.loteria_id, sorteoId: pref.sorteo_id }, { Expansion, limpiarMonto: Utils.limpiarMonto, preprocesarJugada: Preprocesador.preprocesarJugada, obtenerTimestampLocal: () => new Date().toISOString() });
  if (!result?.ok || !result.certified) { const detail = (result?.errors || []).map(e => e.message || e.reason).join('\n'); throw new Error(`${result?.message || 'La jugada no pudo procesarse.'}${detail ? `\n${detail}` : ''}`); }
  const total = Number(result.totalGeneral || 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error('La jugada no tiene un monto válido.');
  if (saldo < total) throw new Error(`Saldo insuficiente. Disponible: $${saldo.toFixed(2)}, necesario: $${total.toFixed(2)}. Debes realizar un depósito antes de jugar.`);
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Havana' }).format(new Date());
  const detalle = (result.jugadas || []).flatMap(j => j.jugadas_detalle || []);
  const registro = await registrarBetAtomica(db, { comercialId, clienteBancaId: cliente.id, loteriaId: pref.loteria_id, sorteoId: pref.sorteo_id, fecha, inputRaw: texto, totalApuesta: total, detalle: JSON.stringify(detalle), moneda: pref.moneda || 'cup' });
  return { bets: [{ id: registro.id, nombre: cliente.nombre, total, credito: registro.credito, saldoAntes: registro.saldoAntes, saldoDespues: registro.saldoDespues }], total, sorteo: sorteo.nombre, loteriaId: pref.loteria_id, sorteoId: pref.sorteo_id, loteriaNombre: (await db.from('loterias').select('nombre').eq('id', pref.loteria_id).maybeSingle()).data?.nombre || String(pref.loteria_id), textoOriginal: texto };
}

function fechaCuba() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Havana' }).format(new Date()); }

async function enviarListaJugadas(bot, db, ctx) {
  const role = await commercialRole(db, ctx.from.id);
  if (!['comercial', 'admin'].includes(role)) return ctx.reply('⛔ Solo un comercial puede usar este comando.');
  const { data: pref } = await db.from('user_preferences').select('loteria_id,sorteo_id').eq('telegram_id', ctx.from.id).maybeSingle();
  if (!pref?.loteria_id || !pref?.sorteo_id) return ctx.reply('🎲 Primero selecciona la lotería y el sorteo con /start.');
  const { data: loteria } = await db.from('loterias').select('id,nombre').eq('id', pref.loteria_id).maybeSingle();
  const { data: sorteo } = await db.from('sorteos').select('id,nombre,hora_apertura,hora_cierre').eq('id', pref.sorteo_id).maybeSingle();
  if (!loteria || !sorteo) return ctx.reply('❌ La lotería o el sorteo seleccionado ya no existe. Usa /start.');
  const { data: bets, error } = await db.from('bets').select('id,input_raw,total_apuesta,moneda,created_at,cliente_banca_id').eq('comercial_telegram_id', ctx.from.id).eq('loteria_id', pref.loteria_id).eq('sorteo_id', pref.sorteo_id).eq('fecha_apuesta', fechaCuba()).order('created_at', { ascending: true });
  if (error) { console.error('lista jugadas error:', error); return ctx.reply('❌ No se pudo consultar la lista de jugadas.'); }
  if (!bets?.length) return ctx.reply(`📋 No hay jugadas para ${loteria.nombre} — ${sorteo.nombre} en la fecha de hoy.`);
  const ids = [...new Set(bets.map(b => b.cliente_banca_id).filter(Boolean))];
  const { data: clientes } = ids.length ? await db.from('clientes_banca').select('id,nombre,whatsapp_jid,saldo').in('id', ids) : { data: [] };
  const mapa = new Map((clientes || []).map(c => [Number(c.id), c]));
  const bloques = bets.map((b, i) => { const c = mapa.get(Number(b.cliente_banca_id)); const fechaHora = b.created_at ? new Date(b.created_at).toLocaleTimeString('es-CU', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit' }) : '--:--'; return `${i + 1}. 👤 ${c?.nombre || 'Cliente'}\n   🕒 ${fechaHora}\n   🧾 ${String(b.input_raw || '').slice(0, 700)}\n   💵 Total: $${Number(b.total_apuesta || 0).toFixed(2)} ${String(b.moneda || 'cup').toUpperCase()}\n   🆔 Apuesta #${b.id}`; });
  const encabezado = `📋 JUGADAS RECIBIDAS\n\n🎲 ${loteria.nombre}\n🎰 ${sorteo.nombre}\n⏰ ${formatoHora(sorteo.hora_apertura)}-${formatoHora(sorteo.hora_cierre)}\n📅 ${fechaCuba()}\n\n`;
  const chunks = []; let actual = encabezado;
  for (const bloque of bloques) { if ((actual + '\n\n' + bloque).length > 3900) { chunks.push(actual); actual = bloque; } else actual += (actual === encabezado ? '' : '\n\n') + bloque; }
  if (actual) chunks.push(actual);
  for (const chunk of chunks) await ctx.reply(chunk);
}

async function recibirMensaje(db, sock, comercialId, message) {
  if (!message?.key?.id || message.key.fromMe) return;
  const texto = textFromMessage(message); if (!texto) return;
  const remoteJid = String(message.key.remoteJid || '').trim(); if (!remoteJid || remoteJid === 'status@broadcast') return;
  const senderJid = String(message.key.participant || remoteJid).trim();
  const key = bettingChatKey(comercialId, senderJid || remoteJid);
  const command = normalizeCommand(texto);

  if (command === '/jugar') {
    activeBettingChats.add(key);
    try { await reiniciarSesionWhatsApp(db, comercialId, senderJid); } catch (e) { activeBettingChats.delete(key); console.error(`No se pudo reiniciar sesión WhatsApp ${comercialId}/${senderJid}:`, e); return sock.sendMessage(remoteJid, { text: '❌ No pude iniciar una sesión de juego segura. Inténtalo nuevamente.' }); }
    await sock.sendMessage(remoteJid, { text: '🎰 Modo jugada activado.\n\n⚠️ Para evitar que una selección anterior se use por error, esta sesión empieza sin lotería ni sorteo.\n\n1️⃣ Usa /loterias\n2️⃣ Selecciona con /loteria ID\n3️⃣ Usa /sorteos\n4️⃣ Selecciona con /sorteo ID\n\nDespués podrás enviar la jugada.\n\n⏳ La sesión vence tras 30 minutos de inactividad.\n\nPara salir escribe /salir.' });
    return;
  }

  if (command === '/salir') { activeBettingChats.delete(key); await reiniciarSesionWhatsApp(db, comercialId, senderJid).catch(() => {}); await sock.sendMessage(remoteJid, { text: '✅ Modo jugada desactivado y selección borrada.\n\nCuando quieras jugar de nuevo escribe /jugar.' }); return; }
  if (command === '/loterias' || command === '/loteria') { await enviarSeleccionLoterias(sock, remoteJid, db); return; }
  const loteriaMatch = command.match(/^\/loteria\s+(\d+)$/);
  if (loteriaMatch) {
    const loteriaId = Number(loteriaMatch[1]); const { data: loteria } = await db.from('loterias').select('id,nombre').eq('id', loteriaId).eq('activo', true).maybeSingle();
    if (!loteria) return sock.sendMessage(remoteJid, { text: '❌ Lotería no encontrada o inactiva. Usa /loterias.' });
    await guardarPreferenciaWhatsApp(db, comercialId, senderJid, { loteria_id: loteria.id, sorteo_id: null });
    await sock.sendMessage(remoteJid, { text: `✅ Lotería seleccionada: ${loteria.nombre}\n\nAhora selecciona el sorteo con /sorteos.` });
    await enviarSeleccionSorteos(sock, remoteJid, db, loteria.id); return;
  }
  if (command === '/sorteos') {
    const pref = await obtenerPreferenciaWhatsApp(db, comercialId, senderJid);
    if (!pref?.loteria_id) return sock.sendMessage(remoteJid, { text: '🎲 Primero selecciona una lotería con /loterias.' });
    await enviarSeleccionSorteos(sock, remoteJid, db, pref.loteria_id); return;
  }
  const sorteoMatch = command.match(/^\/sorteo\s+(\d+)$/);
  if (sorteoMatch) {
    const pref = await obtenerPreferenciaWhatsApp(db, comercialId, senderJid);
    if (!pref?.loteria_id) return sock.sendMessage(remoteJid, { text: '🎲 Primero selecciona una lotería con /loterias.' });
    const sorteoId = Number(sorteoMatch[1]); const { data: sorteo } = await db.from('sorteos').select('id,nombre,hora_apertura,hora_cierre,activo,loteria_id').eq('id', sorteoId).eq('loteria_id', pref.loteria_id).eq('activo', true).maybeSingle();
    if (!sorteo) return sock.sendMessage(remoteJid, { text: '❌ Sorteo no encontrado para la lotería seleccionada. Usa /sorteos.' });
    await guardarPreferenciaWhatsApp(db, comercialId, senderJid, { sorteo_id: sorteo.id });
    await sock.sendMessage(remoteJid, { text: `✅ Sorteo seleccionado: ${sorteo.nombre}\n⏰ Horario: ${formatoHora(sorteo.hora_apertura)}-${formatoHora(sorteo.hora_cierre)}\n\nYa puedes enviar tu jugada. Recuerda que necesitas saldo depositado.\n\n⏳ La selección vence después de 30 minutos de inactividad.` }); return;
  }
  if (command === '/estado') { await enviarEstadoCliente(sock, remoteJid, db, comercialId, senderJid); return; }
  if (!activeBettingChats.has(key)) return;

  const { data: inserted, error } = await db.from('whatsapp_inbox').insert([{ comercial_telegram_id: comercialId, message_id: String(message.key.id), remote_jid: remoteJid, sender_jid: senderJid || null, sender_name: senderName(message) || null, texto }]).select('id').single();
  if (error) { if (String(error.message || '').toLowerCase().includes('duplicate')) return; console.error('WhatsApp inbox error:', error); return; }
  await db.from('whatsapp_comercial_session').update({ ultimo_mensaje_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('comercial_telegram_id', comercialId);
  try {
    const r = await procesarJugadaWhatsApp({ comercialId, texto, senderJid });
    await db.from('whatsapp_inbox').update({ procesado: true, bet_ids: r.bets.map(b => b.id), error: null }).eq('id', inserted.id);
    const b = r.bets[0]; const resumen = `👤 ${b.nombre}\n🧾 ${r.textoOriginal}\n\n💵 Total: $${r.total.toFixed(2)}\n💰 Saldo restante: $${b.saldoDespues.toFixed(2)}\n🎲 ${r.loteriaNombre}\n🎰 ${r.sorteo}`;
    await sock.sendMessage(remoteJid, { text: `✅ Jugada recibida y registrada.\n\n${resumen}` });
    await telegramText(comercialId, `📲 JUGADA RECIBIDA POR WHATSAPP\n\n${resumen}\n\n🆔 Apuesta #${b.id}`);
  } catch (err) {
    const errorTexto = String(err?.message || err);
    await db.from('whatsapp_inbox').update({ error: errorTexto }).eq('id', inserted.id);
    await sock.sendMessage(remoteJid, { text: `⚠️ La jugada NO fue registrada.\n\n${errorTexto}` });
    await telegramText(comercialId, `⚠️ JUGADA WHATSAPP NO REGISTRADA\n\n👤 ${senderJid}\n🧾 ${texto}\n\n${errorTexto}`);
  }
}

// Resto del archivo conservado: conexión Baileys, QR, estados y comandos administrativos.
