const bus = require('./event-bus');
const { useSupabaseAuthState } = require('./wa-session-store');
const { yaEntregadaPorWhatsapp } = require('./jugadas-store');
const { listarGruposResultados, listarGruposResultadosComerciales, leerGrupoResultadosComercial } = require('./whatsapp-destino');
const { crearLockSesionWhatsapp } = require('./wa-instance-lock');

let sock = null;
let ready = false;
let suscrito = false;
let lockSesion = null;
let shutdownRegistrado = false;
let authState = null;
let conexionEnCurso = null;
let generacionConexion = 0;
let temporizadorReconectar = null;

// Solo un proceso puede sostener la sesión WhatsApp a la vez (ver
// wa-instance-lock.js). Al recibir SIGTERM/SIGINT (por ejemplo, durante un
// deploy de Render) liberamos el lock de inmediato para que la instancia
// nueva no tenga que esperar el TTL completo antes de poder conectar.
function registrarApagadoOrdenado() {
  if (shutdownRegistrado) return;
  shutdownRegistrado = true;

  const apagar = async (señal) => {
    console.log(`🛑 ${señal} recibido; liberando la sesión WhatsApp antes de salir...`);
    try { sock?.end(new Error('shutdown')); } catch (_) {}
    // CRÍTICO: si el proceso muere con escrituras de creds/keys todavía en
    // cola, el próximo arranque carga un estado Signal desincronizado del
    // que realmente tiene WhatsApp. Eso produce el patrón "conecta -> QR
    // escaneado -> Connection Failure -> 401 -> nuevo QR" que nunca se
    // estabiliza. Esperamos a que termine de escribirse antes de soltar el
    // lock y salir.
    if (authState) await authState.flush().catch(() => {});
    if (lockSesion) await lockSesion.liberar();
  };

  process.once('SIGTERM', () => { apagar('SIGTERM').finally(() => process.exit(0)); });
  process.once('SIGINT', () => { apagar('SIGINT').finally(() => process.exit(0)); });
}
let ultimoQr = null;
let envioQrEnCurso = Promise.resolve();
let ultimoQrEnviadoAt = 0;
const QR_RESEND_INTERVAL_MS = 15000;
const colaNotificaciones = [];

function fmtMoney(value) {
  return Number(value || 0).toFixed(2);
}

function resolverDestino(jugada) {
  return jugada?.destino?.id || process.env.WA_GROUP_ID || null;
}

function nombreLoteria(resultado) {
  return resultado?.loteriaNombre || resultado?.loteria_nombre || (resultado?.loteria_id != null ? `#${resultado.loteria_id}` : 'Lotería');
}

function nombreSorteo(resultado) {
  return resultado?.nombreSorteo || resultado?.sorteoNombre || resultado?.sorteo_nombre || (resultado?.sorteo_id != null ? `#${resultado.sorteo_id}` : 'Sorteo');
}

function formatearJugada(j) {
  return [
    '🎰 NUEVA JUGADA PROCESADA',
    '',
    `🆔 Apuesta: #${j.betId ?? '-'}`,
    `👤 Jugador: ${j.cliente || j.telegramId || '-'}`,
    `🎰 Lotería: ${j.loteriaNombre || 'Lotería'}`,
    `🕒 Sorteo: ${j.sorteoNombre || 'Sorteo'}`,
    `📅 Fecha: ${j.fecha || '-'}`,
    '',
    '📝 Jugada:',
    String(j.rawText || j.raw_text || ''),
    '',
    `💰 Total: $${fmtMoney(j.monto)}`,
    `💵 Moneda: ${String(j.moneda || 'cup').toUpperCase()}`,
    `💳 Saldo restante: $${fmtMoney(j.saldoDespues)}`,
    '',
    '✅ Registrada correctamente.'
  ].join('\n');
}

function formatearResultado(r) {
  const corrido = Array.isArray(r.corrido) ? r.corrido.join(', ') : String(r.corrido || '—');
  return [
    '🎲 RESULTADO RECIBIDO',
    '',
    `🎰 Lotería: ${nombreLoteria(r)}`,
    `🕒 Sorteo: ${nombreSorteo(r)}`,
    `📅 Fecha: ${r.fecha || '-'}`,
    '',
    `🔢 Fijo: ${r.fijo || '—'}`,
    `🎯 Corridos: ${corrido}`,
    `💯 Centena: ${r.centena || '—'}`
  ].join('\n');
}

