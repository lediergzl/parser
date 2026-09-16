# render-wa-bot

Esqueleto para correr en el plan **free de Render**:
- WhatsApp (Baileys) con sesión persistida en Supabase (no en disco, porque el free tier no tiene disco persistente).
- Un `event bus` en memoria que conecta tu parser de Telegram con el envío a WhatsApp y el guardado en Supabase.
- Endpoint `/health` para que un pinger externo evite que Render duerma el servicio (spin-down a los 15 min de inactividad en el free tier).

## 1. Variables de entorno (en Render → Environment)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (service role key, no la anon key, porque escribe en las tablas)
- `WA_GROUP_ID` (opcional, si quieres tenerlo fijo — o lo mandas en cada jugada vía `destino.id`)

## 2. Base de datos

Corre `supabase-schema.sql` en el SQL editor de Supabase antes de desplegar.

## 3. Primer arranque / vincular WhatsApp

La primera vez no hay sesión guardada, así que al arrancar el proceso vas a ver el QR
en los logs de Render (usa `qrcode-terminal`). Escanéalo desde el WhatsApp que va a operar el bot.
Una vez vinculado, las credenciales quedan en la tabla `whatsapp_session` de Supabase,
así que en el próximo redeploy/reinicio no hace falta volver a escanear.

## 4. Mantener el servicio despierto (plan free)

Configura un pinger gratuito (cron-job.org, UptimeRobot, etc.) que le pegue a:

```
GET https://TU-SERVICIO.onrender.com/health
```

cada 10 minutos. Esto es un workaround, no una garantía — Render puede igual reiniciar
el servicio en cualquier momento en el plan free. Cuando el volumen de jugadas justifique
el costo, pasar a un plan Starter ($7/mes) elimina el spin-down y te da disco persistente real.

## 5. Conectar tu parser de Telegram existente

En el punto de tu código actual (`bootstrap.js` / `bet-handler.js`) donde ya tienes la
jugada procesada y validada, agrega:

```js
const bus = require('./lib/event-bus');

bus.emit('jugada:procesada', {
  external_id: msg.message_id,   // evita duplicados
  cliente: '...',
  banca: '...',
  numeros: { ... },              // lo que ya devuelva tu parser
  monto: 100,
  raw_text: msg.text,
  destino: { tipo: 'grupo', id: process.env.WA_GROUP_ID },
});
```

Eso dispara automáticamente el envío a WhatsApp y el guardado en Supabase, sin acoplar
ambos módulos entre sí.

## 6. Obtener el ID del grupo de WhatsApp

Una vez conectado el socket, loguea `sock.ev.on('groups.upsert', console.log)` una vez
para ver los IDs (`...@g.us`) de los grupos donde está el número. Para un chat privado,
el formato es `'<numero_con_codigo_pais>@s.whatsapp.net'`.
