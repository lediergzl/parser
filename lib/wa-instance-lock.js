// Lock distribuido (vía Supabase) para garantizar que solo UN proceso tenga
// abierto el socket de Baileys de la sesión WhatsApp a la vez.
//
// Por qué existe: ver 20260920000100_whatsapp_session_lock.sql. En resumen,
// sin este lock, dos instancias del servicio (por ejemplo durante un deploy
// de Render) pueden conectar simultáneamente con la misma sesión y corromper
// las claves de sync, forzando un logout (401) y un bucle infinito de QR.

const crypto = require('crypto');

const HOLDER_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const TTL_SECONDS = 20;
const RENEW_MS = 8000;

function crearLockSesionWhatsapp(supabase, lockId = 'default') {
  let renovacion = null;
  let sostenido = false;

  async function intentarAdquirir() {
    const { data, error } = await supabase.rpc('whatsapp_lock_acquire', {
      p_id: lockId,
      p_holder: HOLDER_ID,
      p_ttl_seconds: TTL_SECONDS
    });
    if (error) throw error;
    sostenido = Boolean(data);
    return sostenido;
  }

  function asegurarRenovacion() {
    if (renovacion) return;
    renovacion = setInterval(() => {
      intentarAdquirir().catch(err =>
        console.error('⚠️ No se pudo renovar el lock de la sesión WhatsApp:', err?.message || err)
      );
    }, RENEW_MS);
    if (renovacion.unref) renovacion.unref();
  }

  // Bloquea hasta que este proceso sea dueño del lock. Si otro proceso lo
  // sostiene (y su lease sigue vigente), espera y reintenta en vez de abrir
  // un segundo socket con la misma sesión.
  async function esperarYAdquirir() {
    while (!(await intentarAdquirir())) {
      console.log(`⏳ Sesión WhatsApp en uso por otro proceso; reintentando en ${TTL_SECONDS}s...`);
      await new Promise(resolve => setTimeout(resolve, TTL_SECONDS * 1000));
    }
    asegurarRenovacion();
  }

  async function liberar() {
    if (renovacion) {
      clearInterval(renovacion);
      renovacion = null;
    }
    if (!sostenido) return;
    sostenido = false;
    try {
      await supabase.rpc('whatsapp_lock_release', { p_id: lockId, p_holder: HOLDER_ID });
    } catch (err) {
      console.error('⚠️ No se pudo liberar el lock de la sesión WhatsApp:', err?.message || err);
    }
  }

  return { esperarYAdquirir, liberar, holderId: HOLDER_ID };
}

module.exports = { crearLockSesionWhatsapp };
