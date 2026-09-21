  if (!Number.isFinite(id)) throw new Error('ID de comercial inválido.');

  const sender = require('./whatsapp-comerciales');
  const canal = await sender.resolverCanalWhatsAppPorEnlace(id, enlace);

  const r = await supabase
    .from('whatsapp_estadisticas_canales')
    .upsert({
      comercial_telegram_id: id,
      enlace: canal.enlace,
      destino_id: canal.destino_id,
      nombre: canal.nombre,
      activo: true,
      actualizado_at: new Date().toISOString()
    }, { onConflict: 'comercial_telegram_id' });

  if (r.error) throw r.error;
  return canal;
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
      if (accion === 'canal') {
        if (!Number.isFinite(id)) return ctx.reply('Uso: /estadisticas canal ID_COMERCIAL ENLACE_CANAL');

        const enlace = p.slice(3).join(' ').trim();
        if (!enlace) {
          const r = await supabase
            .from('whatsapp_estadisticas_canales')
            .select('enlace,destino_id,nombre,activo')
            .eq('comercial_telegram_id', id)
            .maybeSingle();
          if (r.error) throw r.error;
          if (!r.data) return ctx.reply('ℹ️ El comercial ' + id + ' no tiene canal de estadísticas configurado.');
          return ctx.reply([
            '📣 Canal de estadísticas — ' + id,
            'Estado: ' + (r.data.activo ? '🟢 ACTIVO' : '🔴 INACTIVO'),
            'Nombre: ' + (r.data.nombre || '—'),
            'JID: ' + r.data.destino_id,
            'Enlace: ' + r.data.enlace
          ].join('\\n'));
        }

        const enlaceNormalizado = String(enlace || '').trim();
        const tieneCanal = (() => {
          const s = enlaceNormalizado.toLowerCase();
          const pos = s.indexOf('/channel/');
          if (pos < 0) return false;
          const prefijo = s.slice(0, pos);
          return prefijo === 'whatsapp.com' ||
            prefijo === 'www.whatsapp.com' ||
            prefijo === 'http://whatsapp.com' ||
            prefijo === 'https://whatsapp.com' ||
            prefijo === 'http://www.whatsapp.com' ||
            prefijo === 'https://www.whatsapp.com';
        })();

        if (!tieneCanal) {
          return ctx.reply('❌ Debes indicar el enlace del canal de WhatsApp. Ejemplo: https://whatsapp.com/channel/...');
        }

        const canal = await configurarCanal(id, enlace);
        return ctx.reply([
          '✅ Canal de estadísticas configurado.',
          'Comercial: ' + id,
          'Canal: ' + canal.nombre,
          'JID: ' + canal.destino_id
        ].join('\\n'));
      }

      if (accion === 'probar_canal') {
        if (!Number.isFinite(id)) return ctx.reply('Uso: /estadisticas probar_canal ID_COMERCIAL');

        const canal = await supabase
          .from('whatsapp_estadisticas_canales')
          .select('destino_id,nombre,enlace,activo')
          .eq('comercial_telegram_id', id)
          .maybeSingle();

        if (canal.error) throw canal.error;
        if (!canal.data) return ctx.reply('❌ El comercial ' + id + ' no tiene un canal de estadísticas configurado.');
        if (!canal.data.activo) return ctx.reply('❌ El canal de estadísticas del comercial ' + id + ' está inactivo.');

        const sender = require('./whatsapp-comerciales');
        const texto = [
          '🧪 *PRUEBA DEL CANAL DE ESTADÍSTICAS*',
          '',
          'Esta publicación es una prueba técnica.',
          'Si la recibes en este canal, Baileys puede entregar correctamente las estadísticas al destino configurado.',
          '',
          '👤 Comercial: ' + id,
          '📣 Canal: ' + (canal.data.nombre || canal.data.destino_id),
          '🆔 JID: ' + canal.data.destino_id,
          '🕒 Prueba: ' + new Date().toLocaleString('es-CU', { timeZone: TZ_CUBA })
        ].join('\\n');

        const resultado = await sender.enviarMensajePorComercial(
          supabase,
          id,
          canal.data.destino_id,
          '',
          { payload: { text: texto } }
        );

        console.log(
          '🧪 Prueba canal estadísticas enviada: comercial=' + id +
          ' destino=' + canal.data.destino_id +
          ' resultado=' + String(resultado)
        );

        return ctx.reply([
          '✅ PRUEBA ENVIADA AL CANAL',
          '',
          'Comercial: ' + id,
          'Canal: ' + (canal.data.nombre || canal.data.destino_id),
          'JID: ' + canal.data.destino_id,
          '',
          'Baileys aceptó el envío. Ahora comprueba el mensaje dentro del canal.'
        ].join('\\n'));
      }

      if (accion === 'estado') {
        if (!Number.isFinite(id)) return ctx.reply('Uso: /estadisticas estado ID_COMERCIAL');
        const r = await supabase.from('whatsapp_estadisticas_modulo').select('*').eq('comercial_telegram_id',id).maybeSingle();
        if (r.error) throw r.error; if (!r.data) return ctx.reply('ℹ️ El comercial ' + id + ' no tiene el módulo configurado.');
        const vigente = r.data.habilitado && (!r.data.fecha_vencimiento || new Date(r.data.fecha_vencimiento).getTime() >= Date.now());
        return ctx.reply(['📊 Estadísticas — ' + id,'Estado: ' + (vigente ? '🟢 HABILITADO' : '🔴 NO VIGENTE'),'Inicio: ' + (r.data.fecha_inicio ? new Date(r.data.fecha_inicio).toLocaleString('es-CU',{timeZone:TZ_CUBA}) : '—'),'Vencimiento: ' + (r.data.fecha_vencimiento ? new Date(r.data.fecha_vencimiento).toLocaleString('es-CU',{timeZone:TZ_CUBA}) : 'sin vencimiento')].join('\n'));
      }
      return ctx.reply('/estadisticas activar ID DIAS\n/estadisticas desactivar ID\n/estadisticas estado ID\n/estadisticas canal ID [ENLACE_CANAL]');
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