function formatearPremio(p) {
  const premio = p.premio || {};
  const resultado = p.resultado || {};
  const bet = p.bet || {};
  const jugador = p.jugador || bet.cliente_banca_id || bet.user_telegram_id || '-';
  const montoPremio = premio.monto_premio == null
    ? 'Pendiente de confirmación'
    : `$${fmtMoney(premio.monto_premio)}`;
  const posicion = premio.tipo_jugada === 'corrido' && premio.posicion_resultado != null
    ? `\n📍 Posición del corrido: ${premio.posicion_resultado}`
    : '';

  return [
    '🏆 PREMIO DETECTADO',
    '',
    `🎰 Lotería: ${p.loteriaNombre || nombreLoteria(resultado)}`,
    `🕒 Sorteo: ${p.nombreSorteo || nombreSorteo(resultado)}`,
    `📅 Fecha: ${resultado.fecha || '-'}`,
    `👤 Jugador: ${jugador}`,
    `🎯 Tipo: ${premio.tipo_jugada || '-'}`,
    `🔢 Ganador: ${String(premio.numeros_ganadores || '').replace(/-/g, ' × ')}${posicion}`,
    `💵 Apostado: $${fmtMoney(premio.monto_unitario)}`,
    `💰 Premio: ${montoPremio}`,
    `🧾 Apuesta: #${bet.id ?? premio.bet_id ?? '-'}`,
    premio.monto_premio == null
      ? '⚠️ Requiere confirmación manual.'
      : '✅ Premio calculado automáticamente.'
  ].join('\n');
}

function obtenerAdminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(Number.isFinite);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function qrMatrix(qrText) {
  const QRCode = require('qrcode-terminal/vendor/QRCode');
  const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  const qr = new QRCode(0, QRErrorCorrectLevel.M);
  qr.addData(qrText);
  qr.make();
  if (!Array.isArray(qr.modules) || !qr.modules.length) {
    throw new Error('El generador QR no produjo una matriz válida.');
  }
  return qr.modules;
}

function qrMatrixToPng(matrix, scale = 8) {
  const width = matrix.length;
  if (!width || matrix.some(row => !Array.isArray(row) || row.length !== width)) {
    throw new Error('La matriz QR generada tiene dimensiones inválidas.');
  }
  const quiet = 4;
  const modules = width + quiet * 2;
  const imageSize = modules * scale;
  const scanlines = [];
  for (let moduleY = -quiet; moduleY < width + quiet; moduleY++) {
    const raw = Buffer.alloc(1 + imageSize * 3);
    raw[0] = 0;
    for (let pixelX = 0; pixelX < imageSize; pixelX++) {
      const moduleX = Math.floor(pixelX / scale) - quiet;
      const dark = moduleY >= 0 && moduleY < width && moduleX >= 0 && moduleX < width
        ? matrix[moduleY][moduleX] === true
        : false;
      const value = dark ? 0 : 255;
      const offset = 1 + pixelX * 3;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }
    for (let sy = 0; sy < scale; sy++) scanlines.push(raw);
  }
  const rawImage = Buffer.concat(scanlines);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(imageSize, 0);
  ihdr.writeUInt32BE(imageSize, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', require('zlib').deflateSync(rawImage, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function qrTerminalToPng(qrText, scale = 8) {
  return qrMatrixToPng(qrMatrix(qrText), scale);
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enviarPhotoDirectoTelegram(adminId, buffer, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN no definido.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const form = new FormData();
    form.append('chat_id', String(adminId));
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
    form.append('photo', new Blob([buffer], { type: 'image/png' }), 'whatsapp-qr.png');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST', body: form, signal: controller.signal, headers: { Connection: 'close' }
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error(`Telegram devolvió HTTP ${response.status} sin JSON válido.`); }
    if (!response.ok || !data.ok) throw new Error(`Telegram sendPhoto HTTP ${response.status}: ${data.description || 'respuesta no válida'}`);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Telegram sendPhoto agotó el tiempo de espera (20 s).');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function enviarPhotoConReintento(adminId, buffer, caption, maxIntentos = 3) {
  let ultimoError = null;
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try { await enviarPhotoDirectoTelegram(adminId, buffer, caption); return true; }
    catch (error) {
      ultimoError = error;
      console.error(`⚠️ Fallo enviando QR al admin ${adminId} (intento ${intento}/${maxIntentos}):`, error?.message || error);
      if (intento < maxIntentos) await esperar(1000 * intento);
    }
  }
  console.error(`❌ No se pudo enviar el QR al admin ${adminId} tras ${maxIntentos} intentos:`, ultimoError?.message || ultimoError);
  return false;
}

