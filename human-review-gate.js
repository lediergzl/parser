function esCandidatoRevision(texto) {
  const raw = String(texto || '').trim();
  if (!raw) return false;

  if (/\b(?:t\d{1,2}|d\d{1,2}|parejas?|pares|parle(?:t)?|candado|fijo|corrido)\b/i.test(raw)) return true;
  if (/(?:^|\s)\d{1,2}\s+al\s+\d{1,2}(?:\s+con\b|\s*$)/i.test(raw)) return true;
  if (/\b(?:con|de|a)\s+\$?\d+(?:[.,]\d{1,2})?\s*$/i.test(raw)) return true;
  if (/^\d{4}$/.test(raw)) return true;

  return raw.split(/\r?\n/).some(line => {
    const s = line.trim();
    if (!s) return false;
    return /\b(?:t\d{1,2}|d\d{1,2}|parejas?|pares|parle(?:t)?|candado|fijo|corrido)\b/i.test(s)
      || /(?:^|\s)\d{1,2}\s+al\s+\d{1,2}(?:\s+con\b|\s*$)/i.test(s)
      || /^(?:[$€£]?\d{1,4}(?:[.,]\d{1,2})?\s+){1,}\d{1,4}(?:[.,]\d{1,2})?\s+(?:con|a|de)\s+\$?\d+(?:[.,]\d{1,2})?$/i.test(s);
  });
}

function flujoInteractivoActivo(ctx) {
  const userId = ctx?.from?.id;
  if (!userId) return false;

  try {
    const depositStates = global.__LOTO_DEPOSIT_STATES__;
    if (depositStates?.has?.(userId)) return true;
  } catch (_) {}

  // Ajuste de una jugada pendiente: el siguiente texto es un monto libre
  // (por ejemplo 500, 100, 0.50) y no debe pasar por revisión humana.
  try {
    const adjustStates = global.__LOTO_PENDING_ADJUST_STATES__;
    if (adjustStates?.has?.(userId)) return true;
  } catch (_) {}

  return false;
}

function instalarFiltroRevisionHumana(bot) {
  const originalOn = bot.on.bind(bot);
  bot.on = function(event, ...args) {
    if (event === 'text') {
      const indiceHandler = args.length - 1;
      const handler = args[indiceHandler];
      if (typeof handler === 'function') {
        args[indiceHandler] = async function(ctx, next) {
          const texto = ctx.message?.text;
          if (!esCandidatoRevision(texto) && !flujoInteractivoActivo(ctx)) return next();
          return handler(ctx, next);
        };
      }
    }
    return originalOn(event, ...args);
  };
  return () => { bot.on = originalOn; };
}

try {
  const { Telegraf } = require('telegraf');
  const proto = Telegraf && Telegraf.prototype;
  if (proto && !proto.__LOTO_HUMAN_REVIEW_GATE__) {
    const originalPrototypeOn = proto.on;
    proto.on = function(event, ...args) {
      if (event === 'text') {
        const indiceHandler = args.length - 1;
        const handler = args[indiceHandler];
        if (typeof handler === 'function') {
          args[indiceHandler] = async function(ctx, next) {
            if (!esCandidatoRevision(ctx.message?.text) && !flujoInteractivoActivo(ctx)) return next();
            return handler(ctx, next);
          };
        }
      }
      return originalPrototypeOn.call(this, event, ...args);
    };
    proto.__LOTO_HUMAN_REVIEW_GATE__ = true;
  }
} catch (err) {
  // Telegraf puede no estar disponible si este archivo se importa fuera del arranque.
}

try {
  const humanReview = require('./human-review');
  if (humanReview && typeof humanReview.registrarRevisionHumana === 'function' && !humanReview.__LOTO_DEPOSIT_BYPASS__) {
    const registrarOriginal = humanReview.registrarRevisionHumana;
    humanReview.registrarRevisionHumana = async function(bot, ...args) {
      const originalBotOn = bot.on;
      bot.on = function(event, ...handlers) {
        if (event === 'text') {
          const indiceHandler = handlers.length - 1;
          const handler = handlers[indiceHandler];
          if (typeof handler === 'function') {
            handlers[indiceHandler] = async function(ctx, next) {
              if (flujoInteractivoActivo(ctx)) return next();
              return handler(ctx, next);
            };
          }
        }
        return originalBotOn.call(this, event, ...handlers);
      };
      try {
        return await registrarOriginal.call(this, bot, ...args);
      } finally {
        bot.on = originalBotOn;
      }
    };
    humanReview.__LOTO_DEPOSIT_BYPASS__ = true;
  }
} catch (err) {
  console.error('⚠️ No se pudo instalar bypass de depósitos para revisión humana:', err);
}

module.exports = { esCandidatoRevision, instalarFiltroRevisionHumana };
