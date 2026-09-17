// ============================================================================
// mi-id-telegram.js — Identificación sencilla del usuario de Telegram.
// El ID se muestra siempre aunque Supabase tenga un problema temporal.
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
    const id = Number(ctx.from?.id);
    const nombre = [ctx.from?.first_name, ctx.from?.last_name]
      .filter(Boolean)
      .join(' ') || 'Sin nombre';
    const username = ctx.from?.username ? `@${ctx.from.username}` : 'Sin usuario';

    // IMPORTANTE: obtener el ID de Telegram nunca debe depender de Supabase.
    // El usuario debe recibir sus datos aunque la BD falle, haya un timeout
    // o todavía no exista su registro en users.
    let role = 'cliente';

    if (adminIds.includes(id)) {
      role = 'admin';
    } else {
      try {
        const { data: user, error } = await supabase
          .from('users')
          .select('role')
          .eq('telegram_id', id)
          .maybeSingle();

        if (error) {
          console.error('mi_id: no se pudo consultar el rol:', error.message);
        } else if (user?.role) {
          role = user.role;
        }
      } catch (err) {
        console.error('mi_id: error consultando rol:', err?.message || err);
      }
    }

    const rolTexto = role === 'admin'
      ? 'Administrador'
      : role === 'comercial'
        ? 'Comercial'
        : 'Cliente';

    let texto =
      `👤 *Mi cuenta*\n\n` +
      `Nombre: ${nombre}\n` +
      `Usuario: ${username}\n\n` +
      `🆔 *Tu ID de Telegram:*\n\`${id}\`\n\n` +
      `💼 *Rol:* ${rolTexto}\n\n`;

    if (role === 'comercial') {
      texto += `📱 Puedes conectar tu WhatsApp con /wa_conectar.`;
    } else if (role === 'admin') {
      texto += `⚙️ Tienes permisos de administrador.`;
    } else {
      texto +=
        `📌 Si necesitas ser registrado como comercial, envía este ID al administrador:\n` +
        `\`${id}\``;
    }

    try {
      await ctx.reply(texto, { parse_mode: 'Markdown' });
    } catch (err) {
      // Incluso si Markdown falla, entregar el dato esencial.
      console.error('mi_id: error enviando respuesta formateada:', err?.message || err);
      await ctx.reply(
        `👤 Mi cuenta\n\nNombre: ${nombre}\nUsuario: ${username}\n\n🆔 Tu ID de Telegram: ${id}\n\n💼 Rol: ${rolTexto}`
      );
    }
  });

  // IMPORTANTE: setMyCommands reemplaza la lista anterior completa.
  // Este catálogo contiene los comandos actualmente implementados.
  const commands = [
    { command: 'start', description: 'Abrir menú principal' },
    { command: 'mi_id', description: 'Ver mi ID de Telegram' },
    { command: 'saldo', description: 'Consultar mi saldo' },
    { command: 'jugar', description: 'Registrar una jugada' },
    { command: 'jugada', description: 'Registrar jugadas como comercial' },
    { command: 'resultado', description: 'Registrar resultado como comercial' },
    { command: 'premios', description: 'Consultar premios pendientes' },
    { command: 'wa_conectar', description: 'Conectar mi WhatsApp' },
    { command: 'wa_qr', description: 'Mostrar el QR de WhatsApp' },
    { command: 'wa_estado', description: 'Ver estado de WhatsApp' },
    { command: 'wa_desconectar', description: 'Desconectar mi WhatsApp' },
    { command: 'wa_comerciales', description: 'Ver WhatsApp de comerciales (admin)' },
    { command: 'comercial_add', description: 'Registrar un comercial (admin)' },
    { command: 'verificar_premio', description: 'Diagnosticar un premio' },
    { command: 'probar_resultado', description: 'Probar lectura de resultado (admin)' }
  ];

  try {
    await bot.telegram.setMyCommands(commands);
    console.log(`✅ Menú de comandos de Telegram registrado (${commands.length} comandos)`);
  } catch (err) {
    console.error('No se pudo registrar el menú de comandos de Telegram:', err?.message || err);
  }

  console.log('✅ Comando /mi_id registrado');
}

module.exports = { registrarMiIdTelegram };