async function enviarQrAlAdministrador(qr) {
  const adminIds = obtenerAdminIds();
  if (!adminIds.length || !process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ No se pudo enviar el QR de WhatsApp: Telegram o ADMIN_IDS no disponibles.');
    return false;
  }
  try {
    const buffer = qrTerminalToPng(qr, 8);
    const caption = ['📲 *QR DEL WHATSAPP EMISOR DE RESULTADOS*', '', 'Este QR corresponde a la cuenta que el bot usa para ENVIAR resultados y notificaciones.', 'Escanea esta imagen desde WhatsApp → Dispositivos vinculados.', '⏱️ Este QR es temporal. Si tu WhatsApp COMERCIAL ya está vinculado, este QR es de otra cuenta y no debes escanearlo allí.', '', '⚠️ No uses el QR mostrado en los logs de Render.'].join('\n');
    let enviados = 0;
    for (const adminId of adminIds) if (await enviarPhotoConReintento(adminId, buffer, caption)) enviados++;
    if (enviados > 0) { console.log(`✅ QR de WhatsApp enviado por Telegram a ${enviados}/${adminIds.length} administrador(es).`); return true; }
    console.error('❌ QR de WhatsApp generado correctamente, pero Telegram no pudo recibirlo.');
    return false;
  } catch (error) {
    console.error('❌ No se pudo generar/enviar el QR de WhatsApp:', error?.message || error);
    return false;
  }
}

function encolarEnvioQr(qr) {
  envioQrEnCurso = envioQrEnCurso.catch(() => {}).then(() => enviarQrAlAdministrador(qr));
  return envioQrEnCurso;
}

async function guardarNotificacionOutbox(supabase, { tipo, referenciaId, destinoId, texto, etiqueta, comercialId = null, cuentaAlias = 'principal' }) {
  if (!supabase || !tipo || referenciaId == null || !destinoId || !texto) return false;

  const fila = {
    tipo,
    referencia_id: String(referenciaId),
    destino_id: String(destinoId).trim(),
    texto: String(texto),
    etiqueta: etiqueta || null,
    comercial_telegram_id: comercialId == null ? null : Number(comercialId),
    cuenta_alias: String(cuentaAlias || 'principal').trim().toLowerCase(),
    estado: 'pendiente',
    intentos: 0,
    ultimo_error: null,
    ultimo_intento_at: null,
    enviado_at: null,
  };

  const { error } = await supabase
    .from('whatsapp_notificaciones_outbox')
    .upsert([fila], {
      onConflict: 'tipo,referencia_id,destino_id,cuenta_alias',
      // true: si la fila ya existe (pendiente o enviada) NO se reinicia. Con false,
      // volver a emitir un premio/resultado ya enviado lo dejaba otra vez
      // 'pendiente' y se reenviaba tras cada reinicio.
      ignoreDuplicates: true
    });

  if (error) {
    console.error('❌ No se pudo guardar notificación WhatsApp en outbox:', error.message || error);
    return false;
  }

  return true;
}

let vaciadoOutboxEnCurso = null;
let reconstruccionResultadosEnCurso = null;

function fechaActualCuba() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

