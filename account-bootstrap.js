// Arranque final con el módulo de identificación de Telegram.
// Primero se inicializa el bot existente y después se registra /mi_id.
require('./bet-bootstrap.js');

const { registrarMiIdTelegram } = require('./mi-id-telegram');
const bot = global.__LOTO_BOT__;

if (!bot) {
  console.error('❌ No se pudo obtener el bot de Telegram para registrar /mi_id.');
  process.exitCode = 1;
} else {
  registrarMiIdTelegram(bot).catch(err => {
    console.error('❌ Error registrando /mi_id:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}
