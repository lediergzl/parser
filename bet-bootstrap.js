// Arranque final: reutiliza bootstrap.js y agrega revisión humana +
// recuperación de jugadas por saldo + flujo de apuestas.
require('./bootstrap.js');

// Compatibilidad: protege montos como 61.50/61,50 antes de entrar al
// preprocesador del motor, que históricamente trataba . y , como separadores.
require('./decimal-amount-patch');

const { registrarRevisionHumana } = require('./human-review');
const { registrarPendientesPorSaldo } = require('./pending-balance');
const { registrarFlujoApuesta } = require('./bet-handler');

const bot = global.__LOTO_BOT__;
if (!bot) {
  console.error('❌ No se pudo obtener el bot de Telegram para registrar las jugadas.');
  process.exitCode = 1;
} else {
  // Normaliza formatos monetarios comunes antes de que cualquier detector
  // de números ambiguos vea el mensaje.
  //
  // 25,00 / 25.00 -> 25
  // 25,05 / 25.05 -> se conserva como decimal
  // También elimina líneas informativas "Total de 1101,00" o "Total-210",
  // que son resúmenes del comprobante y no una jugada adicional.
  bot.use(async (ctx, next) => {
    if (typeof ctx.message?.text !== 'string') return next();

    let texto = ctx.message.text;

    texto = texto.replace(
      /(\b(?:con|a|de|parle|candado|p|c)\s+)\$?(\d+)[.,]00\b/gi,
      (_, prefijo, numero) => `${prefijo}${numero}`
    );

    texto = texto.replace(
      /^\s*total\s*(?:[-:]\s*|\s+de\s+)\$?\d+(?:[.,]\d+)?\s*$/gim,
      ''
    );

    ctx.message.text = texto.trim();
    return next();
  });

  registrarRevisionHumana(bot)
    .then(() => registrarPendientesPorSaldo(bot))
    .then(() => registrarFlujoApuesta(bot))
    .catch(err => {
      console.error('❌ Error registrando flujos de jugadas:', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}
