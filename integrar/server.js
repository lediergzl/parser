const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bus = require('./lib/event-bus');
const { conectarWhatsapp, estaListo } = require('./lib/whatsapp-sender');
const { registrarGuardadoDeJugadas } = require('./lib/jugadas-store');

const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = express();
app.use(express.json());

// Usado por el pinger externo (cron-job.org / UptimeRobot) para evitar que
// Render duerma el servicio a los 15 min de inactividad (plan free).
app.get('/health', (_req, res) => {
  res.json({ ok: true, whatsapp: estaListo() });
});

// Endpoint opcional: si tu parser de Telegram corre como proceso separado
// (o quieres desacoplarlo), puede llamar aquí en vez de emitir el evento en memoria.
// Body esperado: ver el comentario en lib/event-bus.js
app.post('/api/jugadas', (req, res) => {
  const jugada = req.body;
  if (!jugada?.external_id) {
    return res.status(400).json({ error: 'external_id es requerido' });
  }
  bus.emit('jugada:procesada', jugada);
  res.status(202).json({ ok: true });
});

async function main() {
  registrarGuardadoDeJugadas(supabase);
  await conectarWhatsapp(supabase);

  // Aquí es donde enganchas tu parser de Telegram existente
  // (bootstrap.js / bet-handler.js). En el punto donde hoy ya tienes
  // la jugada procesada y validada, en vez de (o además de) lo que hagas ahora, llama:
  //
  //   bus.emit('jugada:procesada', {
  //     external_id: msg.message_id,
  //     cliente: ...,
  //     banca: ...,
  //     numeros: ...,
  //     monto: ...,
  //     raw_text: msg.text,
  //     destino: { tipo: 'grupo', id: process.env.WA_GROUP_ID },
  //   });
  //
  // require('./bootstrap')({ bus }); // <- ejemplo de integración

  app.listen(PORT, () => console.log(`Servidor escuchando en :${PORT}`));
}

main().catch((err) => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
