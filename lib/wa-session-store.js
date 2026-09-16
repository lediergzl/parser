// Baileys se requiere de forma diferida: la integración es opcional y el bot
// debe arrancar igual si la dependencia no está instalada.
// Implementa el AuthenticationState que pide Baileys, pero guardando/leyendo
// las credenciales y las "signal keys" desde Supabase en vez de disco.
// Así, cuando Render duerme/reinicia el servicio (plan free, sin disco persistente),
// al volver a levantar el proceso se recupera la sesión sin re-escanear el QR.
async function useSupabaseAuthState(supabase, sessionId = 'default') {
  const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

  const serialize = (obj) => JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
  const deserialize = (obj) => JSON.parse(JSON.stringify(obj), BufferJSON.reviver);

  async function readRow() {
    const { data, error } = await supabase
      .from('whatsapp_session')
      .select('creds, keys')
      .eq('id', sessionId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  const existing = await readRow();

  const creds = existing?.creds ? deserialize(existing.creds) : initAuthCreds();
  const keysData = existing?.keys ? deserialize(existing.keys) : {};

  async function persist() {
    await supabase.from('whatsapp_session').upsert({
      id: sessionId,
      creds: serialize(creds),
      keys: serialize(keysData),
      updated_at: new Date().toISOString(),
    });
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            const value = keysData?.[type]?.[id];
            if (value) result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          for (const type in data) {
            keysData[type] = keysData[type] || {};
            Object.assign(keysData[type], data[type]);
          }
          await persist();
        },
      },
    },
    saveCreds: async () => {
      await persist();
    },
  };
}

module.exports = { useSupabaseAuthState };
