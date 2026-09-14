// ============================================================================
// premios.js — Detección y cálculo de jugadas ganadoras.
// Compartido por banca.js (bot Telegraf) y userbot-resultados.js (proceso
// aparte que escucha a @boliterostop_bot), para no duplicar la lógica.
//
// Uso:
//   const { detectarPremios, PAYOUT_MULTIPLIERS } = require('./premios.js');
//   await detectarPremios(supabase, resultadoRow);
// ============================================================================

// Pago por cada $1 apostado a esa combinación específica (dado por el comercial).
// 'candado'/'candado_global' quedan fuera a propósito: no se dio su tasa,
// así que su premio se sigue confirmando a mano en /premios.
const PAYOUT_MULTIPLIERS = {
  fijo: 80,
  corrido: 30,
  centena: 500,
  centena_global: 500,
  parle: 1000,
  parle_global: 1000,
};

/**
 * Cruza el resultado de un sorteo contra las jugadas (bets) de esa
 * lotería/sorteo/fecha y registra en `premios` cada línea ganadora.
 * El monto del premio se calcula solo si el tipo tiene tasa en
 * PAYOUT_MULTIPLIERS; si no, queda `monto_premio: null` y `estado: 'detectado'`
 * para confirmación manual (ver /premios en banca.js).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id:number, loteria_id:number, sorteo_id:number, fecha:string,
 *           numero_ganado: { fijo?:string, corrido?:string, centena?:string } }} resultado
 */
async function detectarPremios(supabase, resultado) {
  const { fijo, corrido, centena } = resultado.numero_ganado || {};
  if (!fijo && !corrido && !centena) return;

  const centenaCorta = centena ? String(centena).slice(-2) : null;
  const paresGanadores = new Set();
  if (fijo && corrido) paresGanadores.add([fijo, corrido].sort().join('-'));
  if (fijo && centenaCorta) paresGanadores.add([fijo, centenaCorta].sort().join('-'));
  if (corrido && centenaCorta) paresGanadores.add([corrido, centenaCorta].sort().join('-'));

  const { data: bets, error } = await supabase.from('bets').select('*')
    .eq('loteria_id', resultado.loteria_id)
    .eq('sorteo_id', resultado.sorteo_id)
    .eq('fecha_apuesta', resultado.fecha);
  if (error || !bets) return;

  for (const bet of bets) {
    let detalle;
    try { detalle = JSON.parse(bet.detalle); } catch (e) { continue; }
    if (!Array.isArray(detalle)) continue;

    for (const d of detalle) {
      const nums = (d.numeros || []).map(String);
      let match = false;
      let numerosGanadores = '';

      if (['fijo', 'corrido'].includes(d.tipo)) {
        if (fijo && nums.includes(fijo)) { match = true; numerosGanadores = fijo; }
        else if (corrido && nums.includes(corrido)) { match = true; numerosGanadores = corrido; }
      } else if (['centena', 'centena_global'].includes(d.tipo)) {
        if (centena && nums.includes(centena)) { match = true; numerosGanadores = centena; }
      } else if (['parle', 'parle_global', 'candado', 'candado_global'].includes(d.tipo)) {
        for (const p of (d.pares || [])) {
          const key = [String(p[0]).padStart(2, '0'), String(p[1]).padStart(2, '0')].sort().join('-');
          if (paresGanadores.has(key)) { match = true; numerosGanadores = key; break; }
        }
      }

      if (!match) continue;

      const { data: existe } = await supabase.from('premios').select('id')
        .eq('bet_id', bet.id).eq('numeros_ganadores', numerosGanadores).eq('tipo_jugada', d.tipo)
        .maybeSingle();
      if (existe) continue;

      // El premio se paga sobre lo apostado a ESE número/par específico
      // (monto_unitario), no sobre el total de la línea (que puede cubrir
      // varios números).
      const montoUnitario = Number(d.monto_unitario) || 0;
      const multiplicador = PAYOUT_MULTIPLIERS[d.tipo] || null;
      const montoPremio = multiplicador != null ? +(montoUnitario * multiplicador).toFixed(2) : null;

      await supabase.from('premios').insert([{
        bet_id: bet.id, resultado_id: resultado.id,
        numeros_ganadores: numerosGanadores, tipo_jugada: d.tipo,
        monto_apostado: d.monto, monto_unitario: montoUnitario,
        monto_premio: montoPremio,
        estado: montoPremio != null ? 'confirmado' : 'detectado',
      }]);
    }
  }
}

module.exports = { detectarPremios, PAYOUT_MULTIPLIERS };
