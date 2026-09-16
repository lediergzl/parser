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

  // Recarga de saldo: el usuario puede enviar cualquier monto (1000,
  // 10000, etc.) y luego una referencia. El gate de revisión humana no
  // debe bloquear esos mensajes solo porque no parecen una jugada.
  try {
    const depositStates = global.__LOTO_DEPOSIT_STATES__;
    if (depositStates?.has?.(userId)) return true;
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

// Cuando se carga como preload (-r), intercepta los handlers de texto de
// Telegraf desde el prototipo. Esto evita depender del orden de registro.
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
  // Si Telegraf todavía no está disponible, el módulo puede usarse mediante
  // instalarFiltroRevisionHumana(bot) después de crear el bot.
}

// La revisión humana se registra antes que el flujo de depósitos.
// Cuando el usuario está en una recarga activa, su texto puede ser un número
// de 4 cifras (por ejemplo, una referencia "1000"). En ese estado la revisión
// humana debe ceder el turno al siguiente handler para que el depósito procese
// el monto o la referencia.
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