async function reencolarResultadosDelDia(supabase) {
  if (reconstruccionResultadosEnCurso) return reconstruccionResultadosEnCurso;

  reconstruccionResultadosEnCurso = (async () => {
    try {
      const fecha = fechaActualCuba();
      const [{ data: resultados, error: resultadosError }, grupos, gruposComerciales] = await Promise.all([
        supabase.from('resultados_sorteo')
          .select('id,loteria_id,sorteo_id,fecha,numero_ganado')
          .eq('fecha', fecha)
          .order('id', { ascending: true }),
        listarGruposResultados(supabase),
        listarGruposResultadosComerciales(supabase)
      ]);

      if (resultadosError) throw resultadosError;

      const activosPublicos = (grupos || []).filter(g => g?.activo && g?.destino_id);
      const activosComerciales = (gruposComerciales || []).filter(g => g?.activo && g?.destino_id);
      if (!resultados?.length || (!activosPublicos.length && !activosComerciales.length)) return;

      const idsLoterias = [...new Set(resultados.map(r => Number(r.loteria_id)).filter(Number.isFinite))];
      const idsSorteos = [...new Set(resultados.map(r => Number(r.sorteo_id)).filter(Number.isFinite))];
      const [{ data: loterias }, { data: sorteos }] = await Promise.all([
        idsLoterias.length ? supabase.from('loterias').select('id,nombre').in('id', idsLoterias) : Promise.resolve({ data: [] }),
        idsSorteos.length ? supabase.from('sorteos').select('id,nombre').in('id', idsSorteos) : Promise.resolve({ data: [] })
      ]);
      const loteriaMap = new Map((loterias || []).map(x => [Number(x.id), x.nombre]));
      const sorteoMap = new Map((sorteos || []).map(x => [Number(x.id), x.nombre]));

      let encolados = 0;
      for (const resultado of resultados) {
        const ganado = resultado.numero_ganado || {};
        const corrido = Array.isArray(ganado.corrido)
          ? ganado.corrido.map(String)
          : (ganado.corrido == null ? [] : [String(ganado.corrido)]);
        const payload = {
          resultadoId: resultado.id,
          loteriaNombre: loteriaMap.get(Number(resultado.loteria_id)) || ('#' + resultado.loteria_id),
          nombreSorteo: sorteoMap.get(Number(resultado.sorteo_id)) || ('#' + resultado.sorteo_id),
          fecha: resultado.fecha,
          fijo: ganado.fijo == null ? null : String(ganado.fijo),
          corrido,
          centena: ganado.centena == null ? null : String(ganado.centena)
        };
        const texto = formatearResultado(payload);
        const destinos = new Map();

        for (const grupo of activosPublicos) {
          destinos.set(String(grupo.destino_id).trim(), {
            nombre: grupo.nombre || 'Grupo público de resultados',
            comercialId: null,
            cuentaAlias: 'principal'
          });
        }
        for (const grupo of activosComerciales) {
          const destinoId = String(grupo.destino_id).trim();
          if (!destinos.has(destinoId)) {
            destinos.set(destinoId, {
              nombre: grupo.nombre || ('Grupo del comercial ' + grupo.comercial_telegram_id),
              comercialId: Number(grupo.comercial_telegram_id),
              cuentaAlias: String(grupo.cuenta_alias || 'principal').trim().toLowerCase()
            });
          }
        }

        for (const [destinoId, meta] of destinos) {
          const referenciaId =
            String(resultado.id) + ':' +
            (payload.fijo ?? '') + ':' +
            corrido.join('-') + ':' +
            (payload.centena ?? '') + ':' +
            (meta.comercialId ?? 'public') + ':' +
            meta.cuentaAlias;

          const guardada = await guardarNotificacionOutbox(supabase, {
            tipo: 'resultado',
            referenciaId,
            destinoId,
            texto,
            etiqueta: 'Resultado #' + resultado.id + ' → ' + meta.nombre,
            comercialId: meta.comercialId,
            cuentaAlias: meta.cuentaAlias
          });
          if (guardada) encolados++;
        }
      }

      if (encolados > 0) {
        console.log('🔄 Recuperación WhatsApp: resultados de hoy asegurados en outbox (' + encolados + ' destino(s)).');
      }
    } catch (error) {
      console.error('❌ No se pudieron reconstruir los resultados de hoy en el outbox WhatsApp:', error?.message || error);
    }
  })().finally(() => {
    reconstruccionResultadosEnCurso = null;
  });

  return reconstruccionResultadosEnCurso;
}

async function enviarOutboxPorSocketOTransport(supabase, destinoId, texto, comercialId = null, cuentaAlias = 'principal') {
  if (String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() === 'true') {
    const comerciales = require('../whatsapp-comerciales');
    if (comercialId != null && typeof comerciales.enviarMensajePorComercial === 'function') {
      await comerciales.enviarMensajePorComercial(
        supabase,
        Number(comercialId),
        String(destinoId),
        texto,
        { accountAlias: String(cuentaAlias || 'principal').trim().toLowerCase() }
      );
      return;
    }
    if (typeof comerciales.enviarMensajePorDestino === 'function') {
      await comerciales.enviarMensajePorDestino(supabase, String(destinoId), texto);
      return;
    }
  }
  if (ready && sock) {
    await sock.sendMessage(String(destinoId), { text: texto });
    return;
  }
  throw new Error('No hay un transporte WhatsApp disponible.');
}

