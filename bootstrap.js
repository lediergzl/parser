// Bootstrap de arranque para Render.
// index.js actualmente crea el servidor Express, pero no lo inicia.
// Capturamos esa instancia para mantener el servicio HTTP activo.

console.log('🔎 Bootstrap LotoPro iniciando...');
console.log('🔎 Node:', process.version);
console.log('🔎 SUPABASE_URL:', !!process.env.SUPABASE_URL);
console.log('🔎 SUPABASE_SERVICE_ROLE_KEY:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log('🔎 TELEGRAM_BOT_TOKEN:', !!process.env.TELEGRAM_BOT_TOKEN);
console.log('🔎 ADMIN_IDS:', !!process.env.ADMIN_IDS);

process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION DURANTE EL ARRANQUE:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ UNHANDLED REJECTION DURANTE EL ARRANQUE:');
  console.error(reason && reason.stack ? reason.stack : reason);
  process.exitCode = 1;
});

// Capturar la instancia Express que index.js crea con express().
const expressModulePath = require.resolve('express');
const realExpress = require('express');
const wrappedExpress = function (...args) {
  const app = realExpress(...args);
  global.__LOTO_APP__ = app;
  return app;
};
Object.assign(wrappedExpress, realExpress);
require.cache[expressModulePath].exports = wrappedExpress;

try {
  require('./index.js');

  const app = global.__LOTO_APP__;
  if (!app) {
    throw new Error('No se pudo capturar la instancia Express creada por index.js');
  }

  const PORT = Number(process.env.PORT) || 10000;

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
    console.log('✅ Webhook disponible en POST /webhook');
    console.log(`🏠 Health check: /ping`);
  });
} catch (err) {
  console.error('❌ ERROR DURANTE EL ARRANQUE:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
