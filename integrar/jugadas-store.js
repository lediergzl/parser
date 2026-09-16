const bus = require('./event-bus');

function registrarGuardadoDeJugadas(supabase) {
  bus.on('jugada:procesada', async (jugada) => {
    try {
      const { error } = await supabase.from('jugadas').upsert(
        {
          external_id: jugada.external_id,
          cliente: jugada.cliente,
          banca: jugada.banca,
          numeros: jugada.numeros,
          monto: jugada.monto,
          raw_text: jugada.raw_text,
          estado: 'procesada',
        },
        { onConflict: 'external_id' }
      );
      if (error) console.error('Error guardando jugada en Supabase:', error);
    } catch (err) {
      console.error('Error guardando jugada:', err);
    }
  });
}

module.exports = { registrarGuardadoDeJugadas };
