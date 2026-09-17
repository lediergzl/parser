// Arranque final: reutiliza bootstrap.js y agrega revisión humana +
// recuperación de jugadas por saldo + flujo de apuestas.
require('./bootstrap.js');
require('./decimal-amount-patch');
const { registrarComandoVerificarPremio } = require('./premio-diagnostico');

const { registrarRevisionHumana } = require('./human-review');
const { registrarPendientesPorSaldo } = require('./pending-balance');
const { registrarModuloComercial } = require('./banca');
const { registrarFlujoApuesta } = require('./bet-handler');
const { registrarWhatsappComerciales } = require('./whatsapp-comerciales');

const bot = global.__LOTO_BOT__;
if (!bot) {
  console.error('❌ No se pudo obtener el bot de Telegram para registrar las jugadas.');
  process.exitCode = 1;
} else {
  registrarComandoVerificarPremio(bot)
    .then(() => console.log('✅ /verificar_premio disponible'))
    .catch(err => {
      console.error('❌ Error registrando /verificar_premio:', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });

  bot.use(async (ctx, next) => {
    if (typeof ctx.message?.text !== 'string') return next();
    let texto = ctx.message.text;

    const totalDeclaradoMatch = texto.match(/\btotal\s*(?:(?:[-:]\s*)|(?:de\s+))?\$?\s*(\d+(?:[.,]\d+)?)/i);
    if (totalDeclaradoMatch) {
      ctx.state = ctx.state || {};
      ctx.state.totalDeclarado = Number(String(totalDeclaradoMatch[1]).replace(',', '.'));
    }

    texto = texto.replace(/^([^\d\r\n]+?)\s+(\d{1,2})\s+al\s+(\d{1,2})\s+con\s+\$?(\d+(?:[.,]\d+)?)\s*$/gim,
      (_, nombre, inicio, fin, monto) => {
        const desde = Number(inicio), hasta = Number(fin);
        if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde > hasta || desde < 0 || hasta > 99) return _;
        const numeros = []; for (let n = desde; n <= hasta; n++) numeros.push(String(n).padStart(2, '0'));
        return `${nombre.trim()}\n${numeros.join(' ')} con ${monto}`;
      });
    texto = texto.replace(/^(\d{1,2})\s+al\s+(\d{1,2})\s+con\s+\$?(\d+(?:[.,]\d+)?)\s*$/gim,
      (_, inicio, fin, monto) => {
        const desde = Number(inicio), hasta = Number(fin);
        if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde > hasta || desde < 0 || hasta > 99) return _;
        const numeros = []; for (let n = desde; n <= hasta; n++) numeros.push(String(n).padStart(2, '0'));
        return `${numeros.join(' ')} con ${monto}`;
      });

    const numerosPareja = '00 11 22 33 44 55 66 77 88 99';
    const patronParejaModificador = /^([^\d\r\n]+?)\s+(?:pareja|parejas|pares)\s+(parle|parlet|p|candado|c)\s*(\d+(?:[.,]\d+)?)\s*$/gim;
    texto = texto.replace(patronParejaModificador, (_, nombre, modificador, monto) => {
      const mod = /^(p|parlet)$/i.test(modificador) ? 'parle' : (/^c$/i.test(modificador) ? 'candado' : modificador.toLowerCase());
      return `${nombre.trim()}\n${numerosPareja} ${mod} con ${monto}`;
    });
    texto = texto.replace(/^(?:pareja|parejas|pares)\s+(parle|parlet|p|candado|c)\s*(\d+(?:[.,]\d+)?)\s*$/gim,
      (_, modificador, monto) => {
        const mod = /^(p|parlet)$/i.test(modificador) ? 'parle' : (/^c$/i.test(modificador) ? 'candado' : modificador.toLowerCase());
        return `${numerosPareja} ${mod} con ${monto}`;
      });
    texto = texto.replace(/^([^\d\r\n]+?)\s+(?:pareja|parejas|pares)\s+(?:de\s+)?candado\s+(\d+(?:[.,]\d+)?)[ \t]*$/gim,
      (_, nombre, monto) => `${nombre.trim()}\npareja candado ${monto}`);
    texto = texto.replace(/^([^\d\r\n]+?)\s+candado\s+(?:pareja|parejas|pares)\s+(\d+(?:[.,]\d+)?)[ \t]*$/gim,
      (_, nombre, monto) => `${nombre.trim()}\ncandado pareja ${monto}`);
    texto = texto.replace(/(\b(?:con|a|de|parle|candado|p|c)\s+)\$?(\d+)[.,]00\b/gi, (_, prefijo, numero) => `${prefijo}${numero}`);
    texto = texto.replace(/\btotal\s*(?:(?:[-:]\s*)|(?:\s+de\s+))?\$?\s*\d+(?:[.,]\d+)?/gi, '');
    ctx.message.text = texto.trim();
    return next();
  });

  registrarRevisionHumana(bot)
    .then(() => registrarPendientesPorSaldo(bot))
    .then(() => registrarModuloComercial(bot))
    .then(() => registrarFlujoApuesta(bot))
    .then(() => registrarWhatsappComerciales(bot))
    .catch(err => {
      console.error('❌ Error registrando flujos de jugadas:', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });

  try {
    require('./userbot-resultados').iniciarUserbotResultados()
      .catch(err => console.error('❌ Userbot de resultados no pudo iniciar:', err && err.stack ? err.stack : err));
  } catch (err) {
    console.error('⚠️ Userbot de resultados no disponible (¿falta "npm install telegram input?"):', err.message);
  }
}
