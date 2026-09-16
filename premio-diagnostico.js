// ============================================================================
// premio-diagnostico.js
// Comando administrativo de SOLO LECTURA para verificar premios.
//
// Uso:
//   /verificar_premio florida noche 2026-09-15
//
// Si el resultado no existe en resultados_sorteo, permite probar el motor
// con un resultado suministrado manualmente, SIN insertar resultados ni premios:
//   /verificar_premio florida noche 2026-09-15 11 09,64 111
//
// Formato de resultado manual:
//   fijo corridos centena
// Ejemplo Pick 4: 0964 => corridos 09,64
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const {
  obtenerGanadores,
  PAYOUT_MULTIPLIERS,
} = require('./ganadores.js');

function normalizarNombre(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function normalizarNumero(valor, longitud = 2) {
  if (valor === null || valor === undefined || valor === '') return null;
  return String(valor).trim().padStart(longitud, '0');
}

function normalizarCorridos(valor) {
  if (!valor) return [];
  return String(valor)
    .split(/[,;|]/)
    .map(x => normalizarNumero(x))
    .filter(Boolean);
}

function dinero(valor) {
  return Number(valor || 0).toFixed(2);
}

function parseArgs(texto) {
  const partes = String(texto || '').trim().split(/\s+/).filter(Boolean);
  // /verificar_premio loteria sorteo fecha [fijo] [corridos] [centena]
  if (partes.length < 4) return null;

  const [comando, loteria, sorteo, fecha, fijo, corridos, centena] = partes;
  if (!/^\/verificar_premio(?:@[^\s]+)?$/i.test(comando)) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: 'La fecha debe tener formato YYYY-MM-DD.' };

  return {
    loteria: normalizarNombre(loteria),
    sorteo: normalizarNombre(sorteo),
    fecha,
    manual: fijo !== undefined,
    fijo: fijo !== undefined ? normalizarNumero(fijo) : null,
    corridos: corridos !== undefined ? normalizarCorridos(corridos) : [],
    centena: centena !== undefined ? normalizarNumero(centena, 3) : null,
  };
}

