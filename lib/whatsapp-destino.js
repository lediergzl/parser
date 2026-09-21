const DESTINO_ID = 1;

function obtenerAdminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(Number.isFinite);
}

function normalizarPv(valor) {
  let numero = String(valor || '').trim();
  numero = numero.replace(/[^0-9]/g, '');
  if (!numero) return null;
  return `${numero}@s.whatsapp.net`;
}

function normalizarGrupo(valor) {
  const id = String(valor || '').trim();
  if (!id) return null;
  if (id.endsWith('@g.us')) return id;
  return `${id}@g.us`;
}

async function leerDestino(supabase) {
  const { data, error } = await supabase
    .from('whatsapp_destino')
    .select('tipo, destino_id, nombre')
    .eq('id', DESTINO_ID)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function guardarDestino(supabase, tipo, destinoId, nombre) {
  const { error } = await supabase
    .from('whatsapp_destino')
    .upsert({
      id: DESTINO_ID,
      tipo,
      destino_id: destinoId,
      nombre: nombre || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

  if (error) throw error;
  process.env.WA_GROUP_ID = destinoId;
}

async function listarGruposResultados(supabase) {
  const { data, error } = await supabase
    .from('whatsapp_resultados_grupos')
    .select('destino_id,nombre,activo,autorizado_por,created_at,updated_at')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function autorizarGrupoResultados(supabase, destinoId, nombre, autorizadoPor) {
  const grupo = normalizarGrupo(destinoId);
  if (!grupo) throw new Error('ID de grupo inválido.');

  const { data, error } = await supabase
    .from('whatsapp_resultados_grupos')
    .upsert({
      destino_id: grupo,
      nombre: nombre || null,
      activo: true,
      autorizado_por: Number.isFinite(Number(autorizadoPor)) ? Number(autorizadoPor) : null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'destino_id' })
    .select('destino_id,nombre,activo,autorizado_por,created_at,updated_at')
    .single();

  if (error) throw error;
  return data;
}

async function desautorizarGrupoResultados(supabase, destinoId) {
  const grupo = normalizarGrupo(destinoId);
  if (!grupo) throw new Error('ID de grupo inválido.');

  const { error } = await supabase
    .from('whatsapp_resultados_grupos')
    .update({ activo: false, updated_at: new Date().toISOString() })
    .eq('destino_id', grupo);

  if (error) throw error;
  return grupo;
}

function textoDestino(destino) {
  if (!destino) {
    return [
      '📱 *DESTINO WHATSAPP*',
      '',
      '❌ No hay un destino configurado.',
      '',
      '*Para grupo:*',
      '`/wa_destino grupo ID_DEL_GRUPO`',
      '',
      '*Para privado:*',
      '`/wa_destino pv NUMERO`',
      '',
      'Ejemplo grupo:',
      '`/wa_destino grupo 120363xxxxxxxx@g.us`',
      '',
      'Ejemplo privado:',
      '`/wa_destino pv 53512345678`'
    ].join('\\n');
  }

  return [
    '📱 *DESTINO WHATSAPP ACTUAL*',
    '',
    `Tipo: *${destino.tipo === 'grupo' ? 'Grupo 👥' : 'Privado 👤'}*`,
    `Nombre: ${destino.nombre || 'Sin nombre'}`,
    `ID: \`${destino.destino_id}\``,
    '',
    'Para cambiarlo usa:',
    '`/wa_destino grupo ID_DEL_GRUPO`',
    '`/wa_destino pv NUMERO`'
  ].join('\\n');
}

function textoGruposResultados(grupos) {
  if (!grupos.length) {
    return [
      '📢 *GRUPOS AUTORIZADOS PARA RESULTADOS*',
      '',
      '❌ No hay grupos autorizados.',
      '',
      'Autoriza uno con:',
      '`/wa_resultados agregar ID_DEL_GRUPO Nombre opcional`'
    ].join('\\n');
  }

  return [
    '📢 *GRUPOS AUTORIZADOS PARA RESULTADOS*',
    '',
    ...grupos.map((g, i) =>
      `${i + 1}. ${g.activo ? '🟢' : '🔴'} ${g.nombre || 'Grupo WhatsApp'}\\n   ID: \`${g.destino_id}\``
    ),
    '',
    'Para quitar uno:',
    '`/wa_resultados quitar ID_DEL_GRUPO`'
  ].join('\\n');
}

function esAdmin(ctx) {
  const id = Number(ctx?.from?.id);
  return obtenerAdminIds().includes(id);
}

async function registrarComandosTelegram(supabase) {
  const bot = global.__LOTO_BOT__;
  if (!bot || typeof bot.command !== 'function') {
    console.warn('⚠️ No se encontró el bot de Telegram para registrar comandos de destino WhatsApp.');
    return false;
  }

  bot.command('wa_destino', async (ctx) => {
    if (!esAdmin(ctx)) return;

    const partes = String(ctx.message?.text || '').trim().split(/\\s+/);
    const tipo = String(partes[1] || '').toLowerCase();
    const valor = partes.slice(2).join(' ').trim();

    if (!tipo || !valor || !['grupo', 'pv', 'privado'].includes(tipo)) {
      const destino = await leerDestino(supabase).catch(() => null);
      return ctx.reply(textoDestino(destino), { parse_mode: 'Markdown' });
    }

    try {
      let destinoId;
      let nombre = null;

      if (tipo === 'grupo') {
        destinoId = normalizarGrupo(valor);
        if (!destinoId) throw new Error('ID de grupo inválido.');
        nombre = 'Grupo WhatsApp';
      } else {
        destinoId = normalizarPv(valor);
        if (!destinoId) throw new Error('Número de WhatsApp inválido.');
        nombre = `PV ${valor}`;
      }

      await guardarDestino(supabase, tipo === 'grupo' ? 'grupo' : 'pv', destinoId, nombre);

      await ctx.reply([
        '✅ *Destino WhatsApp guardado*',
        '',
        `Tipo: *${tipo === 'grupo' ? 'Grupo 👥' : 'Privado 👤'}*`,
        `ID: \`${destinoId}\``,
        '',
        'Las próximas jugadas procesadas se enviarán allí.',
        '',
        'Puedes comprobarlo con `/wa_ver_destino`.'
      ].join('\\n'), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('❌ Error configurando destino WhatsApp:', error);
      await ctx.reply(`❌ No se pudo guardar el destino: ${error.message || error}`);
    }
  });

  bot.command('wa_ver_destino', async (ctx) => {
    if (!esAdmin(ctx)) return;
    try {
      const destino = await leerDestino(supabase);
      await ctx.reply(textoDestino(destino), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('❌ Error leyendo destino WhatsApp:', error);
      await ctx.reply(`❌ No se pudo consultar el destino: ${error.message || error}`);
    }
  });

  bot.command('wa_resultados', async (ctx) => {
    if (!esAdmin(ctx)) return;

    const partes = String(ctx.message?.text || '').trim().split(/\\s+/);
    const accion = String(partes[1] || 'lista').toLowerCase();

    try {
      if (accion === 'lista' || accion === 'listar') {
        return ctx.reply(textoGruposResultados(await listarGruposResultados(supabase)), { parse_mode: 'Markdown' });
      }

      if (accion === 'agregar' || accion === 'autorizar') {
        const id = partes[2];
        const nombre = partes.slice(3).join(' ').trim() || null;
        if (!id) {
          return ctx.reply(
            'Uso: `/wa_resultados agregar ID_DEL_GRUPO Nombre opcional`',
            { parse_mode: 'Markdown' }
          );
        }

        const grupo = await autorizarGrupoResultados(supabase, id, nombre, ctx.from.id);
        return ctx.reply([
          '✅ *Grupo autorizado para resultados*',
          '',
          `👥 ${grupo.nombre || 'Grupo WhatsApp'}`,
          `🆔 \`${grupo.destino_id}\`` ,
          '',
          'A partir de ahora los resultados de los sorteos se publicarán automáticamente en este grupo.',
          '',
          'Comprueba la lista con `/wa_resultados lista`.'
        ].join('\\n'), { parse_mode: 'Markdown' });
      }

      if (accion === 'quitar' || accion === 'desautorizar' || accion === 'eliminar') {
        const id = partes[2];
        if (!id) {
          return ctx.reply(
            'Uso: `/wa_resultados quitar ID_DEL_GRUPO`',
            { parse_mode: 'Markdown' }
          );
        }

        const grupo = await desautorizarGrupoResultados(supabase, id);
        return ctx.reply([
          '🔴 *Grupo desautorizado*',
          '',
          `🆔 \`${grupo}\``,
          '',
          'No recibirá nuevos resultados.'
        ].join('\\n'), { parse_mode: 'Markdown' });
      }

      return ctx.reply([
        '📢 *CONFIGURACIÓN DE RESULTADOS WHATSAPP*',
        '',
        '`/wa_resultados lista` — ver grupos autorizados',
        '`/wa_resultados agregar ID Nombre` — autorizar grupo',
        '`/wa_resultados quitar ID` — dejar de publicar allí'
      ].join('\\n'), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('❌ Error gestionando grupos de resultados WhatsApp:', error);
      await ctx.reply(`❌ No se pudo actualizar los grupos de resultados: ${error.message || error}`);
    }
  });

  console.log('✅ Comandos /wa_destino, /wa_ver_destino y /wa_resultados registrados.');
  return true;
}

async function registrarControlDestino(supabase) {
  const destino = await leerDestino(supabase);
  if (destino?.destino_id) {
    process.env.WA_GROUP_ID = destino.destino_id;
    console.log(`📤 Destino WhatsApp cargado: ${destino.tipo} ${destino.destino_id}`);
  } else if (process.env.WA_GROUP_ID) {
    await guardarDestino(
      supabase,
      process.env.WA_GROUP_ID.endsWith('@g.us') ? 'grupo' : 'pv',
      process.env.WA_GROUP_ID,
      'Destino inicial de Render'
    );
    console.log(`📤 Destino WhatsApp inicial guardado desde WA_GROUP_ID: ${process.env.WA_GROUP_ID}`);
  } else {
    console.log('ℹ️ No hay destino WhatsApp configurado todavía. Usa /wa_destino.');
  }

  await registrarComandosTelegram(supabase);
}

module.exports = {
  registrarControlDestino,
  leerDestino,
  guardarDestino,
  listarGruposResultados,
  autorizarGrupoResultados,
  desautorizarGrupoResultados
};