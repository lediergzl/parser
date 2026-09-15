// test-ultimo-resultado.js
// ----------------------------------------------------------------------------
// Prueba puntual (no queda corriendo): busca el ÚLTIMO mensaje de
// @boliterostop_bot en el grupo indicado y lo procesa con el MISMO
// parser/resolver/guardado que usa userbot-resultados.js en producción.
// Sirve para probar sin tener que esperar al próximo sorteo real.
//
// Uso (con las mismas variables que ya configuraste en Render):
//   TG_API_ID=... TG_API_HASH=... TG_SESSION=... \
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node test-ultimo-resultado.js
//
// Por defecto busca en @MentesMillonariasbolitachat; para usar otro grupo:
//   CHAT_RESULTADOS=@otro_grupo node test-ultimo-resultado.js
// ----------------------------------------------------------------------------
const {
  crearClienteConectado,
  parsearMensajeResultado,
  resolverLoteriaSorteo,
  guardarResultado,
  ORIGEN_ESPERADO,
} = require('./userbot-resultados');

const CHAT = process.env.CHAT_RESULTADOS || '@MentesMillonariasbolitachat';

(async () => {
  const client = await crearClienteConectado();
  if (!client) {
    console.error('❌ Faltan TG_API_ID / TG_API_HASH / TG_SESSION.');
    process.exit(1);
  }

  console.log(`🔎 Buscando en ${CHAT} el último mensaje de ${ORIGEN_ESPERADO}...`);
  let entity;
  try {
    entity = await client.getEntity(CHAT);
  } catch (e) {
    console.error(`❌ No se pudo acceder a ${CHAT}. ¿La cuenta del userbot está unida a ese grupo?`, e.message);
    process.exit(1);
  }

  const mensajes = await client.getMessages(entity, { limit: 50 });

  let encontrado = null;
  for (const msg of mensajes) { // getMessages entrega del más reciente al más viejo
    if (!msg.message) continue;
    const remitente = await msg.getSender();
    const username = remitente?.username ? `@${remitente.username}` : null;
    if (username === ORIGEN_ESPERADO) { encontrado = msg; break; }
  }

  if (!encontrado) {
    console.log(`⚠️  No encontré ningún mensaje de ${ORIGEN_ESPERADO} en los últimos 50 mensajes de ${CHAT}.`);
    process.exit(1);
  }

  console.log('📩 Último mensaje encontrado:\n', encontrado.message, '\n---');

  const parsed = parsearMensajeResultado(encontrado.message);
  if (!parsed) {
    console.log('❌ No se pudo parsear ese mensaje con el formato esperado.');
    process.exit(1);
  }
  console.log('✅ Parseado:', parsed);

  const destino = await resolverLoteriaSorteo(parsed.clave);
  if (destino.error) {
    console.log(`❌ No se pudo resolver lotería/sorteo para "${parsed.clave}": ${destino.error}`);
    process.exit(1);
  }
  console.log('✅ Resuelto a:', destino);

  await guardarResultado({
    loteriaId: destino.loteriaId, sorteoId: destino.sorteoId,
    fijo: parsed.fijo, corrido: parsed.corrido, centena: parsed.centena,
    fecha: parsed.fecha,
  });

  console.log('\n🎉 Prueba completa. Revisa la tabla resultados_sorteo y premios en Supabase.');
  process.exit(0);
})().catch(e => {
  console.error('❌ Error en la prueba:', e);
  process.exit(1);
});