async function registrarComandoVerificarPremio(bot) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const adminIds = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(Number.isFinite);

  bot.command('verificar_premio', async (ctx) => {
    if (!adminIds.includes(ctx.from.id)) {
      return ctx.reply('❌ No autorizado.');
    }

    const args = parseArgs(ctx.message?.text || '');
    if (!args || args.error) {
      return ctx.reply(
        '🔎 *Verificación de premios*\n\n' +
        'Uso:\n' +
        '`/verificar_premio florida noche 2026-09-15`\n\n' +
        'Si el resultado no está guardado, puedes probar el motor sin modificar la BD:\n' +
        '`/verificar_premio florida noche 2026-09-15 11 09,64 111`',
        { parse_mode: 'Markdown' }
      );
    }

    try {
      const { data: loterias, error: loteriaError } = await supabase
        .from('loterias')
        .select('id,nombre')
        .eq('activo', true);
      if (loteriaError) throw loteriaError;

      const loteria = (loterias || []).find(l => normalizarNombre(l.nombre) === args.loteria);
      if (!loteria) {
        return ctx.reply(`❌ No encontré la lotería "${args.loteria}" en la BD.`);
      }

      const { data: sorteos, error: sorteoError } = await supabase
        .from('sorteos')
        .select('id,nombre,loteria_id')
        .eq('loteria_id', loteria.id);
      if (sorteoError) throw sorteoError;

      const sorteo = (sorteos || []).find(s => normalizarNombre(s.nombre) === args.sorteo);
      if (!sorteo) {
        return ctx.reply(`❌ No encontré el sorteo "${args.sorteo}" para ${loteria.nombre}.`);
      }

      let resultado = null;
      let resultadoGuardado = false;

      const { data: resultados, error: resultadoError } = await supabase
        .from('resultados_sorteo')
        .select('id,loteria_id,sorteo_id,fecha,numero_ganado,fuente')
        .eq('loteria_id', loteria.id)
        .eq('sorteo_id', sorteo.id)
        .eq('fecha', args.fecha)
        .order('id', { ascending: false })
        .limit(1);
      if (resultadoError) throw resultadoError;

      if (resultados?.length) {
        resultado = resultados[0];
        resultadoGuardado = true;
      } else if (args.manual) {
        resultado = {
          id: null,
          loteria_id: loteria.id,
          sorteo_id: sorteo.id,
          fecha: args.fecha,
          numero_ganado: {
            fijo: args.fijo,
            corrido: args.corridos,
            centena: args.centena,
          },
          fuente: 'DIAGNOSTICO_MANUAL',
        };
      }

      const { data: bets, error: betsError } = await supabase
        .from('bets')
        .select('*')
        .eq('loteria_id', loteria.id)
        .eq('sorteo_id', sorteo.id)
        .eq('fecha_apuesta', args.fecha)
        .order('id', { ascending: true });
      if (betsError) throw betsError;

      let ganadores = [];
      if (resultado) {
        ganadores = obtenerGanadores(bets || [], resultado);
      }

      let premiosExistentes = [];
      if (resultadoGuardado) {
        const { data: premios, error: premiosError } = await supabase
          .from('premios')
          .select('*')
          .eq('resultado_id', resultado.id)
          .order('id', { ascending: true });
        if (premiosError) throw premiosError;
        premiosExistentes = premios || [];
      } else if (ganadores.length) {
        const betIds = [...new Set(ganadores.map(g => g.bet?.id).filter(Boolean))];
        if (betIds.length) {
          const { data: premios, error: premiosError } = await supabase
            .from('premios')
            .select('*')
            .in('bet_id', betIds)
            .order('id', { ascending: true });
          if (premiosError) throw premiosError;
          premiosExistentes = premios || [];
        }
      }

      const numero = resultado?.numero_ganado || {};
      const corridosTexto = Array.isArray(numero.corrido)
        ? numero.corrido.join(', ')
        : String(numero.corrido || '—');

      let texto =
        `🔎 *Verificación de premios*\n\n` +
        `🎰 Lotería: *${loteria.nombre}*\n` +
        `🕒 Sorteo: *${sorteo.nombre}*\n` +
        `📅 Fecha: *${args.fecha}*\n\n`;

      if (!resultado) {
        texto +=
          `⚠️ *No existe resultado guardado en resultados_sorteo.*\n\n` +
          `Apuestas encontradas: *${(bets || []).length}*\n` +
          `Total apostado: *$${dinero((bets || []).reduce((s, b) => s + Number(b.total_apuesta || 0), 0))}*\n\n` +
          `Para probar el detector con el resultado real, ejecuta el mismo comando agregando:\n` +
          '`fijo corridos centena`';
        return ctx.reply(texto, { parse_mode: 'Markdown' });
      }

      texto +=
        `🎯 *Resultado${resultadoGuardado ? '' : ' de prueba'}*\n` +
        `Fijo: *${numero.fijo || '—'}*\n` +
        `Corridos: *${corridosTexto}*\n` +
        `Centena: *${numero.centena || '—'}*\n\n` +
        `📋 Apuestas revisadas: *${(bets || []).length}*\n` +
        `🏆 Ganadores detectados: *${ganadores.length}*\n\n`;

      if (ganadores.length) {
        texto += '🏆 *Detalle de ganadores*\n';
        ganadores.forEach((g, i) => {
          texto +=
            `${i + 1}. ${g.tipo_jugada.toUpperCase()} — *${g.numeros_ganadores}*\n` +
            `   Apuesta #${g.bet?.id || '—'}\n` +
            `   Unitario: $${dinero(g.monto_unitario)} × ${g.multiplicador}\n` +
            `   Premio: *$${dinero(g.monto_premio)}*\n`;
        });
      } else {
        texto += '✅ *No se detectaron ganadores con el resultado indicado.*\n';
      }

      texto += `\n💰 Premios ya registrados: *${premiosExistentes.length}*\n`;

      if (ganadores.length && premiosExistentes.length === 0) {
        texto += '\n⚠️ *Hay ganador(es) detectados pero no hay premio registrado.*';
      } else if (ganadores.length && premiosExistentes.length > 0) {
        texto += '\n✅ Hay registros en la tabla premios.';
      }

      texto += '\n\n🛡️ Esta prueba es de solo lectura: no crea ni modifica premios, apuestas, saldos ni resultados.';

      return ctx.reply(texto, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('❌ /verificar_premio:', error);
      return ctx.reply(`❌ Error en la verificación: ${error.message || error}`);
    }
  });

  console.log('✅ Comando administrativo /verificar_premio registrado');
}

function instalarDiagnosticoPremios() {
  let instalado = false;
  const timer = setInterval(() => {
    const bot = global.__LOTO_BOT__;
    if (!bot || instalado) return;
    instalado = true;
    clearInterval(timer);
    registrarComandoVerificarPremio(bot).catch(error => {
      console.error('❌ No se pudo registrar /verificar_premio:', error);
    });
  }, 100);

  setTimeout(() => clearInterval(timer), 30000);
}

// Exportación explícita para bet-bootstrap.js.
// No ejecutamos instalarDiagnosticoPremios() automáticamente porque el arranque
// principal ya registra el comando de forma determinista cuando el bot existe.
module.exports = {
  registrarComandoVerificarPremio,
  instalarDiagnosticoPremios,
};
