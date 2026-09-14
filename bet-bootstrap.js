// Arranque final: reutiliza bootstrap.js y agrega revisión humana + flujo de apuestas.
// bootstrap.js conserva toda la lógica actual de Render, catálogo y menús.

require('./bootstrap.js');

const { registrarRevisionHumana } = require('./human-review');
const { registrarFlujoApuesta } = require('./bet-handler');

const bot = global.__LOTO_BOT__;
if (!bot) {
  console.error('❌ No se pudo obtener el bot de Telegram para registrar las jugadas.');
  process.exitCode = 1;
} else {
  registrarRevisionHumana(bot)
    .then(() => registrarFlujoApuesta(bot))
    .catch(err => {
      console.error('❌ Error registrando flujos de jugadas:', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}
