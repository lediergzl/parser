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

## Pendiente de correr aparte (no bloquea el bot)

1. Aplicar las dos migraciones nuevas en Supabase.
2. Generar la sesión del userbot: `TG_API_ID=... TG_API_HASH=... node generar-session.js`.
3. Completar `TERMINO_A_SORTEO` en `userbot-resultados.js` si aparecen
   loterías/sorteos nuevos (hoy cubre Florida/New York/Georgia con Día,
   Tarde, Noche — que es el catálogo real del proyecto).
4. Correr `userbot-resultados.js` como proceso independiente (otro servicio
   en Render, o un cron/worker) con `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