async function vaciarOutboxWhatsapp(supabase) {
  if (vaciadoOutboxEnCurso) return vaciadoOutboxEnCurso;

  vaciadoOutboxEnCurso = (async () => {
    const modoMultiComercial = String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() === 'true';
    if ((!ready || !sock) && !modoMultiComercial) return;

    try {
      const { data: pendientes, error } = await supabase
        .from('whatsapp_notificaciones_outbox')
        .select('id,tipo,referencia_id,destino_id,texto,etiqueta,intentos,comercial_telegram_id,cuenta_alias')
        .eq('estado', 'pendiente')
        .lt('intentos', 3)
        .order('creado_at', { ascending: true })
        .limit(50);

      if (error) throw error;

      for (const item of pendientes || []) {
        if ((!ready || !sock) && String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() !== 'true') break;

        const intento = Number(item.intentos || 0) + 1;

        await supabase
          .from('whatsapp_notificaciones_outbox')
          .update({
            intentos: intento,
            ultimo_intento_at: new Date().toISOString(),
            ultimo_error: null
          })
          .eq('id', item.id);

        try {
          await enviarOutboxPorSocketOTransport(supabase, String(item.destino_id), item.texto, item.comercial_telegram_id, item.cuenta_alias || 'principal');

          const { error: updateError } = await supabase
            .from('whatsapp_notificaciones_outbox')
            .update({
              estado: 'enviado',
              enviado_at: new Date().toISOString(),
              ultimo_error: null
            })
            .eq('id', item.id)
            .eq('estado', 'pendiente');

          if (updateError) throw updateError;

          if (item.tipo === 'jugada') {
            bus.emit('jugada:enviada_wa', {
              betId: item.referencia_id,
              destinoId: item.destino_id
            });
          }

          console.log(`✅ ${item.etiqueta || item.tipo + ' #' + item.referencia_id} enviado por WhatsApp (Baileys).`);
        } catch (sendError) {
          const errorTexto = String(sendError?.message || sendError).slice(0, 1000);
          console.error(`❌ Error enviando ${item.etiqueta || item.tipo + ' #' + item.referencia_id} a WhatsApp:`, errorTexto);

          await supabase
            .from('whatsapp_notificaciones_outbox')
            .update({
              ultimo_error: errorTexto
            })
            .eq('id', item.id);

          if (intento >= 3) {
            console.error(
              `🛑 WhatsApp: se detiene el reintento automático de ${item.etiqueta || item.tipo + ' #' + item.referencia_id} tras ${intento} intentos. El registro queda pendiente para recuperación manual.`
            );
          }

          // Si el socket cayó durante el envío, salimos y dejamos el registro
          // pendiente para el siguiente ciclo/reconexión.
          if ((!ready || !sock) && String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() !== 'true') break;
        }
      }
    } catch (error) {
      console.error('❌ Error leyendo outbox de WhatsApp:', error?.message || error);
    }
  })().finally(() => {
    vaciadoOutboxEnCurso = null;
  });

  return vaciadoOutboxEnCurso;
}

async function probarResultadoWhatsapp(supabase, comercialId, cuentaAlias = 'principal') {
  const id = Number(comercialId);
  if (!Number.isFinite(id)) throw new Error('comercialId inválido.');

  const grupo = await leerGrupoResultadosComercial(supabase, id, cuentaAlias);
  if (!grupo?.activo || !grupo?.destino_id) {
    throw new Error('El comercial no tiene un grupo de resultados asignado.');
  }

  const referenciaId = 'prueba-wa-' + id + '-' + Date.now();
  const texto = [
    '🧪 PRUEBA DE RESULTADOS WHATSAPP',
    '',
    '🎰 Florida — Noche',
    '📅 ' + new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Havana',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date()),
    '',
    'Fijo: 17',
    'Corridos: 88, 22',
    'Centena: 617',
    '',
    '✅ Esta es una prueba de transporte.',
    'No corresponde a un resultado real.'
  ].join('\\n');

  const guardada = await encolarNotificacionWhatsapp(
    supabase,
    'resultado',
    referenciaId,
    String(grupo.destino_id).trim(),
    texto,
    'PRUEBA resultado → ' + (grupo.nombre || grupo.destino_id),
    id,
    String(cuentaAlias || 'principal').trim().toLowerCase()
  );

  if (!guardada) throw new Error('No se pudo guardar la prueba en el outbox.');
  return { referenciaId, destinoId: String(grupo.destino_id).trim(), nombre: grupo.nombre || null };
}

