// Arranque final: reutiliza bootstrap.js y agrega revisión humana +
// recuperación de jugadas por saldo + flujo de apuestas.
require('./bootstrap.js');
require('./decimal-amount-patch');

const { registrarRevisionHumana } = require('./human-review');
const { registrarPendientesPorSaldo } = require('./pending-balance');
const { registrarFlujoApuesta } = require('./bet-handler');

const bot = global.__LOTO_BOT__;
if (!bot) {
  console.error('❌ No se pudo obtener el bot de Telegram para registrar las jugadas.');
  process.exitCode = 1;
} else {
  bot.use(async (ctx, next) => {
    if (typeof ctx.message?.text !== 'string') return next();

    let texto = ctx.message.text;

    // Guardar el total declarado del comprobante antes de retirarlo del
    // texto que recibe el motor. Acepta Total 400, Total: 400,
    // Total-400 y Total de 400.
    const totalDeclaradoMatch = texto.match(
      /\btotal\s*(?:(?:[-:]\s*)|(?:de\s+))?\$?\s*(\d+(?:[.,]\d+)?)/i
    );
    if (totalDeclaradoMatch) {
      ctx.state = ctx.state || {};
      ctx.state.totalDeclarado = Number(String(totalDeclaradoMatch[1]).replace(',', '.'));
    }

    // FIX: cuando el nombre del jugador viene en la misma línea que
    // "pareja candado 10000", el preprocesador del core puede interpretar
    // el nombre como parte de la jugada y dejar una línea inválida.
    // Separamos únicamente este patrón, conservando el nombre intacto.
    // Ejemplo:
    //   "polo pareja candado 10000"
    // se convierte en:
    //   "polo\npareja candado 10000"
    // y el core aplica su normalización existente de pareja+candado.
    texto = texto.replace(
      /^([^\d\r\n]+?)\s+(?:pareja|parejas|pares)\s+(?:de\s+)?candado\s+(\d+(?:[.,]\d+)?)[ \t]*$/gim,
      (_, nombre, monto) => `${nombre.trim()}\npareja candado ${monto}`
    );

    // También soportar el orden inverso: "polo candado pareja 10000".
    texto = texto.replace(
      /^([^\d\r\n]+?)\s+candado\s+(?:pareja|parejas|pares)\s+(\d+(?:[.,]\d+)?)[ \t]*$/gim,
      (_, nombre, monto) => `${nombre.trim()}\ncandado pareja ${monto}`
    );

    texto = texto.replace(
      /(\b(?:con|a|de|parle|candado|p|c)\s+)\$?(\d+)[.,]00\b/gi,
      (_, prefijo, numero) => `${prefijo}${numero}`
    );

    // El total del comprobante es informativo, nunca una jugada.
    // Se elimina también cuando está pegado en la misma línea.
    texto = texto.replace(
      /\btotal\s*(?:(?:[-:]\s*)|(?:\s+de\s+))?\$?\s*\d+(?:[.,]\d+)?/gi,
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
