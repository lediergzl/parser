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
    ].join('\n');
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
  ].join('\n');
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

    const partes = String(ctx.message?.text || '').trim().split(/\s+/);
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
      ].join('\n'), { parse_mode: 'Markdown' });
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

  console.log('✅ Comandos /wa_destino y /wa_ver_destino registrados.');
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

module.exports = { registrarControlDestino, leerDestino, guardarDestino };