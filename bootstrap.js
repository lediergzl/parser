// Diagnóstico de arranque para Render.
// Carga index.js sin ocultar errores de inicialización.

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

const originalExit = process.exit;
process.exit = function diagnosticExit(code) {
  console.error(`❌ index.js intentó ejecutar process.exit(${code}) durante el arranque.`);
  console.error('🔎 Esto permite identificar exactamente qué validación está provocando la salida en Render.');
  process.exitCode = Number.isInteger(code) ? code : 1;
  return originalExit.call(process, code);
};

try {
  require('./index.js');
} catch (err) {
  console.error('❌ ERROR SINCRÓNICO AL CARGAR index.js:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