async function encolarNotificacionWhatsapp(supabase, tipo, referenciaId, destinoId, texto, etiqueta, comercialId = null, cuentaAlias = 'principal') {
  const guardada = await guardarNotificacionOutbox(supabase, {
    tipo, referenciaId, destinoId, texto, etiqueta, comercialId, cuentaAlias
  });

  if (guardada) {
    vaciarOutboxWhatsapp(supabase).catch(error =>
      console.error('❌ Error drenando outbox WhatsApp:', error?.message || error)
    );
  }

  return guardada;
}

function suscribirBus(supabase) {
  if (suscrito) return;
  suscrito = true;

    if (!global.__LOTO_WA_OUTBOX_TIMER__) {
      global.__LOTO_WA_OUTBOX_TIMER__ = setInterval(() => {
        vaciarOutboxWhatsapp(supabase).catch(() => {});
      }, 5000);
      if (global.__LOTO_WA_OUTBOX_TIMER__.unref) global.__LOTO_WA_OUTBOX_TIMER__.unref();
    }

    bus.on('jugada:procesada', async (jugada) => {
      // 🔒 BARRERA DE ORIGEN: este listener solo puede enviar apuestas
      // producidas por el flujo Telegram -> WhatsApp. Las apuestas recibidas
      // directamente por WhatsApp comercial no pasan por este canal.
      if (jugada?.origen !== 'telegram') {
        console.log(`🛡️ Jugada #${jugada?.betId ?? '-'} ignorada por whatsapp-sender: origen no autorizado (${jugada?.origen || 'sin origen'}).`);
        return;
      }

      const destinoId = resolverDestino(jugada);
      if (!destinoId) {
        console.log('ℹ️ WA_GROUP_ID no configurado y la jugada no trae destino; se omite el envío por Baileys.');
        return;
      }
      if (await yaEntregadaPorWhatsapp(supabase, jugada?.betId)) return;

      // Las jugadas entran en la misma cola que resultados/premios. Así un
      // deploy o una reconexión no pierde el evento efímero.
      const texto = formatearJugada(jugada);
      await encolarNotificacionWhatsapp(
        supabase,
        'jugada',
        jugada?.betId,
        destinoId,
        texto,
        'Jugada #' + (jugada?.betId ?? '-')
      );
    });

    bus.on('resultado:recibido', async (resultado) => {
      const texto = formatearResultado(resultado);
      let gruposPublicos = [];
      let gruposComerciales = [];

      try {
        [gruposPublicos, gruposComerciales] = await Promise.all([
          listarGruposResultados(supabase),
          listarGruposResultadosComerciales(supabase)
        ]);
        gruposPublicos = gruposPublicos.filter(g => g?.activo && g?.destino_id);
        gruposComerciales = gruposComerciales.filter(g => g?.activo && g?.destino_id);
      } catch (error) {
        console.error('❌ No se pudo cargar los grupos WhatsApp de resultados:', error?.message || error);
        return;
      }

      // Publicamos en todos los destinos públicos y en todos los grupos
      // asignados a comerciales. Cada grupo comercial conserva la cuenta
      // WhatsApp (principal/secundaria) que le fue asignada.
      const destinos = new Map();
      for (const grupo of gruposPublicos) {
        destinos.set(String(grupo.destino_id).trim(), {
          nombre: grupo.nombre || 'Grupo público de resultados',
          comercialId: null,
          cuentaAlias: 'principal'
        });
      }
      for (const grupo of gruposComerciales) {
        const id = String(grupo.destino_id).trim();
        if (!destinos.has(id)) {
          destinos.set(id, {
            nombre: grupo.nombre || ('Grupo del comercial ' + grupo.comercial_telegram_id),
            comercialId: Number(grupo.comercial_telegram_id),
            cuentaAlias: String(grupo.cuenta_alias || 'principal').trim().toLowerCase()
          });
        }
      }

      if (!destinos.size) {
        console.log('ℹ️ Resultado recibido, pero no hay grupos WhatsApp autorizados.');
        return;
      }

      for (const [destinoId, meta] of destinos) {
        await encolarNotificacionWhatsapp(
          supabase,
          'resultado',
          `${resultado?.resultadoId}:${resultado?.fijo ?? ''}:${Array.isArray(resultado?.corrido) ? resultado.corrido.join('-') : ''}:${resultado?.centena ?? ''}:${meta.comercialId ?? 'public'}:${meta.cuentaAlias}`,
          destinoId,
          texto,
          'Resultado #' + (resultado?.resultadoId ?? '-') + ' → ' + meta.nombre,
          meta.comercialId,
          meta.cuentaAlias
        );
      }

      console.log(
        '📢 Resultado #' + (resultado?.resultadoId ?? '-') +
        ' registrado en outbox para ' + destinos.size + ' grupo(s).'
      );
    });

    // Recupera resultados que pudieron guardarse antes de que el sender
    // estuviera conectado o antes de que el grupo estuviera disponible.
    reencolarResultadosDelDia(supabase).catch(() => {});

    bus.on('premio:detectado', async (payload) => {
      const comercialId = payload?.bet?.comercial_telegram_id;
      if (comercialId == null) {
        console.log('ℹ️ Premio #' + (payload?.premio?.id ?? '-') + ' sin comercial asociado; no se publica en grupo WhatsApp.');
        return;
      }

      try {
        const grupos = await listarGruposResultadosComerciales(supabase);
        const asignados = (grupos || []).filter(g =>
          Number(g.comercial_telegram_id) === Number(comercialId) &&
          g?.activo &&
          g?.destino_id
        );
        if (!asignados.length) {
          console.log('ℹ️ Premio #' + (payload?.premio?.id ?? '-') + ': el comercial ' + comercialId + ' no tiene grupos de resultados asignados.');
          return;
        }

        for (const grupo of asignados) {
          await encolarNotificacionWhatsapp(
            supabase,
            'premio',
            payload?.premio?.id + ':' + String(grupo.cuenta_alias || 'principal'),
            String(grupo.destino_id).trim(),
            formatearPremio(payload),
            'Premio #' + (payload?.premio?.id ?? '-') + ' → ' + (grupo.nombre || grupo.destino_id),
            Number(comercialId),
            String(grupo.cuenta_alias || 'principal').trim().toLowerCase()
          );
        }
      } catch (error) {
        console.error('❌ No se pudo publicar el premio #' + (payload?.premio?.id ?? '-') + ' del comercial ' + comercialId + ':', error?.message || error);
      }
    });
  
}

