// Dentro de bot.on('text', ...), después de obtener `resultado.ok`
if (!resultado.ok) {
  // ... manejo de error igual que antes ...
  return;
}

// Formatear de manera compacta
let respuesta = '💰 *Total:* ' + resultado.totalGeneral.toFixed(2) + '\n\n';
let bloqueActual = null;
let lineasAgrupadas = [];

// Dividir el detalleTexto por líneas
const lines = resultado.detalleTexto.split('\n');
for (let line of lines) {
  line = line.trim();
  if (line === '') continue;

  // Detectar inicio de bloque: "=== JUGADOR: xxx ==="
  const matchJugador = line.match(/^=== JUGADOR:\s*(.+?)\s*===/i);
  if (matchJugador) {
    if (bloqueActual) {
      // Cerrar bloque anterior
      respuesta += `*${bloqueActual.nombre}*\n`;
      for (const item of lineasAgrupadas) {
        respuesta += `  ${item}\n`;
      }
      respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n\n`;
      lineasAgrupadas = [];
    }
    bloqueActual = { nombre: matchJugador[1], total: 0 };
    continue;
  }

  // Detectar líneas de tipo "Fijos: ..."
  const matchFijos = line.match(/^(Fijos|Corridos|Centena|Parle):\s*(.*)/i);
  if (matchFijos && bloqueActual) {
    const tipo = matchFijos[1];
    const contenido = matchFijos[2];
    // Si es una línea de total dentro del bloque (ej. "TOTAL Pepe: 145.00")
    const matchTotal = line.match(/^TOTAL\s+(\S+):\s+([\d.]+)/i);
    if (matchTotal) {
      bloqueActual.total = parseFloat(matchTotal[2]);
      continue;
    }
    // Acumular líneas de apuestas
    lineasAgrupadas.push(`${tipo}: ${contenido}`);
    continue;
  }

  // Otras líneas (por si el motor saca algo más) las agregamos literalmente
  if (bloqueActual) {
    lineasAgrupadas.push(line);
  }
}

// Cerrar último bloque
if (bloqueActual) {
  respuesta += `*${bloqueActual.nombre}*\n`;
  for (const item of lineasAgrupadas) {
    respuesta += `  ${item}\n`;
  }
  respuesta += `  *TOTAL ${bloqueActual.nombre}:* ${bloqueActual.total.toFixed(2)}\n`;
}

// Agregar total general si ya no está incluido
if (!respuesta.includes('TOTAL GENERAL')) {
  respuesta += `\n*TOTAL GENERAL:* ${resultado.totalGeneral.toFixed(2)}`;
}

await ctx.reply(respuesta, { parse_mode: 'Markdown' });
