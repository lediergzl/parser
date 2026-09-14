// Compatibilidad para montos decimales en el motor LotoPro.
//
// El preprocesador histórico limpia los separadores entre dígitos antes de
// validar el lado derecho. Eso convierte, por ejemplo, "61.50" en "61 50".
// Aquí protegemos los montos decimales antes de entrar al motor usando una
// escala entera y devolvemos el resultado a su valor monetario original.
//
// También normalizamos montos monetarios con .00/,00 a enteros:
//   25,00  -> 25
//   1101.00 -> 1101
// mientras conservamos los decimales reales:
//   25,05 -> 25,05
//   61.50 -> 61.50

(function instalarCompatibilidadDecimal(global) {
  const Engine = global && global.Engine;
  if (!Engine || typeof Engine.calcular !== 'function') {
    console.warn('⚠️ Compatibilidad decimal: Engine.calcular no está disponible todavía.');
    return;
  }
  if (Engine.__decimalAmountPatchInstalled) return;

  const originalCalcular = Engine.calcular.bind(Engine);

  function contarDecimales(numero) {
    const m = String(numero).match(/[.,](\d+)$/);
    return m ? m[1].length : 0;
  }

  function prepararEntrada(rawInput) {
    // Normaliza conectores "a" pegados al número de la jugada cuando el
    // siguiente token es realmente un monto decimal. Así "t2a 0.55" pasa a
    // "t2 a 0.55" y entra en la misma ruta de protección decimal que
    // "t2 a 0.55" o "02 12 a 0.55".
    let texto = String(rawInput || '').replace(
      /(\d)a\s+(?=\$?\d+[.,]\d+)/gi,
      '$1 a '
    );

    // Un monto terminado en .00/,00 es monetariamente entero. Se normaliza
    // solo después de un con/a/de (o modificador equivalente), nunca sobre
    // los números de la jugada.
    texto = texto.replace(
      /\b(?:con|a|de|parle|candado|p|c)\s+(\$?\d+)[.,]00\b/gi,
      (_, numero) => `${_.slice(0, 0)}${numero}`
    );

    const montos = [];
    const regex = /\b(?:con|a|de|parle|candado|p|c)\s+\$?\s*(\d+[.,]\d+)\b/gi;
    let match;

    while ((match = regex.exec(texto)) !== null) {
      montos.push({ start: match.index, end: regex.lastIndex, numero: match[1] });
    }

    if (!montos.length) return { input: texto, scale: 1 };

    const maxDecimales = Math.max(...montos.map(m => contarDecimales(m.numero)));
    if (!maxDecimales) return { input: texto, scale: 1 };

    const scale = 10 ** maxDecimales;
    let salida = '';
    let cursor = 0;

    for (const monto of montos) {
      const fragmento = texto.slice(monto.start, monto.end);
      const numeroEscalado = Math.round(Number(monto.numero.replace(',', '.')) * scale);
      const reemplazo = fragmento.replace(monto.numero, String(numeroEscalado));
      salida += texto.slice(cursor, monto.start) + reemplazo;
      cursor = monto.end;
    }
    salida += texto.slice(cursor);

    return { input: salida, scale };
  }

  function escalarValor(valor, scale) {
    return typeof valor === 'number' && Number.isFinite(valor) ? valor / scale : valor;
  }

  function escalarResultado(resultado, scale) {
    if (!resultado || scale === 1) return resultado;

    const salida = { ...resultado };

    for (const key of ['totalGeneral', 'totalSolicitado', 'total', 'monto']) {
      if (Object.prototype.hasOwnProperty.call(salida, key)) {
        salida[key] = escalarValor(salida[key], scale);
      }
    }

    const escalarObjeto = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(escalarObjeto);

      const out = { ...obj };
      for (const [key, value] of Object.entries(out)) {
        if (['monto', 'monto_unitario', 'importe', 'total', 'totalGeneral', 'totalSolicitado'].includes(key)) {
          out[key] = escalarValor(value, scale);
        } else if (value && typeof value === 'object') {
          out[key] = escalarObjeto(value);
        }
      }
      return out;
    };

    for (const key of ['jugadas', 'detalle', 'detalles']) {
      if (Object.prototype.hasOwnProperty.call(salida, key)) {
        salida[key] = escalarObjeto(salida[key]);
      }
    }

    if (typeof salida.detalleTexto === 'string') {
      salida.detalleTexto = salida.detalleTexto.replace(/\d+(?:\.\d{2,})/g, token => {
        const valor = Number(token);
        return Number.isFinite(valor) ? (valor / scale).toFixed(2) : token;
      });
    }

    return salida;
  }

  Engine.calcular = function calcularConMontosDecimales(opciones, deps) {
    const entrada = prepararEntrada(opciones && opciones.rawInput);
    if (entrada.scale === 1) return originalCalcular(opciones, deps);

    const opcionesEscaladas = { ...(opciones || {}), rawInput: entrada.input };
    const resultado = originalCalcular(opcionesEscaladas, deps);
    return escalarResultado(resultado, entrada.scale);
  };

  Engine.__decimalAmountPatchInstalled = true;
  console.log('✅ Compatibilidad de montos decimales instalada.');
})(typeof globalThis !== 'undefined' ? globalThis : global);
