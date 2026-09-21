// Arranque final: reutiliza bootstrap.js y agrega revisión humana +
// recuperación de jugadas por saldo + flujo de apuestas.
require('./bootstrap.js');
require('./decimal-amount-patch');
const { createClient } = require('@supabase/supabase-js');
const { registrarComandoVerificarPremio } = require('./premio-diagnostico');

const { registrarRevisionHumana } = require('./human-review');
const { registrarPendientesPorSaldo } = require('./pending-balance');
const { registrarModuloComercial } = require('./banca');
const { registrarFlujoApuesta } = require('./bet-handler');
const { registrarWhatsappComerciales } = require('./whatsapp-comerciales');
const { registrarControlDestino } = require('./lib/whatsapp-destino');
const { conectarWhatsapp } = require('./lib/whatsapp-sender');
const { normalizarEntradaJugada } = require('./lib/jugada-input');
const { registrarEntregaDeJugadas } = require('./lib/jugadas-store');

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

    // La misma normalización se aplica aquí y en WhatsApp antes de
    // Engine.calcular(). Así ambos canales llegan al motor con exactamente
    // la misma sintaxis canónica.
    const textoOriginal = ctx.message.text;
    const totalDeclaradoMatch = textoOriginal.match(/\btotal\s*(?:(?:[-:]\s*)|(?:de\s+))?\$?\s*(\d+(?:[.,]\d+)?)/i);
    if (totalDeclaradoMatch) {
      ctx.state = ctx.state || {};
      ctx.state.totalDeclarado = Number(String(totalDeclaradoMatch[1]).replace(',', '.'));
    }

    ctx.message.text = normalizarEntradaJugada(textoOriginal);
    return next();
  });

  registrarRevisionHumana(bot)
    .then(() => registrarPendientesPorSaldo(bot))
    .then(() => registrarModuloComercial(bot))
    .then(() => registrarFlujoApuesta(bot))
    .then(() => registrarWhatsappComerciales(bot))
    .then(async () => {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
      );

      // El destino persistido debe cargarse antes de procesar resultados/premios,
      // porque esos eventos no traen un destino propio.
      await registrarControlDestino(supabase);

      // Marca en la base de datos las jugadas que realmente fueron
      // entregadas por WhatsApp; evita duplicados tras reconexiones.
      registrarEntregaDeJugadas(supabase);

      // Reactiva el consumidor del bus:
      // jugada:procesada -> WhatsApp
      // resultado:recibido -> WhatsApp
      // premio:detectado -> WhatsApp
      conectarWhatsapp(supabase)
        .then(() => console.log('✅ Sender WhatsApp de jugadas/resultados iniciado.'))
        .catch(err => console.error('❌ No se pudo iniciar el sender WhatsApp de jugadas/resultados:', err && err.stack ? err.stack : err));
    })
    .then(async () => {
      // El sender suscribe el bus y persiste eventos en el outbox antes de
      // adquirir el lock de WhatsApp. Por eso el userbot de resultados puede
      // arrancar en paralelo sin perder resultados mientras Baileys conecta.
      try {
        const userbotResultados = require('./userbot-resultados');
        await userbotResultados.iniciarUserbotResultados();
        console.log('✅ Userbot de resultados iniciado; entregas WhatsApp protegidas por outbox.');
      } catch (err) {
        console.error('❌ Userbot de resultados no pudo iniciar:', err && err.stack ? err.stack : err);
      }
    })
    .catch(err => {
      console.error('❌ Error registrando flujos de jugadas:', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}
