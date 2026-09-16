const bus = require('./event-bus');

// El esqueleto original creaba una tabla `jugadas` propia, pero este proyecto
// ya persiste la jugada en `public.bets` y genera automáticamente el feed
// `public.jugadas_eventos` (trigger trg_bets_crear_jugada_evento), que incluye
// la bandera `entregado_whatsapp`. Por eso aquí no se duplica el almacenamiento:
// solo se marca la entrega y se consulta para no reenviar lo ya entregado.

async function yaEntregadaPorWhatsapp(supabase, betId) {
  if (!betId) return false;
  try {
    const { data, error } = await supabase
      .from('jugadas_eventos')
      .select('entregado_whatsapp')
      .eq('bet_id', betId)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data?.entregado_whatsapp);
  } catch (err) {
    // Si no se puede verificar, se prefiere intentar el envío (una notificación
    // repetida es menos grave que perder la jugada).
    console.error('⚠️  No se pudo verificar la entrega previa de la jugada:', err.message || err);
    return false;
  }
}

async function marcarEntregada(supabase, betId) {
  if (!betId) return;
  const { error } = await supabase
    .from('jugadas_eventos')
    .update({ entregado_whatsapp: true })
    .eq('bet_id', betId);
  if (error) console.error('❌ No se pudo marcar la jugada como entregada en WhatsApp:', error);
}

function registrarEntregaDeJugadas(supabase) {
  bus.on('jugada:enviada_wa', async ({ betId }) => {
    try {
      await marcarEntregada(supabase, betId);
    } catch (err) {
      console.error('❌ Error marcando la entrega de la jugada:', err && err.stack ? err.stack : err);
    }
  });
}

module.exports = { registrarEntregaDeJugadas, yaEntregadaPorWhatsapp, marcarEntregada };
