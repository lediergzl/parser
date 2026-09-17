// ============================================================================
// mi-id-telegram.js — Identificación sencilla del usuario de Telegram.
// Permite que cualquier usuario consulte su ID sin usar bots externos.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

function getAdminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(Number.isFinite);
}

async function registrarMiIdTelegram(bot) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const adminIds = getAdminIds();

  bot.command('mi_id', async (ctx) => {
    const id = ctx.from.id;
    const nombre = [ctx.from.first_name, ctx.from.last_name]
      .filter(Boolean)
      .join(' ') || 'Sin nombre';
    const username = ctx.from.username ? `@${ctx.from.username}` : 'Sin usuario';

    try {
      const { data: user, error } = await supabase
        .from('users')
        .select('role')
        .eq('telegram_id', id)
        .maybeSingle();

      if (error) throw error;

      const role = adminIds.includes(id) ? 'admin' : (user?.role || 'cliente');
      const esComercial = role === 'comercial' || role === 'admin';

      let texto =
        `👤 *Mi cuenta*\n\n` +
        `Nombre: ${nombre}\n` +
        `Usuario: ${username}\n\n` +
        `🆔 *Tu ID de Telegram:*\n\`${id}\`\n\n`;

      if (esComercial) {
        texto +=
          `💼 *Rol:* ${role === 'admin' ? 'Administrador' : 'Comercial'}\n\n` +
          `📱 Puedes conectar tu WhatsApp con /wa_conectar.`;
      } else {
        texto +=
          `💼 *Rol:* Cliente\n\n` +
          `📌 Si necesitas ser registrado como comercial, envía este ID al administrador:\n` +
          `\`${id}\``;
      }

      await ctx.reply(texto, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('mi_id error:', err);
      await ctx.reply(`🆔 Tu ID de Telegram es: ${id}`);
    }
  });

  // Hace que el comando sea visible desde el menú de comandos de Telegram.
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Abrir menú principal' },
      { command: 'mi_id', description: 'Ver mi ID de Telegram' },
      { command: 'saldo', description: 'Consultar mi saldo' },
    ]);
  } catch (err) {
    console.error('No se pudo registrar /mi_id en el menú de Telegram:', err.message);
  }

  console.log('✅ Comando /mi_id registrado');
}

module.exports = { registrarMiIdTelegram };