async function conectarWhatsapp(supabase) {
  const makeWASocket = require('@whiskeysockets/baileys').default;
  const { DisconnectReason } = require('@whiskeysockets/baileys');

  // Suscribir el bus antes de esperar el lock de WhatsApp. Los eventos se
  // persisten en Supabase aunque Baileys todavía no esté conectado.
  suscribirBus(supabase);

  // En modo multi-comercial el sender NO abre una segunda sesión Baileys.
  // Los sockets comerciales son el único transporte WhatsApp.
  if (String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() === 'true') {
    console.log('🛡️ Sender WhatsApp global desactivado: usando transporte multi-comercial.');
    return null;
  }

  // Nunca abrir dos sockets del emisor dentro del mismo proceso.
  if (conexionEnCurso) return conexionEnCurso;
  if (sock) {
    suscribirBus(supabase);
    return sock;
  }

  const generacion = ++generacionConexion;
  conexionEnCurso = (async () => {

  if (!lockSesion) lockSesion = crearLockSesionWhatsapp(supabase);
  registrarApagadoOrdenado();
  // Si otro proceso ya sostiene la sesión (por ejemplo, la instancia vieja
  // de un deploy que aún no terminó), esperamos en vez de abrir un segundo
  // socket: eso es lo que corrompe las claves y provoca el bucle de QR.
  await lockSesion.esperarYAdquirir();

  authState = await useSupabaseAuthState(supabase);
  const { state, saveCreds } = authState;
  sock = makeWASocket({ auth: state, printQRInTerminal: false });
  const socketActual = sock;
  if (!global.__LOTO_WA_OUTBOX_TIMER__) {
    global.__LOTO_WA_OUTBOX_TIMER__ = setInterval(() => {
      if (ready && sock) vaciarOutboxWhatsapp(supabase).catch(() => {});
    }, 5000);
    if (global.__LOTO_WA_OUTBOX_TIMER__.unref) global.__LOTO_WA_OUTBOX_TIMER__.unref();
  }
  socketActual.__lotoSenderGeneration = generacion;
  socketActual.ev.on('creds.update', saveCreds);

  socketActual.ev.on('connection.update', async (update) => {
    // Ignorar eventos tardíos de un socket anterior.
    if (generacion !== generacionConexion || sock !== socketActual) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr && qr !== ultimoQr) {
      ultimoQr = qr;
      const now = Date.now();
      if (now - ultimoQrEnviadoAt >= QR_RESEND_INTERVAL_MS) {
        ultimoQrEnviadoAt = now;
        console.log('📲 Nuevo QR del WhatsApp emisor recibido. Se enviará como imagen al administrador de Telegram.');
        encolarEnvioQr(qr).catch(err => console.error('❌ Error procesando QR de WhatsApp:', err && err.stack ? err.stack : err));
      } else {
        console.log('⏳ Nuevo QR del emisor recibido; envío a Telegram omitido por throttle.');
      }
    }
    if (connection === 'open') {
      ready = true;
      ultimoQr = null;
      ultimoQrEnviadoAt = 0;
      console.log('✅ WhatsApp (Baileys) conectado.');
      vaciarOutboxWhatsapp(supabase).catch(err => console.error('❌ Error vaciando outbox WhatsApp:', err));
    }
    if (connection === 'close') {
      ready = false;

      // El socket ya no existe. Liberar el lease permite que otra instancia
      // del deploy tome la sesión sin esperar a que termine el TTL.
      await lockSesion?.liberar().catch(err =>
        console.error('⚠️ No se pudo liberar el lock del sender tras cerrar el socket:', err?.message || err)
      );

      const error = lastDisconnect?.error;
      const statusCode =
        Number(error?.output?.statusCode) ||
        Number(error?.data?.statusCode) ||
        Number(error?.statusCode) ||
        null;
      const reasonName = Object.entries(DisconnectReason).find(([, value]) => Number(value) === statusCode)?.[0] || 'UNKNOWN';

      console.error(
        '⚠️ Conexión de WhatsApp cerrada:',
        JSON.stringify({
          statusCode,
          reasonName,
          error: error?.message || String(error || ''),
          output: error?.output || null
        })
      );

      const loggedOut = statusCode === Number(DisconnectReason.loggedOut);

      if (loggedOut) {
        // 401 significa que WhatsApp invalidó/desvinculó la sesión. Mantener
        // las credenciales antiguas solo provoca un bucle de "Connection Failure".
        // Borramos únicamente la sesión global del sender; las sesiones de los
        // comerciales viven en whatsapp_comercial_session y no se tocan.
        try {
          const { error: deleteError } = await supabase
            .from('whatsapp_session')
            .delete()
            .eq('id', 'default');
          if (deleteError) throw deleteError;
          console.log('🧹 Sesión global de WhatsApp eliminada tras loggedOut (401).');
        } catch (deleteError) {
          console.error('❌ No se pudo limpiar la sesión global de WhatsApp:', deleteError?.message || deleteError);
        }

        if (sock === socketActual) sock = null;
        ultimoQr = null;
        generacionConexion++;
        console.log('📲 Se solicitará un QR nuevo para volver a vincular WhatsApp.');

        if (temporizadorReconectar) clearTimeout(temporizadorReconectar);
        temporizadorReconectar = setTimeout(() => {
          temporizadorReconectar = null;
          conectarWhatsapp(supabase).catch(err =>
            console.error('❌ Error iniciando nueva sesión WhatsApp:', err && err.stack ? err.stack : err)
          );
        }, 1500);
        return;
      }

      // 515/408/5xx y demás cierres transitorios conservan la sesión.
      if (sock === socketActual) sock = null;
      generacionConexion++;
      console.log('🔄 Cierre transitorio de WhatsApp; conservando sesión y reconectando en 3 s...');
      if (temporizadorReconectar) clearTimeout(temporizadorReconectar);
      temporizadorReconectar = setTimeout(() => {
        temporizadorReconectar = null;
        conectarWhatsapp(supabase).catch(err =>
          console.error('❌ Error reconectando WhatsApp:', err && err.stack ? err.stack : err)
        );
      }, 3000);
    }
  });

 return sock;
  })();

  try {
    return await conexionEnCurso;
  } finally {
    conexionEnCurso = null;
  }
}

function estaListo() { return ready; }

module.exports = { conectarWhatsapp, estaListo, formatearJugada, formatearResultado, formatearPremio, vaciarOutboxWhatsapp, probarResultadoWhatsapp };