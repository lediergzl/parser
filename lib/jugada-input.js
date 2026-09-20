// Normalización y validaciones de entrada compartidas por Telegram y WhatsApp.
function normalizarEntradaJugada(texto) {
  let salida = String(texto || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  salida = salida.replace(/^([^\d\r\n]+?)\s+(\d{1,2})\s+al\s+(\d{1,2})\s+con\s+\$?(\d+(?:[.,]\d+)?)\s*$/gim,
    (_, nombre, inicio, fin, monto) => {
      const desde = Number(inicio), hasta = Number(fin);
      if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde > hasta || desde < 0 || hasta > 99) return _;
      const numeros = [];
      for (let n = desde; n <= hasta; n++) numeros.push(String(n).padStart(2, '0'));
      return nombre.trim() + '\n' + numeros.join(' ') + ' con ' + monto;
    });

  salida = salida.replace(/^(\d{1,2})\s+al\s+(\d{1,2})\s+con\s+\$?(\d+(?:[.,]\d+)?)\s*$/gim,
    (_, inicio, fin, monto) => {
      const desde = Number(inicio), hasta = Number(fin);
      if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde > hasta || desde < 0 || hasta > 99) return _;
      const numeros = [];
      for (let n = desde; n <= hasta; n++) numeros.push(String(n).padStart(2, '0'));
      return numeros.join(' ') + ' con ' + monto;
    });

  const numerosPareja = '00 11 22 33 44 55 66 77 88 99';
  const patronParejaModificador = /^([^\d\r\n]+?)\s+(?:pareja|parejas|pares)\s+(parle|parlet|p|candado|c)\s*(\d+(?:[.,]\d+)?)\s*$/gim;
  salida = salida.replace(patronParejaModificador, (_, nombre, modificador, monto) => {
    const mod = /^(p|parlet)$/i.test(modificador) ? 'parle' : (/^c$/i.test(modificador) ? 'candado' : modificador.toLowerCase());
    return nombre.trim() + '\n' + numerosPareja + ' ' + mod + ' con ' + monto;
  });
  salida = salida.replace(/^(?:pareja|parejas|pares)\s+(parle|parlet|p|candado|c)\s*(\d+(?:[.,]\d+)?)\s*$/gim,
    (_, modificador, monto) => {
      const mod = /^(p|parlet)$/i.test(modificador) ? 'parle' : (/^c$/i.test(modificador) ? 'candado' : modificador.toLowerCase());
      return numerosPareja + ' ' + mod + ' con ' + monto;
    });
  salida = salida.replace(/^([^\d\r\n]+?)\s+(?:pareja|parejas|pares)\s+(?:de\s+)?candado\s+(\d+(?:[.,]\d+)?)[ \t]*$/gim,
    (_, nombre, monto) => nombre.trim() + '\npareja candado ' + monto);
  salida = salida.replace(/^([^\d\r\n]+?)\s+candado\s+(?:pareja|parejas|pares)\s+(\d+(?:[.,]\d+)?)[ \t]*$/gim,
    (_, nombre, monto) => nombre.trim() + '\ncandado pareja ' + monto);

  salida = salida.replace(/(\b(?:con|a|de|parle|candado|p|c)\s+)\$?(\d+)[.,]00\b/gi,
    (_, prefijo, numero) => prefijo + numero);
  salida = salida.replace(/\btotal\s*(?:(?:[-:]\s*)|(?:\s+de\s+))?\$?\s*\d+(?:[.,]\d+)?/gi, '');

  return salida.trim();
}

function detectarNumerosAmbiguos(texto) {
  const encontrados = [];
  const regex = /(^|[^\d])([0-9]{4})(?=$|[^\d])/g;
  let match;
  while ((match = regex.exec(String(texto || ''))) !== null) {
    const antes = String(texto || '').slice(0, match.index + match[1].length);
    if (/\b(?:con|a)\s*$/i.test(antes)) continue;
    encontrados.push(match[2]);
  }
  return [...new Set(encontrados)];
}

function extraerTotalDeclarado(texto) {
  const raw = String(texto || '');
  const matches = [...raw.matchAll(/(?:^|\n)\s*total\s*[:=]?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)/gim)];
  if (!matches.length) return null;
  const valor = Number(String(matches[matches.length - 1][1] || '').replace(',', '.'));
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

module.exports = { normalizarEntradaJugada, detectarNumerosAmbiguos, extraerTotalDeclarado };
