// Arranque de la integración opcional con WhatsApp vía Baileys.
//
// No crea su propio servidor: reutiliza la instancia de Express que index.js ya
// construye y que bootstrap.js expone en global.__LOTO_APP__. Así el bot sigue
// siendo un único proceso/servicio en Render.
//
// Variables de entorno:
//   WA_BAILEYS_ENABLED=true    activa la conexión de WhatsApp (por defecto off)
//   WA_GROUP_ID                destino por defecto ('...@g.us' o '...@s.whatsapp.net')
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (se acepta SUPABASE_SERVICE_KEY como alias)

const bus = require('./lib/event-bus');
const { registrarEntregaDeJugadas } = require('./lib/jugadas-store');

function baileysHabilitado() {
  return String(process.env.WA_BAILEYS_ENABLED || '').trim().toLowerCase() === 'true';
}

function crearClienteSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

function registrarRutas(app, estaListo) {
  if (!app || typeof app.get !== 'function') {
    console.log('ℹ️ No hay instancia de Express disponible; se omiten /health y /api/jugadas.');
    return;
  }

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      whatsapp_baileys_habilitado: baileysHabilitado(),
      whatsapp_conectado: estaListo()
    });
  });

  app.post('/api/jugadas', (req, res) => {
    const jugada = req.body;
    if (!jugada?.betId && !jugada?.bet_id) {
      return res.status(400).json({ error: 'betId es requerido' });
    }
    bus.emit('jugada:procesada', { ...jugada, betId: jugada.betId || jugada.bet_id });
    res.status(202).json({ ok: true });
  });

  console.log('✅ Rutas /health y /api/jugadas registradas');
}

async function iniciarIntegracionWhatsapp(app) {
  let estaListo = () => false;

  if (!baileysHabilitado()) {
    registrarRutas(app, estaListo);
    console.log('ℹ️ WA_BAILEYS_ENABLED no está en true; la integración de WhatsApp por Baileys queda inactiva.');
    return { habilitado: false };
  }

  try {
    const sender = require('./lib/whatsapp-sender');
    estaListo = sender.estaListo;
    registrarRutas(app, estaListo);

    const supabase = crearClienteSupabase();

    // Carga el destino persistido y registra los comandos administrativos de
    // Telegram antes de conectar Baileys. Así WA_GROUP_ID queda disponible
    // para el sender y no hay que editar Render cada vez que cambia el destino.
    const { registrarControlDestino } = require('./lib/whatsapp-destino');
    await registrarControlDestino(supabase);

    registrarEntregaDeJugadas(supabase);
    await sender.conectarWhatsapp(supabase);
    return { habilitado: true };
  } catch (err) {
    registrarRutas(app, estaListo);
    console.error('❌ No se pudo iniciar la integración de WhatsApp (Baileys):', err && err.stack ? err.stack : err);
    return { habilitado: false, error: err };
  }
}

module.exports = { iniciarIntegracionWhatsapp, baileysHabilitado };
