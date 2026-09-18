// Auth state de Baileys persistido en Supabase.
//
// IMPORTANTE:
// Baileys actualiza las Signal keys con mucha frecuencia. No debemos hacer
// varios upsert concurrentes sobre el JSON completo de "keys", porque una
// escritura antigua puede llegar después de una nueva y corromper el estado
// criptográfico. Las escrituras se serializan por sesión.
//
// Para sesiones comerciales usa whatsapp_comercial_session; para la sesión
// histórica/global mantiene compatibilidad con whatsapp_session.
async function useSupabaseAuthState(supabase, sessionId = 'default') {
  const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
  const commercial = String(sessionId).startsWith('commercial:');
  const table = commercial ? 'whatsapp_comercial_session' : 'whatsapp_session';
  const id = commercial ? Number(String(sessionId).slice('commercial:'.length)) : sessionId;
  const column = commercial ? 'comercial_telegram_id' : 'id';

  const serialize = obj => JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
  const deserialize = obj => JSON.parse(JSON.stringify(obj), BufferJSON.reviver);

  async function readRow() {
    const { data, error } = await supabase
      .from(table)
      .select('creds,keys')
      .eq(column, id)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  const existing = await readRow();
  const creds = existing?.creds ? deserialize(existing.creds) : initAuthCreds();
  const keysData = existing?.keys ? deserialize(existing.keys) : {};

  // Todas las escrituras de esta sesión pasan por esta cola.
  // Así se evita que Supabase aplique snapshots viejos después de nuevos.
  let writeQueue = Promise.resolve();

  function enqueuePersist() {
    const job = writeQueue
      .catch(() => {})
      .then(async () => {
        const payload = commercial
          ? {
              comercial_telegram_id: id,
              creds: serialize(creds),
              keys: serialize(keysData),
              updated_at: new Date().toISOString()
            }
          : {
              id,
              creds: serialize(creds),
              keys: serialize(keysData),
              updated_at: new Date().toISOString()
            };

        const { error } = await supabase.from(table).upsert(payload);
        if (error) throw error;
      });

    writeQueue = job.catch(() => {});
    return job;
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const key of ids) {
            const value = keysData?.[type]?.[key];
            if (value) result[key] = value;
          }
          return result;
        },

        set: async data => {
          for (const type in data) {
            keysData[type] = keysData[type] || {};
            Object.assign(keysData[type], data[type]);
          }

          await enqueuePersist();
        }
      }
    },

    saveCreds: enqueuePersist
  };
}

module.exports = { useSupabaseAuthState };
