// generar-session.js
// ----------------------------------------------------------------------------
// Ejecutar UNA sola vez, de forma manual, para generar el string de sesión
// que después usará userbot-resultados.js. Pide teléfono, código de Telegram
// (y contraseña 2FA si la tienes activada) por consola.
//
// Requiere: npm install telegram input
//
// Uso:
//   node generar-session.js
//
// Al final imprime SESSION_STRING=... — cópialo a tu archivo .env, NUNCA lo
// subas a git ni lo compartas: con eso cualquiera puede iniciar sesión como
// esa cuenta.
// ----------------------------------------------------------------------------
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const apiId = parseInt(process.env.TG_API_ID || '', 10);
const apiHash = process.env.TG_API_HASH || '';

if (!apiId || !apiHash) {
  console.error('❌ Define TG_API_ID y TG_API_HASH como variables de entorno antes de correr esto.');
  console.error('   Se obtienen en https://my.telegram.org → API Development Tools.');
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => await input.text('Número de teléfono (con código de país, ej. +5359447976): '),
    password: async () => await input.text('Contraseña 2FA (deja vacío si no tienes): '),
    phoneCode: async () => await input.text('Código que llegó por Telegram: '),
    onError: (err) => console.error(err),
  });

  console.log('\n✅ Sesión iniciada correctamente.\n');
  console.log('Guarda esto como variable de entorno TG_SESSION:\n');
  console.log(client.session.save());
  console.log('\nNo lo compartas ni lo subas a git.\n');

  await client.disconnect();
  process.exit(0);
})();
