// Cola de revisión humana para jugadas ambiguas.
// Se registra ANTES del flujo automático de apuestas y evita que una
// entrada ambigua llegue al motor o descuente saldo.

const { createClient } = require('@supabase/supabase-js');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(Number.isFinite);
}

function detectarAmbiguos(texto) {
  const encontrados = [];
  const regex = /(^|[^\d])([0-9]{4})(?=$|[^\d])/g;
  let match;
  while ((match = regex.exec(String(texto || ''))) !== null) encontrados.push(match[2]);
  return [...new Set(encontrados)];
}

function reemplazarAmbiguos(original, ambiguos, correccion) {
  let resultado = String(original || '');
  for (const numero of ambiguos) {
    const reemplazo = correccion[numero];
    if (!reemplazo) continue;
    const re = new RegExp(`(^|[^\\d])${numero}(?=$|[^\\d])`, 'g');
    resultado = resultado.replace(re, (_, prefijo) => `${prefijo}${reemplazo}`);
  }
  return resultado;
}

function parsearCorreccion(texto, ambiguos) {
  const raw = String(texto || '').trim();
  const mapa = {};

  // Formato completo para varias ambigüedades: 2585=25 85; 1234=12 34
  const asignaciones = raw.split(/[;\n]+/).map(x => x.trim()).filter(Boolean);
  const tieneAsignacion = asignaciones.some(x => /^\d{4}\s*=/.test(x));
  if (tieneAsignacion) {
    for (const parte of asignaciones) {
      const m = parte.match(/^(\d{4})\s*=\s*(.+)$/);
      if (!m) continue;
      mapa[m[1]] = m[2].trim();
    }
  } else if (ambiguos.length === 1) {
    mapa[ambiguos[0]] = raw;
  }

  for (const numero of ambiguos) {
    if (!mapa[numero]) return null;
    // La corrección no puede contener otro bloque aislado de 4 cifras.
    if (detectarAmbiguos(mapa[numero]).length) return null;
  }
  return mapa;
}

function nuevoUpdateId() {
  global.__HUMAN_REVIEW_UPDATE_ID__ = (global.__HUMAN_REVIEW_UPDATE_ID__ || 1000000) + 1;
  return global.__HUMAN_REVIEW_UPDATE_ID__;
}

