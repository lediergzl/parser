// Flujo de apuestas de Telegram.
// Se carga desde bet-bootstrap.js después de que bootstrap.js haya creado
// la instancia de Telegraf y registrado el catálogo.

const { createClient } = require('@supabase/supabase-js');

function fmtMoney(value) {
  return Number(value || 0).toFixed(2);
}

function fechaCuba() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function horaMinutosCuba() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Havana',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const h = Number(partes.find(p => p.type === 'hour')?.value || 0);
  const m = Number(partes.find(p => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}

async function obtenerContextoUsuario(supabase, telegramId) {
  const { data: pref, error: prefError } = await supabase
    .from('user_preferences')
    .select('loteria_id,sorteo_id,moneda')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (prefError) throw prefError;
  if (!pref?.loteria_id || !pref?.sorteo_id) {
    return { ok: false, message: '🎲 Primero selecciona una *lotería y un sorteo* con /start.' };
  }

  const { data: sorteo, error: sorteoError } = await supabase
    .from('sorteos')
    .select('id,nombre,loteria_id,hora_apertura,hora_cierre,activo')
    .eq('id', pref.sorteo_id)
    .eq('loteria_id', pref.loteria_id)
    .maybeSingle();
  if (sorteoError) throw sorteoError;
  if (!sorteo || !sorteo.activo) {
    return { ok: false, message: '❌ El sorteo seleccionado ya no está activo. Usa /start para seleccionar otro.' };
  }

  const ahora = horaMinutosCuba();
  if (sorteo.hora_apertura && sorteo.hora_cierre) {
    const [ah, am] = String(sorteo.hora_apertura).slice(0, 5).split(':').map(Number);
    const [ch, cm] = String(sorteo.hora_cierre).slice(0, 5).split(':').map(Number);
    const apertura = ah * 60 + am;
    const cierre = ch * 60 + cm;
    if (ahora < apertura) {
      return { ok: false, message: `⏰ El sorteo *${sorteo.nombre}* aún no ha abierto.\nHorario: ${String(sorteo.hora_apertura).slice(0,5)} - ${String(sorteo.hora_cierre).slice(0,5)} (Cuba).` };
    }
    if (ahora >= cierre) {
      return { ok: false, message: `⏰ El sorteo *${sorteo.nombre}* ya cerró.\nHorario: ${String(sorteo.hora_apertura).slice(0,5)} - ${String(sorteo.hora_cierre).slice(0,5)} (Cuba).` };
    }
  }

  return { ok: true, pref, sorteo };
}

async function validarLimites(supabase, loteriaId, sorteoId, fecha, detalles) {
  const { data: limites, error: limitesError } = await supabase
    .from('limits')
    .select('tipo,monto_maximo')
    .or(`loteria_id.eq.${loteriaId},loteria_id.is.null`)
    .or(`sorteo_id.eq.${sorteoId},sorteo_id.is.null`);
  if (limitesError) throw limitesError;
  if (!limites?.length) return null;

  const limitesMap = {};
  for (const l of limites) {
    limitesMap[l.tipo] = Number(l.monto_maximo);
  }

  const { data: bets, error: betsError } = await supabase
    .from('bets')
    .select('detalle')
    .eq('loteria_id', loteriaId)
    .eq('sorteo_id', sorteoId)
    .eq('fecha_apuesta', fecha);
  if (betsError) throw betsError;

  const acumulado = {};
  for (const bet of bets || []) {
    try {
      const rows = JSON.parse(bet.detalle || '[]');
      for (const d of rows) {
        const tipo = (d.tipo === 'candado' || d.tipo === 'candado_global') ? 'parle' : d.tipo;
        const monto = Number(d.monto_unitario || 0);
        if (!monto) continue;
        for (const num of d.numeros || []) {
          const key = `${tipo}:${String(num)}`;
          acumulado[key] = (acumulado[key] || 0) + monto;
        }
      }
    } catch (_) {}
  }

  for (const d of detalles) {
    const tipo = (d.tipo === 'candado' || d.tipo === 'candado_global') ? 'parle' : d.tipo;
    const limite = limitesMap[tipo];
    const monto = Number(d.monto_unitario || 0);
    if (!limite || !monto) continue;
    for (const num of d.numeros || []) {
      const key = `${tipo}:${String(num)}`;
      const anterior = acumulado[key] || 0;
      if (anterior + monto > limite) {
        return {
          numero: String(num),
          tipo,
          anterior,
          actual: monto,
          limite
        };
      }
      acumulado[key] = anterior + monto;
    }
  }
  return null;
}

function normalizarDetalles(resultado) {
  return (resultado.jugadas || []).flatMap(j => j.jugadas_detalle || []).map(d => ({
    tipo: d.tipo,
    numeros: d.numeros || [],
    pares: d.pares || null,
    combinaciones: d.combinaciones || '',
    monto: Number(d.monto || 0),
    monto_unitario: Number(d.monto_unitario || 0),
    linea: d.linea || null
  }));
}

function mensajeResultado(resultado, contexto) {
  let texto = `🧾 *Jugada calculada*\n\n`;
  texto += `🎰 ${contexto.loteriaNombre} — ${contexto.sorteo.nombre}\n`;
  texto += `💵 Moneda: ${String(contexto.moneda).toUpperCase()}\n\n`;
  texto += resultado.detalleTexto || '';
  texto += `\n💰 *TOTAL: $${fmtMoney(resultado.totalGeneral)}*`;
  return texto;
}

async function registrarFlujoApuesta(bot) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Desactivar el tracing del motor en producción para no llenar los logs de Render.
  try { global.Tracer?.disableTrace?.(); } catch (_) {}

  bot.command('jugar', async (ctx) => {
    await ctx.reply(
      '✍️ *Registrar jugada*\n\nEscribe ahora la jugada directamente, por ejemplo:\n`00 01 02 con 10`\n\nEl bot calculará el total, verificará límites y saldo antes de guardar.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.on('text', async (ctx) => {
    const texto = String(ctx.message?.text || '').trim();
    if (!texto || texto.startsWith('/')) return;

    try {
      const contexto = await obtenerContextoUsuario(supabase, ctx.from.id);
      if (!contexto.ok) {
        await ctx.reply(contexto.message, { parse_mode: 'Markdown' });
        return;
      }

      const { data: loteria, error: loteriaError } = await supabase
        .from('loterias')
        .select('nombre')
        .eq('id', contexto.pref.loteria_id)
        .maybeSingle();
      if (loteriaError) throw loteriaError;

      const Engine = global.Engine;
      const Preprocesador = global.Preprocesador;
      const Utils = global.Utils;
      if (!Engine?.calcular || !Preprocesador?.preprocesarJugada || !Utils?.limpiarMonto) {
        throw new Error('Motor LotoPro no disponible en el proceso del bot');
      }

      const resultado = Engine.calcular(
        {
          rawInput: texto,
          loteriaId: contexto.pref.loteria_id,
          sorteoId: contexto.pref.sorteo_id
        },
        {
          limpiarMonto: Utils.limpiarMonto,
          preprocesarJugada: Preprocesador.preprocesarJugada,
          obtenerTimestampLocal: () => new Date().toISOString()
        }
      );

      if (!resultado?.ok || !resultado.certified) {
        const errores = (resultado?.errors || []).map(e => {
          const linea = e.line ? `Línea ${e.line}: ` : '';
          return `• ${linea}${e.message || e.reason || 'Error de procesamiento'}`;
        }).join('\n');
        await ctx.reply(
          `❌ *No se puede guardar la jugada.*\n\n${resultado?.message || 'El motor detectó un error.'}${errores ? `\n\n${errores}` : ''}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const total = Number(resultado.totalGeneral || 0);
      if (!Number.isFinite(total) || total <= 0) {
        await ctx.reply('❌ El total calculado no es válido. Revisa la jugada e inténtalo nuevamente.');
        return;
      }

      const detalles = normalizarDetalles(resultado);
      const limite = await validarLimites(
        supabase,
        contexto.pref.loteria_id,
        contexto.pref.sorteo_id,
        fechaCuba(),
        detalles
      );
      if (limite) {
        await ctx.reply(
          `🚫 *Límite excedido*\n\nNúmero: ${limite.numero}\nTipo: ${limite.tipo}\nAcumulado anterior: $${fmtMoney(limite.anterior)}\nEsta jugada: $${fmtMoney(limite.actual)}\nLímite: $${fmtMoney(limite.limite)}\n\nLa jugada no fue guardada.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const { data: rpcData, error: rpcError } = await supabase.rpc('registrar_apuesta', {
        p_telegram_id: ctx.from.id,
        p_loteria_id: contexto.pref.loteria_id,
        p_sorteo_id: contexto.pref.sorteo_id,
        p_fecha: fechaCuba(),
        p_input_raw: texto,
        p_total: total,
        p_detalle: JSON.stringify(detalles),
        p_moneda: contexto.pref.moneda || 'cup'
      });

      if (rpcError) {
        const code = String(rpcError.message || '');
        if (code.includes('INSUFFICIENT_BALANCE')) {
          await ctx.reply(`💰 *Saldo insuficiente*\n\nTotal de la jugada: $${fmtMoney(total)}\n\nDeposita saldo y vuelve a intentarlo.`, { parse_mode: 'Markdown' });
          return;
        }
        if (code.includes('USER_NOT_FOUND')) {
          await ctx.reply('❌ Tu usuario todavía no está registrado. Envía /start e inténtalo de nuevo.');
          return;
        }
        throw rpcError;
      }

      const fila = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      const saldoDespues = Number(fila?.saldo_despues || 0);
      const contextoTexto = {
        loteriaNombre: loteria?.nombre || 'Lotería',
        sorteo: contexto.sorteo,
        moneda: contexto.pref.moneda || 'cup'
      };

      await ctx.reply(
        `${mensajeResultado(resultado, contextoTexto)}\n\n✅ *Jugada guardada correctamente.*\n💰 Saldo restante: *$${fmtMoney(saldoDespues)}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('❌ Error procesando jugada:', err && err.stack ? err.stack : err);
      await ctx.reply('❌ Ocurrió un error al procesar la jugada. No se guardó ningún cargo. Intenta nuevamente.');
    }
  });

  console.log('✅ Flujo de jugadas registrado');
}

module.exports = { registrarFlujoApuesta };
