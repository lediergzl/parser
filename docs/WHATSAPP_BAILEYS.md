# Integración de WhatsApp por Baileys

Esta integración es **opcional y secundaria**. Convive con la notificación por
WhatsApp Business Cloud API que ya existe en `whatsapp.js`: son dos vías
independientes y ninguna bloquea el registro de la apuesta.

- **Cloud API (`whatsapp.js`)**: número oficial de Meta, requiere token y
  `WHATSAPP_PHONE_NUMBER_ID`. Se dispara directo desde `bet-handler.js`.
- **Baileys (`lib/whatsapp-sender.js`)**: número normal vinculado por QR, permite
  enviar a **grupos**. Se dispara escuchando el bus de eventos.

## Piezas

| Archivo | Rol |
| --- | --- |
| `lib/event-bus.js` | `EventEmitter` único del proceso. `bet-handler.js` emite `jugada:procesada`. |
| `lib/wa-session-store.js` | `AuthenticationState` de Baileys guardado en `public.whatsapp_session`. |
| `lib/whatsapp-sender.js` | Conecta el socket, se suscribe al bus y envía la jugada. |
| `lib/jugadas-store.js` | Marca `jugadas_eventos.entregado_whatsapp` y evita reenvíos. |
| `whatsapp-baileys.js` | Arranque: monta `/health` y `/api/jugadas` sobre el Express existente. |
| `supabase/migrations/20260916000300_whatsapp_session.sql` | Tabla de sesión. |

El esqueleto original (`integrar/`) traía su propio `server.js` y una tabla
`jugadas` propia. Ambas cosas se descartaron: el proceso ya tiene un Express
(`index.js`, expuesto como `global.__LOTO_APP__`) y la jugada ya se persiste en
`public.bets` con su feed `public.jugadas_eventos`. Duplicarlas habría creado dos
fuentes de verdad.

## Variables de entorno

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `WA_BAILEYS_ENABLED` | sí, para activarla | `true` enciende la conexión. Sin ella, todo sigue igual que antes. |
| `WA_GROUP_ID` | sí, si se activa | Destino por defecto: `...@g.us` (grupo) o `...@s.whatsapp.net` (privado). |
| `SUPABASE_URL` | ya existía | |
| `SUPABASE_SERVICE_ROLE_KEY` | ya existía | Se acepta `SUPABASE_SERVICE_KEY` como alias. |

## Puesta en marcha

1. Correr la migración `20260916000300_whatsapp_session.sql` en Supabase.
2. `npm install` (agrega `@whiskeysockets/baileys` y `qrcode-terminal`).
3. Poner `WA_BAILEYS_ENABLED=true` y `WA_GROUP_ID` en el entorno.
4. En el primer arranque no hay sesión guardada: el **QR aparece en los logs**.
   Escanearlo desde el WhatsApp que va a operar el bot. Las credenciales quedan
   en `whatsapp_session`, así que el siguiente redeploy no pide QR.
5. Para obtener el ID de un grupo, loguear una vez
   `sock.ev.on('groups.upsert', console.log)` y leer el valor `...@g.us`.

## Mantener el servicio despierto (plan free de Render)

Configurar un pinger gratuito (cron-job.org, UptimeRobot) cada 10 minutos a:

```
GET https://TU-SERVICIO.onrender.com/health
```

La respuesta incluye el estado de la conexión de WhatsApp:

```json
{ "ok": true, "whatsapp_baileys_habilitado": true, "whatsapp_conectado": true }
```

Es un workaround, no una garantía: en el plan free Render puede reiniciar el
servicio en cualquier momento. Cuando el volumen de jugadas lo justifique, el
plan Starter elimina el spin-down y da disco persistente real.

## Entrada HTTP alternativa

Si más adelante el parser corre como proceso aparte, puede publicar la jugada en
vez de emitir el evento en memoria:

```
POST /api/jugadas
{ "betId": 123, "cliente": "...", "monto": 100, "rawText": "...", "destino": { "tipo": "grupo", "id": "...@g.us" } }
```

Responde `202` y emite `jugada:procesada` en el bus.

## Comportamiento ante fallos

- Baileys no instalado o mal configurado → se loguea el error, el bot arranca igual.
- Socket desconectado → la jugada se loguea como no enviada; no se pierde la apuesta.
- Reinicio con jugada ya entregada → `entregado_whatsapp` evita el mensaje duplicado.
