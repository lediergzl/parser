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

async function enviarNotificacionWhatsapp(destinoId, texto, etiqueta) {
  if (!destinoId) {
    console.log(`ℹ️ Sin destino WhatsApp; se omite notificación ${etiqueta}.`);
    return false;
  }
  if (!ready || !sock) {
    if (colaNotificaciones.length < 100) {
      colaNotificaciones.push({ destinoId, texto, etiqueta });
      console.log(`⏳ WhatsApp no está listo; notificación ${etiqueta} puesta en cola.`);
    } else console.error(`❌ Cola de WhatsApp llena; se descartó notificación ${etiqueta}.`);
    return false;
  }
  try {
    await sock.sendMessage(destinoId, { text: texto });
    console.log(`✅ ${etiqueta} enviado por WhatsApp (Baileys).`);
    return true;
  } catch (err) {
    console.error(`❌ Error enviando ${etiqueta} a WhatsApp:`, err && err.stack ? err.stack : err);
    return false;
  }
}

async function vaciarColaNotificacionesWhatsapp() {
  if (!ready || !sock || !colaNotificaciones.length) return;
  while (ready && sock && colaNotificaciones.length) {
    const item = colaNotificaciones.shift();
    const ok = await enviarNotificacionWhatsapp(item.destinoId, item.texto, item.etiqueta);
    if (!ok && !ready) { colaNotificaciones.unshift(item); break; }
  }
}

async function conectarWhatsapp(supabase) {
  const makeWASocket = require('@whiskeysockets/baileys').default;
  const { DisconnectReason } = require('@whiskeysockets/baileys');

  // Nunca abrir dos sockets del emisor dentro del mismo proceso.
  if (conexionEnCurso) return conexionEnCurso;
  if (sock) return sock;

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
      vaciarColaNotificacionesWhatsapp().catch(err => console.error('❌ Error vaciando cola de notificaciones WhatsApp:', err));
    }
    if (connection === 'close') {
      ready = false;

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

  if (!suscrito) {
    suscrito = true;

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
      if (!ready || !sock) {
        if (colaNotificaciones.length < 100) {
          colaNotificaciones.push({ destinoId, texto, etiqueta: `Jugada #${jugada?.betId ?? '-'}`, betId: jugada?.betId });
          console.log(`⏳ WhatsApp no está listo; jugada #${jugada?.betId ?? '-'} puesta en cola.`);
        } else {
          console.error(`❌ Cola de WhatsApp llena; se descartó jugada #${jugada?.betId ?? '-'}.`);
        }
        return;
      }

      try {
        await sock.sendMessage(destinoId, { text: texto });
        bus.emit('jugada:enviada_wa', { betId: jugada?.betId, destinoId });
        console.log(`✅ Jugada #${jugada?.betId ?? '-'} enviada por WhatsApp (Baileys).`);
      } catch (err) {
        console.error('❌ Error enviando a WhatsApp (Baileys):', err && err.stack ? err.stack : err);
        if (colaNotificaciones.length < 100) {
          colaNotificaciones.push({ destinoId, texto, etiqueta: `Jugada #${jugada?.betId ?? '-'}`, betId: jugada?.betId });
        }
      }
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

      // El resultado general se publica en los grupos públicos autorizados
      // y también en el grupo asignado a cada comercial. Si coinciden, se
      // envía una sola vez.
      const destinos = new Map();
      for (const grupo of gruposPublicos) {
        destinos.set(String(grupo.destino_id).trim(), {
          nombre: grupo.nombre || 'Grupo público de resultados'
        });
      }
      for (const grupo of gruposComerciales) {
        const id = String(grupo.destino_id).trim();
        if (!destinos.has(id)) {
          destinos.set(id, { nombre: grupo.nombre || ('Grupo del comercial ' + grupo.comercial_telegram_id) });
        }
      }

      if (!destinos.size) {
        console.log('ℹ️ Resultado recibido, pero no hay grupos WhatsApp autorizados.');
        return;
      }

      let enviados = 0;
      for (const [destinoId, meta] of destinos) {
        try {
          const ok = await enviarNotificacionWhatsapp(
            destinoId,
            texto,
            'Resultado #' + (resultado?.resultadoId ?? '-') + ' → ' + meta.nombre
          );
          if (ok) enviados++;
        } catch (error) {
          console.error('❌ Error publicando resultado #' + (resultado?.resultadoId ?? '-') + ' en ' + destinoId + ':', error?.message || error);
        }
      }

      console.log('📢 Resultado #' + (resultado?.resultadoId ?? '-') + ' publicado en ' + destinos.size + ' grupo(s); enviados ahora: ' + enviados + '.');
    });

    bus.on('premio:detectado', async (payload) => {
      const comercialId = payload?.bet?.comercial_telegram_id;
      if (comercialId == null) {
        console.log('ℹ️ Premio #' + (payload?.premio?.id ?? '-') + ' sin comercial asociado; no se publica en grupo WhatsApp.');
        return;
      }

      try {
        const grupo = await leerGrupoResultadosComercial(supabase, comercialId);
        if (!grupo?.activo || !grupo?.destino_id) {
          console.log('ℹ️ Premio #' + (payload?.premio?.id ?? '-') + ': el comercial ' + comercialId + ' no tiene grupo de resultados asignado.');
          return;
        }

        await enviarNotificacionWhatsapp(
          String(grupo.destino_id).trim(),
          formatearPremio(payload),
          'Premio #' + (payload?.premio?.id ?? '-') + ' → ' + (grupo.nombre || grupo.destino_id)
        );
      } catch (error) {
        console.error('❌ No se pudo publicar el premio #' + (payload?.premio?.id ?? '-') + ' del comercial ' + comercialId + ':', error?.message || error);
      }
    });
  }
  return sock;
  })();

  try {
    return await conexionEnCurso;
  } finally {
    conexionEnCurso = null;
  }
}

function estaListo() { return ready; }

module.exports = { conectarWhatsapp, estaListo, formatearJugada, formatearResultado, formatearPremio };
