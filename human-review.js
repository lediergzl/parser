// Cola de revisión humana para jugadas ambiguas.
const { createClient } = require('@supabase/supabase-js');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
}

function detectarAmbiguos(texto) {
  const encontrados = [];
  const regex = /(^|[^\d])([0-9]{4})(?=$|[^\d])/g;
  let match;
  while ((match = regex.exec(String(texto || ''))) !== null) {
    // Un bloque de 4 cifras inmediatamente después de "con" o "a" es un monto.
    const antes = String(texto || '').slice(0, match.index + match[1].length);
    if (/\b(?:con|a)\s*$/i.test(antes)) continue;
    encontrados.push(match[2]);
  }
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

function extraerCorreccionDeJugadaParcial(original, ambiguo, raw) {
  const textoOriginal = String(original || '').trim();
  const texto = String(raw || '').trim();
  const indice = textoOriginal.indexOf(ambiguo);
  if (indice < 0) return null;
  const prefijo = textoOriginal.slice(0, indice).trim();
  const sufijo = textoOriginal.slice(indice + ambiguo.length).trim();
  if (prefijo && texto.startsWith(prefijo) && (!sufijo || texto.endsWith(sufijo))) return { __fullInput: texto };
  if (sufijo && texto.endsWith(sufijo)) {
    const posibleReemplazo = texto.slice(0, -sufijo.length).trim();
    if (posibleReemplazo) return { [ambiguo]: posibleReemplazo };
  }
  if (!prefijo && texto) return { [ambiguo]: texto };
  return null;
}

function parsearCorreccion(texto, ambiguos, original) {
  const raw = String(texto || '').trim();
  const mapa = {};
  if (ambiguos.length === 1 && !/^\d{4}\s*=/.test(raw)) {
    const especial = extraerCorreccionDeJugadaParcial(original, ambiguos[0], raw);
    if (especial) {
      if (especial.__fullInput) return especial;
      if (!detectarAmbiguos(especial[ambiguos[0]]).length) return especial;
    }
  }
  const asignaciones = raw.split(/[;\n]+/).map(x => x.trim()).filter(Boolean);
  const tieneAsignacion = asignaciones.some(x => /^\d{4}\s*=/.test(x));
  if (tieneAsignacion) {
    for (const parte of asignaciones) {
      const m = parte.match(/^(\d{4})\s*=\s*(.+)$/);
      if (!m) continue;
      mapa[m[1]] = m[2].trim();
    }
  } else if (ambiguos.length === 1) mapa[ambiguos[0]] = raw;
  for (const numero of ambiguos) {
    if (!mapa[numero]) return null;
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
      '⚠️ JUGADA REQUIERE ATENCIÓN HUMANA', '',
      `Solicitud #${pending.id}`,
      `Usuario: ${pending.user_telegram_id}`,
      `Lotería ID: ${pending.loteria_id}`,
      `Sorteo ID: ${pending.sorteo_id}`,
      `Jugada original: ${pending.original_input}`,
      `Número(s) ambiguo(s): ${pending.ambiguous_numbers.join(', ')}`, '',
      'La apuesta NO ha sido calculada ni cobrada.',
      'Pulsa Corregir para indicar la interpretación.'
    ].join('\n');
    const keyboard = { inline_keyboard: [[{ text: '✏️ Corregir jugada', callback_data: `review_edit_${pending.id}` }], [{ text: '❌ Rechazar', callback_data: `review_reject_${pending.id}` }]] };
    for (const adminId of adminIds) {
      try { await bot.telegram.sendMessage(adminId, texto, { reply_markup: keyboard }); } catch (err) { console.error('❌ No se pudo notificar revisión humana:', err); }
    }
  }

  async function crearPendiente(ctx, texto, ambiguos) {
    const { data: existente, error: existenteError } = await supabase.from('pending_bets').select('id,status,original_input').eq('user_telegram_id', ctx.from.id).eq('status', 'pending').maybeSingle();
    if (existenteError) throw existenteError;
    if (existente) {
      await ctx.reply(`⚠️ Ya tienes una jugada pendiente de revisión humana (#${existente.id}). No se ha realizado ningún cobro.`);
      return;
    }
    const { data: pref, error: prefError } = await supabase.from('user_preferences').select('loteria_id,sorteo_id,moneda').eq('telegram_id', ctx.from.id).maybeSingle();
    if (prefError) throw prefError;
    if (!pref?.loteria_id || !pref?.sorteo_id) {
      await ctx.reply('🎲 Primero selecciona una lotería y un sorteo con /start.');
      return;
    }
    const { data: pending, error } = await supabase.from('pending_bets').insert([{
      user_telegram_id: ctx.from.id, chat_id: ctx.chat.id, loteria_id: pref.loteria_id, sorteo_id: pref.sorteo_id,
      moneda: pref.moneda || 'cup', original_input: texto, ambiguous_numbers: ambiguos, status: 'pending'
    }]).select('*').single();
    if (error) throw error;
    await ctx.reply(`⚠️ *Jugada requiere atención humana*\n\nSe detectó un número ambiguo de 4 cifras: *${ambiguos.join(', ')}*.\n\nEl bot no puede determinar de forma segura su interpretación.\n\n❌ *No se calculó ni se descontó saldo.*\n\nLa jugada quedó registrada como solicitud *#${pending.id}*. No necesitas pegarla nuevamente; atención humana podrá corregirla y procesarla.`, { parse_mode: 'Markdown' });
    await avisarAdmins(pending);
  }

  bot.on('text', async (ctx, next) => {
    const texto = String(ctx.message?.text || '').trim();
    if (!texto || texto.startsWith('/')) return next();
    if (adminIds.includes(ctx.from.id) && estados.has(ctx.from.id)) {
      const state = estados.get(ctx.from.id);
      estados.delete(ctx.from.id);
      try {
        const { data: pending, error } = await supabase.from('pending_bets').select('*').eq('id', state.pendingId).eq('status', 'pending').maybeSingle();
        if (error) throw error;
        if (!pending) { await ctx.reply('❌ La solicitud ya no está pendiente.'); return; }
        const correccion = parsearCorreccion(texto, pending.ambiguous_numbers || [], pending.original_input);
        if (!correccion) {
          estados.set(ctx.from.id, state);
          await ctx.reply(pending.ambiguous_numbers.length === 1
            ? `❌ Corrección no válida. Escribe cómo interpretar *${pending.ambiguous_numbers[0]}*, por ejemplo: \`25 85\`, o pega la jugada completa ya corregida.`
            : '❌ Corrección no válida. Usa `2585=25 85; 1234=12 34` o pega la jugada completa corregida.', { parse_mode: 'Markdown' });
          return;
        }
        const correctedInput = correccion.__fullInput ? correccion.__fullInput : reemplazarAmbiguos(pending.original_input, pending.ambiguous_numbers, correccion);
        if (detectarAmbiguos(correctedInput).length) {
          estados.set(ctx.from.id, state);
          await ctx.reply('❌ La corrección todavía contiene un bloque ambiguo de 4 cifras. Indica explícitamente su separación.');
          return;
        }
        const { error: updateError } = await supabase.from('pending_bets').update({ corrected_input: correctedInput, reviewed_by: ctx.from.id, reviewed_at: new Date(), status: 'approved', updated_at: new Date() }).eq('id', pending.id).eq('status', 'pending');
        if (updateError) throw updateError;
        await ctx.reply(`⏳ Procesando solicitud #${pending.id} con la corrección:\n\`${correctedInput}\``, { parse_mode: 'Markdown' });
        await bot.handleUpdate({ update_id: nuevoUpdateId(), message: {
          message_id: Math.floor(Date.now() / 1000), date: Math.floor(Date.now() / 1000),
          chat: { id: pending.chat_id, type: 'private' },
          from: { id: pending.user_telegram_id, is_bot: false, first_name: 'Usuario' }, text: correctedInput
        }});
        const { data: bet, error: betError } = await supabase.from('bets').select('id,total_apuesta,saldo_antes,saldo_despues').eq('user_telegram_id', pending.user_telegram_id).eq('input_raw', correctedInput).order('id', { ascending: false }).limit(1).maybeSingle();
        if (betError) throw betError;
        if (!bet) {
          await supabase.from('pending_bets').update({ status: 'error', error_message: 'El flujo de apuesta no registró una apuesta después de la revisión.', updated_at: new Date() }).eq('id', pending.id).eq('status', 'approved');
          await ctx.reply(`⚠️ La solicitud #${pending.id} no fue marcada como procesada porque no se encontró una apuesta registrada. No se debe repetir el cobro hasta revisar el motivo.`);
          return;
        }
        await supabase.from('pending_bets').update({ status: 'processed', updated_at: new Date() }).eq('id', pending.id).eq('status', 'approved');
      } catch (err) {
        console.error('❌ Error procesando revisión humana:', err && err.stack ? err.stack : err);
        await supabase.from('pending_bets').update({ status: 'error', error_message: String(err?.message || err), updated_at: new Date() }).eq('id', state.pendingId);
        await ctx.reply('❌ No se pudo procesar la corrección. La solicitud quedó marcada con error para revisión.');
      }
      return;
    }
    const ambiguos = detectarAmbiguos(texto);
    if (!ambiguos.length) return next();
    try { await crearPendiente(ctx, texto, ambiguos); }
    catch (err) { console.error('❌ Error creando revisión humana:', err && err.stack ? err.stack : err); await ctx.reply('❌ No se pudo registrar la jugada para revisión humana. No se descontó ningún saldo.'); }
  });

  bot.action(/^review_edit_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('❌ No autorizado.');
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase.from('pending_bets').select('id,original_input,ambiguous_numbers,status').eq('id', pendingId).maybeSingle();
    if (error) return ctx.reply('❌ No se pudo cargar la solicitud.');
    if (!pending || pending.status !== 'pending') return ctx.reply('❌ Esta solicitud ya no está pendiente.');
    estados.set(ctx.from.id, { pendingId });
    const ejemplo = pending.ambiguous_numbers.length === 1 ? `Escribe cómo interpretar *${pending.ambiguous_numbers[0]}*. Ejemplo: \`25 85\`\n\nTambién puedes pegar la jugada completa ya corregida.` : 'Escribe cada corrección como `2585=25 85; 1234=12 34`, o pega la jugada completa corregida.';
    await ctx.reply(`✏️ *Corrección de solicitud #${pending.id}*\n\nJugada original:\n\`${pending.original_input}\`\n\n${ejemplo}\n\nNo se cobrará nada hasta que la jugada corregida pase nuevamente por el motor y las validaciones.`, { parse_mode: 'Markdown' });
  });

  bot.action(/^review_reject_(\d+)$/, async ctx => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('❌ No autorizado.');
    const pendingId = Number(ctx.match[1]);
    const { data: pending, error } = await supabase.from('pending_bets').select('user_telegram_id,status').eq('id', pendingId).maybeSingle();
    if (error || !pending) return ctx.reply('❌ Solicitud no encontrada.');
    if (pending.status !== 'pending') return ctx.reply('ℹ️ La solicitud ya fue atendida.');
    await supabase.from('pending_bets').update({ status: 'rejected', reviewed_by: ctx.from.id, reviewed_at: new Date(), updated_at: new Date() }).eq('id', pendingId).eq('status', 'pending');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.reply(`❌ Solicitud #${pendingId} rechazada. No se realizó ningún cobro.`);
    try { await bot.telegram.sendMessage(pending.user_telegram_id, `❌ La jugada pendiente #${pendingId} fue rechazada por atención humana. No se descontó saldo.`); } catch (_) {}
  });

  bot.command('revision', async ctx => {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('❌ No autorizado.');
    const { data: rows, error } = await supabase.from('pending_bets').select('id,user_telegram_id,original_input,ambiguous_numbers,created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(20);
    if (error) return ctx.reply('❌ No se pudieron cargar las revisiones.');
    if (!rows?.length) return ctx.reply('📋 No hay jugadas pendientes de revisión humana.');
    for (const r of rows) {
      const keyboard = { inline_keyboard: [[{ text: `✏️ Corregir #${r.id}`, callback_data: `review_edit_${r.id}` }], [{ text: `❌ Rechazar #${r.id}`, callback_data: `review_reject_${r.id}` }]] };
      await ctx.reply(`📋 *Solicitud #${r.id}*\nUsuario: ${r.user_telegram_id}\nJugada: \`${r.original_input}\`\nAmbiguo(s): ${r.ambiguous_numbers.join(', ')}`, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  });
}

module.exports = { registrarRevisionHumana, detectarAmbiguos };
