# Modalidad Comercial + Resultados + Premios

## Qué se agregó

- `banca.js` — se registra desde `bet-bootstrap.js`, antes de `bet-handler.js`
  (bet-handler.js no llama `next()`, así que si corriera primero se comería
  el texto de estos flujos).
- `premios.js` — detección de jugadas ganadoras y cálculo de premio, usado
  por `banca.js` y por `userbot-resultados.js`.
- `userbot-resultados.js` + `generar-session.js` — proceso APARTE (no se
  arranca con el bot) que escucha a `@boliterostop_bot` vía una sesión de
  usuario real (Telegram no deja que un bot reciba mensajes de otro bot) y
  carga los resultados automáticamente.
- Migraciones `20260915000200_comercial_banca_premios.sql` y
  `20260915000300_premios_monto_unitario.sql`: rol de usuario, tabla
  `clientes_banca`, columnas de origen en `bets`, `resultados_sorteo`,
  `premios`.

## Comandos nuevos (dentro del bot)

- `/comercial_add <telegram_id>` — solo admin, promueve a comercial.
- `/jugada` — comercial: pega el texto con jugadas (varios jugadores por
  mensaje, mismo formato banca que ya entiende `lotopro-core.bundle.js`).
- `/resultado` — comercial: carga fijo/corrido/centena manualmente.
- `/premios` — lista premios detectados, con botones para confirmar monto y
  "Cobrar" / "Dejar depósito".

## Pago automático por tipo (dado por el comercial)

fijo 80x, corrido 30x, centena 500x, parle 1000x — sobre el monto unitario
apostado a esa combinación, no sobre el total de la línea. Candado queda sin
tasa definida a propósito: su premio se confirma a mano en `/premios`.

## Un solo proceso (no hace falta un servicio aparte en Render)

El userbot corre **dentro del mismo proceso** del bot: `bet-bootstrap.js` lo
arranca al final, envuelto en try/catch, así que si faltan las variables de
entorno o el paquete no está instalado, el bot sigue funcionando igual, solo
sin escuchar resultados. Lo único que sí es un paso aparte es **generar la
sesión** (`generar-session.js`), porque pide el código de Telegram por
consola de forma interactiva — eso se corre una vez, localmente, antes de
desplegar; después solo hace falta copiar `TG_SESSION` a las variables de
entorno del mismo servicio.

## Pendiente de correr aparte (una sola vez, no es un servicio nuevo)

1. Aplicar las dos migraciones nuevas en Supabase.
2. `npm install` (ya agregado `telegram` e `input` a package.json).
3. Localmente: `TG_API_ID=... TG_API_HASH=... node generar-session.js` →
   copiar el `TG_SESSION` que imprime.
4. En las variables de entorno del servicio del bot (Render), agregar
   `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` (y `RESULTADOS_ORIGEN` si el
   username de @boliterostop_bot cambiara).
5. Completar `TERMINO_A_SORTEO` en `userbot-resultados.js` si aparecen
   loterías/sorteos nuevos (hoy cubre Florida/New York/Georgia con Día,
   Tarde, Noche — el catálogo real del proyecto).
