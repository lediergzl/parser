// ============================================================================
// banca.js — Modalidad "Comercial": el comercial anota jugadas de clientes
// sin cuenta en el bot (clientes de banca, identificados por nombre) y
// resuelve premios (cobrar / dejar como depósito).
//
// Sigue el MISMO patrón que human-review.js / pending-balance.js /
// bet-handler.js: se registra desde bet-bootstrap.js con
//   registrarModuloComercial(bot)
// después de bootstrap.js, y ANTES de registrarFlujoApuesta(bot) — porque
// bet-handler.js consume bot.on('text') sin llamar next(), así que si se
// registrara antes se comería el texto de /jugada, /resultado y el monto
// del premio antes de que este módulo pueda procesarlo.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { detectarPremios, PAYOUT_MULTIPLIERS } = require('./premios.js');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
}

function fechaCuba() {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const y = partes.find(p => p.type === 'year')?.value;
  const m = partes.find(p => p.type === 'month')?.value;
  const d = partes.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function horaMinutosCuba() {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number(partes.find(p => p.type === 'hour')?.value || 0);
  const m = Number(partes.find(p => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}

async function registrarModuloComercial(bot) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const adminIds = getAdminIds();

  // ── Estado conversacional en memoria (mismo patrón que pending-balance.js) ──
  const bancaJugadaState = new Map(); // telegramId -> { loteriaId, sorteoId, moneda }
  const resultadoState   = new Map(); // telegramId -> { step, loteriaId, sorteoId }
  const premioMontoState = new Map(); // telegramId -> { premioId }

  async function getRole(telegramId) {
    if (adminIds.includes(telegramId)) return 'admin';
    const { data } = await supabase.from('users').select('role').eq('telegram_id', telegramId).maybeSingle();
    return data?.role || 'cliente';
  }

  async function requireRole(ctx, permitidos) {
    const role = await getRole(ctx.from.id);
    if (!permitidos.includes(role)) { await ctx.reply('⛔ No tienes permiso para usar este comando.'); return null; }
    return role;
  }

  async function obtenerContextoSorteo(telegramId) {
    const { data: pref } = await supabase.from('user_preferences').select('loteria_id,sorteo_id,moneda').eq('telegram_id', telegramId).maybeSingle();
    if (!pref?.loteria_id || !pref?.sorteo_id) return { ok: false, message: '🎲 Primero selecciona lotería y sorteo con /start.' };
    const { data: sorteo } = await supabase.from('sorteos').select('id,nombre,hora_apertura,hora_cierre,activo').eq('id', pref.sorteo_id).maybeSingle();
    if (!sorteo || !sorteo.activo) return { ok: false, message: '❌ El sorteo seleccionado ya no está activo. Usa /start para elegir otro.' };
    const ahora = horaMinutosCuba();
    if (sorteo.hora_apertura && sorteo.hora_cierre) {
      const [ah, am] = String(sorteo.hora_apertura).slice(0, 5).split(':').map(Number);
      const [ch, cm] = String(sorteo.hora_cierre).slice(0, 5).split(':').map(Number);
      const apertura = ah * 60 + am, cierre = ch * 60 + cm;
      if (ahora < apertura || ahora >= cierre) {
        return { ok: false, message: `⏰ *${sorteo.nombre}* está cerrado ahora mismo. Horario: ${String(sorteo.hora_apertura).slice(0,5)}-${String(sorteo.hora_cierre).slice(0,5)} (Cuba).` };
      }
    }
    return { ok: true, pref, sorteo };
  }

  // ── CLIENTES DE BANCA ─────────────────────────────────────────────────
  async function findOrCreateClienteBanca(comercialId, nombre) {
    const nombreLimpio = String(nombre || '').trim().slice(0, 120) || 'SIN NOMBRE';
    const { data: existente } = await supabase.from('clientes_banca').select('*')
      .eq('comercial_telegram_id', comercialId).eq('nombre', nombreLimpio).maybeSingle();
    if (existente) return existente;
    const { data: nuevo, error } = await supabase.from('clientes_banca')
      .insert([{ comercial_telegram_id: comercialId, nombre: nombreLimpio, saldo: 0 }]).select('*').single();
    if (error) throw error;
    return nuevo;
  }

  async function updateClienteBancaSaldo(clienteId, nuevoSaldo) {
    await supabase.from('clientes_banca').update({ saldo: nuevoSaldo, updated_at: new Date() }).eq('id', clienteId);
  }

  async function saveBetComercial({ comercialId, clienteBancaId, loteriaId, sorteoId, fecha, inputRaw, totalApuesta, detalle, moneda }) {
    const { error } = await supabase.from('bets').insert([{
      user_telegram_id: comercialId,
      loteria_id: loteriaId, sorteo_id: sorteoId, fecha_apuesta: fecha,
      input_raw: inputRaw, total_apuesta: totalApuesta, detalle,
      saldo_antes: 0, saldo_despues: 0, moneda: moneda || 'cup',
      origen: 'comercial', comercial_telegram_id: comercialId, cliente_banca_id: clienteBancaId,
    }]);
    if (error) throw error;
  }

  // ── COMANDO: probar el userbot con el último resultado ya publicado ──
  // No espera al próximo sorteo: busca el último mensaje de @boliterostop_bot
  // en el grupo indicado y lo procesa con el mismo pipeline de producción.
  bot.command('probar_resultado', async (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('⛔ Solo el admin puede hacer esto.');
    const parts = ctx.message.text.trim().split(/\s+/);
    const chat = parts[1] || '@MentesMillonariasbolitachat';

    await ctx.reply(`🔎 Buscando el último resultado de @boliterostop_bot en ${chat}...`);
    const { buscarUltimoResultadoEnChat } = require('./userbot-resultados');
    let r;
    try {
      r = await buscarUltimoResultadoEnChat(chat);
    } catch (e) {
      console.error('probar_resultado error:', e);
      return ctx.reply(`❌ Error inesperado: ${e.message}`);
    }

    if (!r.ok) {
      let msg = `❌ ${r.message}`;
      if (r.texto) msg += `\n\nTexto del mensaje:\n${r.texto}`;
      return ctx.reply(msg);
    }

    await ctx.reply(
      `✅ Resultado guardado desde ${chat}:\n\n` +
      `${r.texto}\n\n` +
      `Parseado: fijo ${r.parsed.fijo || '-'}, corrido ${r.parsed.corrido || '-'}, centena ${r.parsed.centena || '-'}\n` +
      `Lotería/sorteo: loteria_id=${r.destino.loteriaId}, sorteo_id=${r.destino.sorteoId}\n\n` +
      `Revisa /premios para ver si hubo ganadores.`
    );
  });

  // ── COMANDO: promover comercial (solo admin) ─────────────────────────
  bot.command('comercial_add', async (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('⛔ Solo el admin puede hacer esto.');
    const parts = ctx.message.text.trim().split(/\s+/);
    const targetId = parseInt(parts[1], 10);
    if (!targetId || isNaN(targetId)) return ctx.reply('Uso: /comercial_add <telegram_id>');
    try {
      const { data: existente } = await supabase.from('users').select('telegram_id').eq('telegram_id', targetId).maybeSingle();
      if (!existente) await supabase.from('users').insert([{ telegram_id: targetId, saldo: 0, role: 'comercial' }]);
      else await supabase.from('users').update({ role: 'comercial' }).eq('telegram_id', targetId);
      await ctx.reply(`✅ Usuario ${targetId} ahora es comercial.`);
    } catch (err) {
      console.error('comercial_add error:', err);
      await ctx.reply('❌ No se pudo actualizar el rol.');
    }
  });

  // ── COMANDO: iniciar carga de jugadas como comercial ─────────────────
  bot.command('jugada', async (ctx) => {
    const role = await requireRole(ctx, ['comercial', 'admin']);
    if (!role) return;
    const contexto = await obtenerContextoSorteo(ctx.from.id);
    if (!contexto.ok) return ctx.reply(contexto.message, { parse_mode: 'Markdown' });

    bancaJugadaState.set(ctx.from.id, { loteriaId: contexto.pref.loteria_id, sorteoId: contexto.pref.sorteo_id, moneda: contexto.pref.moneda });
    await ctx.reply(
      '📝 Envía ahora el texto con las jugadas.\n\n' +
      'Puedes incluir varios jugadores en el mismo mensaje, con el nombre antes de cada bloque, por ejemplo:\n\n' +
      'Pepe\n23 45 con 10\n\nMaria\nt5 con 1\nd2 con 3',
      { parse_mode: 'Markdown' }
    );
  });

  // ── COMANDO: registrar resultado de sorteo ────────────────────────────
  bot.command('resultado', async (ctx) => {
    const role = await requireRole(ctx, ['comercial', 'admin']);
    if (!role) return;
    const { data: loterias } = await supabase.from('loterias').select('id,nombre').eq('activo', true).order('id');
    if (!loterias?.length) return ctx.reply('No hay loterías activas.');
    resultadoState.set(ctx.from.id, { step: 'loteria' });
    await ctx.reply('🎲 Selecciona la lotería del resultado:', {
      reply_markup: { inline_keyboard: loterias.map(l => [{ text: l.nombre, callback_data: `banca_res_lot_${l.id}` }]) },
    });
  });

  bot.action(/^banca_res_lot_(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const loteriaId = parseInt(ctx.match[1], 10);
    const { data: sorteos } = await supabase.from('sorteos').select('id,nombre').eq('loteria_id', loteriaId).eq('activo', true).order('hora_apertura');
    if (!sorteos?.length) return ctx.reply('Esa lotería no tiene sorteos activos.');
    resultadoState.set(ctx.from.id, { step: 'sorteo', loteriaId });
    await ctx.editMessageText('🕒 Selecciona el sorteo:', {
      reply_markup: { inline_keyboard: sorteos.map(s => [{ text: s.nombre, callback_data: `banca_res_sor_${s.id}` }]) },
    });
  });

  bot.action(/^banca_res_sor_(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const sorteoId = parseInt(ctx.match[1], 10);
    const st = resultadoState.get(ctx.from.id);
    if (!st || st.step !== 'sorteo') return;
    resultadoState.set(ctx.from.id, { step: 'numeros', loteriaId: st.loteriaId, sorteoId });
    await ctx.editMessageText('🔢 Envía los números ganadores separados por espacio: FIJO CORRIDO [CENTENA]\nEjemplo: 23 45 823');
  });

  // ── COMANDO: listar premios pendientes ─────────────────────────────────
  bot.command('premios', async (ctx) => {
    const role = await requireRole(ctx, ['comercial', 'admin']);
    if (!role) return;
    const { data: premios, error } = await supabase.from('premios')
      .select('*, bets(origen, comercial_telegram_id, user_telegram_id, input_raw)')
      .in('estado', ['detectado', 'confirmado']).order('created_at', { ascending: false }).limit(20);
    if (error) { console.error(error); return ctx.reply('❌ Error al listar premios.'); }
    if (!premios?.length) return ctx.reply('🎉 No hay premios pendientes de resolver.');

    for (const p of premios) {
      const bet = p.bets;
      if (role !== 'admin' && bet?.comercial_telegram_id && bet.comercial_telegram_id !== ctx.from.id) continue;
      const montoTxt = p.monto_premio != null ? `$${Number(p.monto_premio).toFixed(2)}` : 'sin confirmar';
      const unitTxt = p.monto_unitario != null ? `$${Number(p.monto_unitario).toFixed(2)}` : '?';
      const botones = p.monto_premio == null
        ? [[{ text: '✏️ Ingresar monto del premio', callback_data: `banca_premio_monto_${p.id}` }]]
        : [[{ text: '💵 Cobrar', callback_data: `banca_premio_cobrar_${p.id}` }, { text: '🏦 Dejar depósito', callback_data: `banca_premio_deposito_${p.id}` }]];
      await ctx.reply(
        `🏆 Premio #${p.id}\nTipo: ${p.tipo_jugada} | Ganó: ${p.numeros_ganadores}\n` +
        `Apostado (línea): $${Number(p.monto_apostado).toFixed(2)} | Unitario: ${unitTxt} | Premio: ${montoTxt}\n` +
        `Jugada original: "${bet ? bet.input_raw : '?'}"`,
        { reply_markup: { inline_keyboard: botones } }
      );
    }
  });

  bot.action(/^banca_premio_monto_(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    premioMontoState.set(ctx.from.id, { premioId: parseInt(ctx.match[1], 10) });
    await ctx.reply('💰 Escribe el monto del premio (solo el número):');
  });

  async function resolverPremio(ctx, premioId, accion) {
    const { data: premio, error } = await supabase.from('premios').select('*, bets(*)').eq('id', premioId).single();
    if (error || !premio) return ctx.reply('❌ Premio no encontrado.');
    if (premio.monto_premio == null) return ctx.reply('⚠️ Primero ingresa el monto del premio.');

    const bet = premio.bets;
    const monto = Number(premio.monto_premio);
    const nuevoEstado = accion === 'cobrar' ? 'cobrado' : 'depositado';

    if (accion === 'depositar') {
      if (bet.origen === 'comercial' && bet.cliente_banca_id) {
        const { data: cliente } = await supabase.from('clientes_banca').select('saldo').eq('id', bet.cliente_banca_id).single();
        await updateClienteBancaSaldo(bet.cliente_banca_id, (Number(cliente?.saldo) || 0) + monto);
      } else if (bet.user_telegram_id) {
        const { data: user } = await supabase.from('users').select('saldo').eq('telegram_id', bet.user_telegram_id).single();
        await supabase.from('users').update({ saldo: (Number(user?.saldo) || 0) + monto, updated_at: new Date() }).eq('telegram_id', bet.user_telegram_id);
      }
    }

    await supabase.from('premios').update({ estado: nuevoEstado, resuelto_por: ctx.from.id, fecha_resuelto: new Date() }).eq('id', premioId);
    await ctx.reply(accion === 'cobrar'
      ? `✅ Premio #${premioId} marcado como COBRADO ($${monto.toFixed(2)}).`
      : `✅ Premio #${premioId} dejado como DEPÓSITO ($${monto.toFixed(2)} acreditado a saldo).`);
  }

  bot.action(/^banca_premio_cobrar_(\d+)$/, async (ctx) => { try { await ctx.answerCbQuery(); } catch (e) {} await resolverPremio(ctx, parseInt(ctx.match[1], 10), 'cobrar'); });
  bot.action(/^banca_premio_deposito_(\d+)$/, async (ctx) => { try { await ctx.answerCbQuery(); } catch (e) {} await resolverPremio(ctx, parseInt(ctx.match[1], 10), 'depositar'); });

  // ── HANDLER DE TEXTO (jugada comercial / números de resultado / monto de premio) ──
  // Debe ir ANTES de bet-handler.js en bet-bootstrap.js: bet-handler.js no
  // llama next(), así que si él corre primero se come todo el texto.
  bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const texto = String(ctx.message?.text || '').trim();
    if (!texto || texto.startsWith('/')) return next();

    // 1) Esperando monto de premio
    const pmState = premioMontoState.get(userId);
    if (pmState) {
      const monto = global.Utils?.limpiarMonto ? global.Utils.limpiarMonto(texto) : parseFloat(texto.replace(',', '.'));
      if (monto === null || !Number.isFinite(monto) || monto <= 0) return ctx.reply('❌ Monto inválido. Escribe solo el número.');
      await supabase.from('premios').update({ monto_premio: monto, estado: 'confirmado' }).eq('id', pmState.premioId);
      premioMontoState.delete(userId);
      return ctx.reply(`✅ Monto del premio #${pmState.premioId} guardado: $${monto.toFixed(2)}.\nUsa /premios para cobrarlo o dejarlo en depósito.`);
    }

    // 2) Esperando números de resultado
    const rState = resultadoState.get(userId);
    if (rState && rState.step === 'numeros') {
      const partes = texto.split(/\s+/);
      if (partes.length < 2) return ctx.reply('Formato: FIJO CORRIDO [CENTENA]. Ejemplo: 23 45 823');
      const pad2 = (s) => String(s || '').padStart(2, '0');
      const pad3 = (s) => String(s || '').padStart(3, '0');
      const fijo = pad2(partes[0]);
      const corrido = pad2(partes[1]);
      const centena = partes[2] ? pad3(partes[2]) : null;
      const fecha = fechaCuba();

      const { data: resultado, error } = await supabase.from('resultados_sorteo')
        .upsert([{ loteria_id: rState.loteriaId, sorteo_id: rState.sorteoId, fecha, numero_ganado: { fijo, corrido, centena }, fuente: 'manual', registrado_por: userId }],
          { onConflict: 'loteria_id,sorteo_id,fecha' })
        .select('*').single();

      resultadoState.delete(userId);
      if (error) { console.error(error); return ctx.reply('❌ Error al guardar el resultado.'); }

      await ctx.reply(`✅ Resultado guardado: fijo ${fijo}, corrido ${corrido}${centena ? `, centena ${centena}` : ''}.\nBuscando ganadores...`);
      try {
        await detectarPremios(supabase, resultado);
        await ctx.reply('🔍 Búsqueda de ganadores completada. Usa /premios para revisarlos.');
      } catch (e) {
        console.error('detectarPremios error:', e);
        await ctx.reply('⚠️ El resultado se guardó pero hubo un error buscando ganadores.');
      }
      return;
    }

    // 3) Esperando texto de jugadas (comercial)
    const jState = bancaJugadaState.get(userId);
    if (jState) {
      bancaJugadaState.delete(userId);
      const Engine = global.Engine, Preprocesador = global.Preprocesador, Utils = global.Utils, Expansion = global.Expansion;
      if (!Engine?.calcular || !Preprocesador?.preprocesarJugada || !Utils?.limpiarMonto || !Expansion) {
        return ctx.reply('❌ Motor LotoPro no disponible en el proceso del bot.');
      }

      let result;
      try {
        result = Engine.calcular(
          { rawInput: texto, loteriaId: jState.loteriaId, sorteoId: jState.sorteoId },
          { Expansion, limpiarMonto: Utils.limpiarMonto, preprocesarJugada: Preprocesador.preprocesarJugada, obtenerTimestampLocal: () => new Date().toISOString() }
        );
      } catch (e) {
        console.error('Engine.calcular error (comercial):', e);
        return ctx.reply('❌ Error interno procesando las jugadas.');
      }

      if (!result?.ok || !result.certified) {
        const detalleErr = (result?.errors || []).map(e => `• ${e.message || e.reason}`).join('\n');
        return ctx.reply(`❌ ${result?.message || 'No se pudo procesar.'}\n${detalleErr}`);
      }

      let resumen = '';
      const fecha = fechaCuba();
      try {
        for (const j of result.jugadas) {
          const cliente = await findOrCreateClienteBanca(userId, j.jugador_nombre);
          const montoTotal = Number(j.monto_total) || 0;
          const saldoDisponible = Number(cliente.saldo) || 0;
          const usarCredito = Math.min(saldoDisponible, montoTotal);
          const saldoNuevo = saldoDisponible - usarCredito;
          if (usarCredito > 0) await updateClienteBancaSaldo(cliente.id, saldoNuevo);

          await saveBetComercial({
            comercialId: userId, clienteBancaId: cliente.id,
            loteriaId: jState.loteriaId, sorteoId: jState.sorteoId, fecha,
            inputRaw: j.jugada_texto, totalApuesta: montoTotal,
            detalle: JSON.stringify(j.jugadas_detalle), moneda: jState.moneda,
          });

          resumen += `👤 ${j.jugador_nombre}: $${montoTotal.toFixed(2)}`;
          if (usarCredito > 0) resumen += ` (💳 crédito aplicado $${usarCredito.toFixed(2)}, saldo resta $${saldoNuevo.toFixed(2)})`;
          resumen += '\n';
        }
      } catch (e) {
        console.error('Error guardando jugadas de comercial:', e);
        return ctx.reply('❌ Ocurrió un error guardando algunas jugadas. Revisa e intenta de nuevo.');
      }

      return ctx.reply(`✅ Jugadas registradas:\n\n${resumen}\nTotal general: $${Number(result.totalGeneral).toFixed(2)}`);
    }

    return next();
  });

  console.log('✅ Módulo comercial (banca) registrado');
}

module.exports = { registrarModuloComercial, PAYOUT_MULTIPLIERS };