async function registrarRevisionHumana(bot) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const adminIds = getAdminIds();
  const estados = new Map();

  async function avisarAdmins(pending) {
    const texto = [
      '⚠️ JUGADA REQUIERE ATENCIÓN HUMANA',
      '',
      `Solicitud #${pending.id}`,
      `Usuario: ${pending.user_telegram_id}`,
      `Lotería ID: ${pending.loteria_id}`,
      `Sorteo ID: ${pending.sorteo_id}`,
      `Jugada original: ${pending.original_input}`,
      `Número(s) ambiguo(s): ${pending.ambiguous_numbers.join(', ')}`,
      '',
      'La apuesta NO ha sido calculada ni cobrada.',
      'Pulsa Corregir para indicar la interpretación.'
    ].join('\n');

    const keyboard = {
      inline_keyboard: [
        [{ text: '✏️ Corregir jugada', callback_data: `review_edit_${pending.id}` }],
        [{ text: '❌ Rechazar', callback_data: `review_reject_${pending.id}` }]
      ]
    };

    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendMessage(adminId, texto, { reply_markup: keyboard });
      } catch (err) {
        console.error('❌ No se pudo notificar revisión humana:', err);
      }
    }
  }

  async function crearPendiente(ctx, texto, ambiguos) {
    const { data: existente, error: existenteError } = await supabase
      .from('pending_bets')
      .select('id,status,original_input')
      .eq('user_telegram_id', ctx.from.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (existenteError) throw existenteError;

    if (existente) {
      await ctx.reply(`⚠️ Ya tienes una jugada pendiente de revisión humana (#${existente.id}). No se ha realizado ningún cobro.`);
      return;
    }

    const { data: pref, error: prefError } = await supabase
      .from('user_preferences')
      .select('loteria_id,sorteo_id,moneda')
      .eq('telegram_id', ctx.from.id)
      .maybeSingle();
    if (prefError) throw prefError;
    if (!pref?.loteria_id || !pref?.sorteo_id) {
      await ctx.reply('🎲 Primero selecciona una lotería y un sorteo con /start.');
      return;
    }

    const { data: pending, error } = await supabase
      .from('pending_bets')
      .insert([{
        user_telegram_id: ctx.from.id,
        chat_id: ctx.chat.id,
        loteria_id: pref.loteria_id,
        sorteo_id: pref.sorteo_id,
        moneda: pref.moneda || 'cup',
        original_input: texto,
        ambiguous_numbers: ambiguos,
        status: 'pending'
      }])
      .select('*')
      .single();
    if (error) throw error;

    await ctx.reply(
      `⚠️ *Jugada requiere atención humana*\n\nSe detectó un número ambiguo de 4 cifras: *${ambiguos.join(', ')}*.\n\nEl bot no puede determinar de forma segura su interpretación.\n\n❌ *No se calculó ni se descontó saldo.*\n\nLa jugada quedó registrada como solicitud *#${pending.id}*. No necesitas pegarla nuevamente; atención humana podrá corregirla y procesarla.`,
      { parse_mode: 'Markdown' }
    );

    await avisarAdmins(pending);
  }

  // Debe registrarse ANTES de bet-handler.js. Si detecta ambigüedad, no llama next().
  bot.on('text', async (ctx, next) => {
    const texto = String(ctx.message?.text || '').trim();
    if (!texto || texto.startsWith('/')) return next();

    // El administrador puede estar introduciendo la corrección de una solicitud.
    if (adminIds.includes(ctx.from.id) && estados.has(ctx.from.id)) {
      const state = estados.get(ctx.from.id);
      estados.delete(ctx.from.id);

      try {
        const { data: pending, error } = await supabase
          .from('pending_bets')
          .select('*')
          .eq('id', state.pendingId)
          .eq('status', 'pending')
          .maybeSingle();
        if (error) throw error;
        if (!pending) {
          await ctx.reply('❌ La solicitud ya no está pendiente.');
          return;
        }

        const correccion = parsearCorreccion(texto, pending.ambiguous_numbers || []);
        if (!correccion) {
          estados.set(ctx.from.id, state);
          await ctx.reply(
            pending.ambiguous_numbers.length === 1
              ? `❌ Corrección no válida. Escribe cómo interpretar *${pending.ambiguous_numbers[0]}*, por ejemplo: \`25 85\`.`
              : '❌ Corrección no válida. Usa el formato: `2585=25 85; 1234=12 34`.',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const correctedInput = reemplazarAmbiguos(pending.original_input, pending.ambiguous_numbers, correccion);
        if (detectarAmbiguos(correctedInput).length) {
          estados.set(ctx.from.id, state);
          await ctx.reply('❌ La corrección todavía contiene un bloque ambiguo de 4 cifras. Indica explícitamente su separación.');
          return;
        }

        await supabase
          .from('pending_bets')
          .update({ corrected_input: correctedInput, reviewed_by: ctx.from.id, reviewed_at: new Date(), status: 'approved', updated_at: new Date() })
          .eq('id', pending.id)
          .eq('status', 'pending');

        await ctx.reply(`⏳ Procesando solicitud #${pending.id} con la corrección:\n\`${correctedInput}\``, { parse_mode: 'Markdown' });

        // Reinyecta la jugada corregida como si el usuario original la hubiera enviado.
        // Así reutilizamos TODO el flujo existente: parser, límites, saldo y RPC.
        await bot.handleUpdate({
          update_id: nuevoUpdateId(),
          message: {
            message_id: Math.floor(Date.now() / 1000),
            date: Math.floor(Date.now() / 1000),
            chat: { id: pending.chat_id, type: 'private' },
            from: { id: pending.user_telegram_id, is_bot: false, first_name: 'Usuario' },
            text: correctedInput
          }
        });

        await supabase
          .from('pending_bets')
          .update({ status: 'processed', updated_at: new Date() })
          .eq('id', pending.id)
          .eq('status', 'approved');
      } catch (err) {
        console.error('❌ Error procesando revisión humana:', err && err.stack ? err.stack : err);
        await supabase.from('pending_bets').update({ status: 'error', error_message: String(err?.message || err), updated_at: new Date() }).eq('id', state.pendingId);
        await ctx.reply('❌ No se pudo procesar la corrección. La solicitud quedó marcada con error para revisión.');
      }
      return;
    }

    const ambiguos = detectarAmbiguos(texto);
    if (!ambiguos.length) return next();

    try {
      await crearPendiente(ctx, texto, ambiguos);
    } catch (err) {
      console.error('❌ Error creando revisión humana:', err && err.stack ? err.stack : err);
      await ctx.reply('❌ No se pudo registrar la jugada para revisión humana. No se descontó ningún saldo.');
    }
  });

  bot.action(/^review_edit_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('❌ No autorizado.');
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase
      .from('pending_bets')
      .select('id,original_input,ambiguous_numbers,status')
      .eq('id', pendingId)
      .maybeSingle();
    if (error) return ctx.reply('❌ No se pudo cargar la solicitud.');
    if (!pending || pending.status !== 'pending') return ctx.reply('❌ Esta solicitud ya no está pendiente.');

    estados.set(ctx.from.id, { pendingId });
    const ejemplo = pending.ambiguous_numbers.length === 1
      ? `Escribe cómo interpretar *${pending.ambiguous_numbers[0]}*. Ejemplo: \`25 85\``
      : 'Escribe cada corrección como `2585=25 85; 1234=12 34`.';
    await ctx.reply(`✏️ *Corrección de solicitud #${pending.id}*\n\nJugada original:\n\`${pending.original_input}\`\n\n${ejemplo}\n\nNo se cobrará nada hasta que la jugada corregida pase nuevamente por el motor y las validaciones.`, { parse_mode: 'Markdown' });
  });

  bot.action(/^review_reject_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('❌ No autorizado.');
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase
      .from('pending_bets')
      .select('user_telegram_id,status')
      .eq('id', pendingId)
      .maybeSingle();
    if (error || !pending) return ctx.reply('❌ Solicitud no encontrada.');
    if (pending.status !== 'pending') return ctx.reply('ℹ️ La solicitud ya fue atendida.');

    await supabase.from('pending_bets').update({ status: 'rejected', reviewed_by: ctx.from.id, reviewed_at: new Date(), updated_at: new Date() }).eq('id', pendingId).eq('status', 'pending');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.reply(`❌ Solicitud #${pendingId} rechazada. No se realizó ningún cobro.`);
    try { await bot.telegram.sendMessage(pending.user_telegram_id, `❌ La jugada pendiente #${pendingId} fue rechazada por atención humana. No se descontó saldo.`); } catch (_) {}
  });

  bot.command('revision', async ctx => {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('❌ No autorizado.');
    const { data: rows, error } = await supabase
      .from('pending_bets')
      .select('id,user_telegram_id,original_input,ambiguous_numbers,created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20);
    if (error) return ctx.reply('❌ No se pudieron cargar las revisiones.');
    if (!rows?.length) return ctx.reply('📋 No hay jugadas pendientes de revisión humana.');
    const texto = rows.map(r => `#${r.id} — Usuario ${r.user_telegram_id}\n${r.original_input}\nAmbiguo: ${(r.ambiguous_numbers || []).join(', ')}`).join('\n\n');
    await ctx.reply(`📋 *Revisiones pendientes*\n\n${texto}`, { parse_mode: 'Markdown' });
  });

  console.log('✅ Cola de revisión humana registrada');
}

module.exports = { registrarRevisionHumana };
