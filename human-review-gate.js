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

function instalarFiltroRevisionHumana(bot) {
  const originalOn = bot.on.bind(bot);
  bot.on = function(event, ...args) {
    if (event === 'text') {
      const indiceHandler = args.length - 1;
      const handler = args[indiceHandler];
      if (typeof handler === 'function') {
        args[indiceHandler] = async function(ctx, next) {
          const texto = ctx.message?.text;
          if (!esCandidatoRevision(texto)) return next();
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
            if (!esCandidatoRevision(ctx.message?.text)) return next();
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

module.exports = { esCandidatoRevision, instalarFiltroRevisionHumana };
