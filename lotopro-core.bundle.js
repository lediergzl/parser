(function(global) {
'use strict';

// Alias interno: los módulos originales importaban limpiarMonto con este alias.
// Como limpiarMonto es una function declaration, está hoisted y disponible aquí.
// Esta asignación debe ocurrir antes de cualquier llamada a createExpansion().
var _limpiarMontoDefault = limpiarMonto;


// ═══════════════════════════════════════════════════
// MODULE: tracer.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/tracer.js
 *
 * Sistema de tracing centralizado y estructurado.
 * Activar/desactivar con TRACE_ENABLED.
 * Filtrar por stage con TRACE_FILTER (array de strings o null para todo).
 *
 * Uso:
 *   import { trace, TRACE_ENABLED } from './tracer.js';
 *   trace('ENGINE_TOKEN', { id: nextId(), token });
 */

// ─────────────────────────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────────────────────────

let TRACE_ENABLED = true;

/**
 * Filtra qué stages se muestran.
 * null  → muestra todo
 * ['ENGINE_TOKEN', 'CLASSIFIER_TYPE'] → solo esos stages
 */
let TRACE_FILTER = null;

/**
 * Si true, agrupa todos los traces de un mismo "id de línea" en consola.
 */
let TRACE_GROUP = false;

// ─────────────────────────────────────────────────────────────────
// ID INCREMENTAL DE TRAZA
// ─────────────────────────────────────────────────────────────────

let TRACE_ID = 0;

function resetTraceId() {
  TRACE_ID = 0;
}

function nextId() {
  return ++TRACE_ID;
}

// ─────────────────────────────────────────────────────────────────
// COLORES POR CATEGORÍA (para consolas que soporten estilos)
// ─────────────────────────────────────────────────────────────────

const STAGE_COLORS = {
  // Preprocesador → azul
  PRE_RAW:           '#4A90D9',
  PRE_NORMALIZED:    '#4A90D9',
  PRE_SPLIT:         '#4A90D9',
  PRE_FILTERED:      '#4A90D9',
  PRE_LINE_NO_DIGIT: '#4A90D9',
  PRE_LINE_NOISE:    '#4A90D9',
  PRE_START:         '#4A90D9',
  PRE_END:           '#4A90D9',

  // Parser → verde oscuro
  PARSER_LINE:        '#2E7D32',
  PARSER_IS_NAME:     '#2E7D32',
  PARSER_BLOCK_START: '#2E7D32',
  PARSER_ADD_LINE:    '#2E7D32',
  PARSER_BLOCK_END:   '#2E7D32',
  PARSER_SEPARATOR:   '#2E7D32',
  PARSER_ORPHAN:      '#FF6F00',

  // Classifier → morado
  CLASSIFIER_INPUT:  '#6A1B9A',
  CLASSIFIER_TYPE:   '#6A1B9A',
  CLASSIFIER_OPKIND: '#6A1B9A',
  CLASSIFIER_DB:     '#6A1B9A',

  // Engine → naranja oscuro
  ENGINE_TOKEN:                '#E65100',
  ENGINE_SEPARATOR:            '#E65100',
  ENGINE_RESET_BY_INVALID:     '#E65100',
  ENGINE_PARLE_GLOBAL_ENTER:   '#E65100',
  ENGINE_PARLE_GLOBAL_OPS:     '#E65100',
  ENGINE_CANDADO_GLOBAL_ENTER: '#E65100',
  ENGINE_CANDADO_GLOBAL_OPS:   '#E65100',
  ENGINE_NORMAL_LINE:          '#E65100',
  ENGINE_NORMAL_OPS:           '#E65100',
  ENGINE_COLLECT_BEFORE:       '#E65100',
  ENGINE_COLLECT_AFTER:        '#E65100',
  ENGINE_CONTEXT_RESET:        '#E65100',
  ENGINE_CENTENA_OPS:          '#E65100',

  // Evaluator → teal
  EVAL_BUILD_OPS:  '#00695C',
  EVAL_OPERATION:  '#00695C',
  EVAL_RESULT:     '#00695C',
  EVAL_VALIDATE:   '#00695C',

  // Globales
  INPUT_START:   '#1565C0',
  FINAL_RESULT:  '#1565C0',

  // Errores → rojo
  ERROR: '#C62828',
  NUMERIC_LINE_DISCARDED_FATAL: '#C62828',  // siempre rojo — violación de NO_BET_LOSS
};

// ─────────────────────────────────────────────────────────────────
// FUNCIÓN CENTRAL DE TRAZA
// ─────────────────────────────────────────────────────────────────

/**
 * Emite una traza estructurada.
 *
 * @param {string} stage   - identificador del punto de traza (ej: 'ENGINE_TOKEN')
 * @param {*}      payload - datos relevantes (objeto, string, array, etc.)
 */
function trace(stage, payload) {
  if (!TRACE_ENABLED) return;
  if (TRACE_FILTER && !TRACE_FILTER.includes(stage)) return;

  const color = STAGE_COLORS[stage] || '#555555';
  const label = `[TRACE][${stage}]`;

  // Browser: usa estilos CSS en console
  if (typeof window !== 'undefined') {
    console.log(
      `%c${label}`,
      `color: ${color}; font-weight: bold; font-family: monospace;`,
      payload
    );
  } else {
    // Node.js: sin estilos
    console.log(label, payload);
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPERS PARA ACTIVAR / DESACTIVAR EN RUNTIME
// ─────────────────────────────────────────────────────────────────

function enableTrace()  { TRACE_ENABLED = true;  }
function disableTrace() { TRACE_ENABLED = false; }

function setTraceFilter(stages) {
  TRACE_FILTER = Array.isArray(stages) ? stages : null;
}

/**
 * Expone controles en window para activar desde DevTools:
 *   window.__trace.enable()
 *   window.__trace.disable()
 *   window.__trace.filter(['ENGINE_TOKEN', 'CLASSIFIER_TYPE'])
 *   window.__trace.all()
 */
function exposeTraceControls() {
  if (typeof window !== 'undefined') {
    window.__trace = {
      enable:  enableTrace,
      disable: disableTrace,
      filter:  setTraceFilter,
      all:     () => setTraceFilter(null),
      id:      () => TRACE_ID,
      reset:   resetTraceId,
    };
    console.log(
      '%c[TRACE] Controles disponibles en window.__trace → .enable() .disable() .filter([...stages]) .all()',
      'color: #1565C0; font-weight: bold;'
    );
  }
}

// ═══════════════════════════════════════════════════
// MODULE: limpiarMonto.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/utils/limpiarMonto.js
 *
 * ORIGEN: Utils.limpiarMonto (index.html, línea 1396-1405)
 *
 * TRANSFORMACIÓN (Categoría A — Lógica pura):
 *   La función original vivía dentro del IIFE Utils en el HTML y era accedida
 *   globalmente como Utils.limpiarMonto / window.limpiarMonto.
 *   No tenía ninguna dependencia de DOM ni de window.
 *   → Se extrae tal cual como módulo ES independiente.
 *
 * INYECCIÓN:
 *   createMotor({ limpiarMonto })         ← deps.limpiarMonto
 *   Expansion.createExpansion({ limpiarMonto }) ← deps en extractParlePairs / extractMontosAfterCon
 *
 * CONTRATO:
 *   limpiarMonto(s: string | number | null) → number | null
 *
 *   - null / undefined     → null
 *   - "   "  / ""          → null
 *   - "$1.234,56"          → 1234.56   (limpia $, espacios, punto de miles → decimal)
 *   - "1234.5"             → 1234.5
 *   - "abc"                → null
 */

/**
 * Normaliza un string de monto a número flotante.
 *
 * Reglas de normalización (idénticas a la implementación original):
 *  1. null/undefined → null
 *  2. Elimina espacios y símbolo $
 *  3. Convierte comas en puntos
 *  4. Si hay más de un punto (separador de miles + decimal), mantiene
 *     solo el último punto como separador decimal y elimina los anteriores
 *  5. parseFloat; si no es finito → null
 *
 * @param {string|number|null|undefined} s
 * @returns {number|null}
 */
function limpiarMonto(s) {
  if (s == null) return null;

  let txt = String(s)
    .replace(/\s+/g, '')   // eliminar espacios
    .replace(/\$/g, '');   // eliminar símbolo de moneda

  if (!txt) return null;

  // Normalizar separador decimal: comas → puntos
  txt = txt.replace(/,/g, '.');

  // Si hay más de un punto (e.g. "1.234.56"), el último es el decimal
  // y los anteriores son separadores de miles → eliminarlos
  const dotCount = (txt.match(/\./g) || []).length;
  if (dotCount > 1) {
    const lastDot = txt.lastIndexOf('.');
    txt = txt.slice(0, lastDot).replace(/\./g, '') + '.' + txt.slice(lastDot + 1);
  }

  const n = parseFloat(txt);
  return Number.isFinite(n) ? n : null;
}




// ═══════════════════════════════════════════════════
// MODULE: expansion.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/expansion.js
 *
 * Fábrica de expansión de líneas.
 */

function createExpansion(deps = {}) {
  const lm = typeof deps.limpiarMonto === 'function' ? deps.limpiarMonto : _limpiarMontoDefault;

  function expandirTodasLasCentenas(texto) {
    const patron = /((?:\d+\s+)+)(?:por\s+)?(?:todas\s+(?:las\s+)?)?centenas(.*)/gi;
    let resultado = texto;
    let match;
    while ((match = patron.exec(texto)) !== null) {
      const numeros = match[1].trim().split(/\s+/);
      const resto = match[2] || '';
      const lineas = numeros.map(numero => {
        const base = numero.padStart(2, '0');
        const cs = [];
        for (let c = 0; c <= 9; c++) cs.push(String(c) + base);
        return cs.join(' ') + resto;
      });
      resultado = resultado.replace(match[0], lineas.join('\n'));
    }
    return resultado;
  }

  function expandirPorLaCentena(texto) {
    const patron = /\b((?:\d{1,2}\s+)+)(?:por\s+)?(?:la\s+)?centena[s]?\s+((?:\d{1,2}\s*)+?)(?=con\b|candado\b|parle\b|$)/gi;
    return texto.replace(patron, (match, nums, centenas) => {
      const listaFijos = nums.trim().split(/\s+/).filter(Boolean).map(n => n.padStart(2, '0'));
      const listaCentenas = centenas.trim().split(/\s+/).filter(Boolean);
      if (!listaFijos.length || !listaCentenas.length) return match;
      const resultado = [];
      for (const c of listaCentenas)
        for (const f of listaFijos)
          resultado.push(c + f);
      return resultado.join(' ') + ' ';
    });
  }

  function expandirVolteoNumeros(texto) {
    return texto.replace(/(\d+)\s*v\s*(\d*)/gi, (match, num, tail) => {
      const n = num.padStart(2, '0');
      const v = n.split('').reverse().join('');
      return tail && tail.trim() !== '' ? `${n} ${tail.padStart(2, '0')}` : `${n} ${v}`;
    });
  }

  function expandirPatronPR(texto) {
    const patron = /\b(\d{1,2})\s+pr\s+([^\n\r]+?)(?=(?:\s+(?:con|parle|candado)\b|\s*$))/gi;
    let resultado = texto;
    const matches = [];
    let m;
    while ((m = patron.exec(texto)) !== null) {
      matches.push({ numeroBase: String(m[1]).padStart(2, '0'), tail: m[2].trim(), index: m.index, length: m[0].length });
    }
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const tokens = m.tail.split(/\s+/).filter(Boolean);
      let pares = [];
      const todosTermDecena = tokens.length > 1 && tokens.every(t => /^[td]\d{1,2}$/i.test(t));
      if (todosTermDecena) {
        tokens.forEach(token => {
          if (/^t\d{1,2}$/i.test(token)) {
            const u = parseInt(token.substring(1), 10) % 10;
            for (let d = 0; d <= 9; d++) pares.push(m.numeroBase + String(d) + String(u));
          } else if (/^d\d{1,2}$/i.test(token)) {
            const dec = parseInt(token.substring(1), 10) % 10;
            for (let u = 0; u <= 9; u++) pares.push(m.numeroBase + String(dec) + String(u));
          }
        });
      } else if (tokens.length > 1 && tokens.every(t => /^\d{2}$/.test(t))) {
        pares = tokens.map(t => m.numeroBase + t);
      } else if (tokens.length > 0 && tokens.every(t => /^\d{4}$/.test(t))) {
        pares = tokens.slice();
      } else {
        const token = (tokens[0] || '').trim();
        if (/^t\d{1,2}$/i.test(token)) {
          const u = parseInt(token.substring(1), 10) % 10;
          for (let d = 0; d <= 9; d++) pares.push(m.numeroBase + String(d) + String(u));
        } else if (/^d\d{1,2}$/i.test(token)) {
          const dec = parseInt(token.substring(1), 10) % 10;
          for (let u = 0; u <= 9; u++) pares.push(m.numeroBase + String(dec) + String(u));
        } else if (/^\d{1,2}$/.test(token)) {
          const n = Math.max(0, parseInt(token, 10));
          for (let j = 0; j < n; j++) pares.push(m.numeroBase + String(j).padStart(2, '0'));
        } else {
          pares = [m.numeroBase + token];
        }
      }
      resultado = resultado.slice(0, m.index) + pares.join(' ') + resultado.slice(m.index + m.length);
    }
    return resultado;
  }

  function expandirRangos(texto) {
    return texto.replace(/(\b\d{1,3}(?:[.,]\d+)?)\s*(?:al|a|\-|\.\.)\s*(\d{1,3}(?:[.,]\d+)?\b)/gi, (match, aStr, bStr, offset, whole) => {
      const sn = parseFloat(String(aStr).replace(',', '.'));
      const fn = parseFloat(String(bStr).replace(',', '.'));
      if (isNaN(sn) || isNaN(fn) || sn > fn) return match;
      const leftCtx = whole.slice(Math.max(0, offset - 12), offset).toLowerCase();
      const dinero = /\b(con|de|monto|montos|pesos|bs|bss|s\/b|\$|mxn|usd)\b/i;
      if (dinero.test(leftCtx) || /[.,]\d+/.test(aStr) || /[.,]\d+/.test(bStr)) {
        if (Math.abs(sn - fn) < 1e-9) return String(Math.round(sn)).padStart(2, '0');
        return match;
      }
      const si = Math.round(sn);
      const fi = Math.round(fn);
      if (si === fi) return String(si).padStart(2, '0');
      const use3 = si >= 100 || fi >= 100;
      const nums = [];
      for (let i = si; i <= fi; i++) {
        nums.push(String(i).padStart(use3 ? 3 : 2, '0'));
      }
      return nums.join(' ');
    });
  }

  function normalizeNumToken(s) {
    if (!s) return null;
    let t = String(s).trim().replace(/[oOοΟ]/g, '0');
    t = (t.match(/\d+/g) || []).join('');
    if (!t) return null;
    if (t.length <= 2) return t.padStart(2, '0');
    if (t.length === 3 || t.length === 4) return t;
    if (t.length > 4) return t.slice(-3);
    return t;
  }

  function extractNumsFromSegment(segment) {
    let seg = expandirTodasLasCentenas(segment);
    seg = expandirPorLaCentena(seg);
    seg = expandirVolteoNumeros(seg);
    seg = expandirPatronPR(seg);
    seg = expandirRangos(seg);
    return (seg.match(/\b[0-9oOοΟ０-９]{1,4}\b/g) || [])
      .map(t => normalizeNumToken(t))
      .filter(Boolean);
  }

  function extractNumsBeforeKeywords(line) {
    const idx = line.toLowerCase().search(/\b(con|parle|candado|total)\b/);
    const part = idx === -1 ? line : line.slice(0, idx);
    return extractNumsFromSegment(part);
  }

  function extractParlePairsFromText(text) {
    const pares = [];
    if (!text || typeof text !== 'string') return pares;
    const tieneCon = /\bcon\b/i.test(text);
    const tieneParleExplicito = /\bparle\b/i.test(text) || /(?<![a-zA-Z])p\s+\d/.test(text) || /\bp\d/.test(text);
    const tieneCandadoExplicito = /\bcandado\b/i.test(text) || /(?<![a-zA-Z])c\s+\d/.test(text) || /\bc\d/.test(text);
    const tieneOp = /\d\s*[*xX×\-]\s*\d/.test(text);
    const tiene4 = /\b\d{4}\b/.test(text);
    const esLinea = tieneParleExplicito || tieneCandadoExplicito || tiene4 || (!tieneCon && tieneOp);
    if (tieneCon && !esLinea) { if (!tieneOp) return pares; }
    if (!esLinea && !tieneOp) return pares;
    let tp = text;
    const mCP = text.match(/con\s+([0-9.,]+)/i);
    if (mCP) tp = tp.substring(0, tp.toLowerCase().indexOf(' con '));
    const pats = [
      /\b(\d{1,2})\s*\*\s*(\d{1,2})\b/g,
      /\b(\d{1,2})\s*[xX]\s*(\d{1,2})\b/g,
      /\b(\d{1,2})\s*-\s*(\d{1,2})\b/g,
      /\b(\d{1,2})\s*×\s*(\d{1,2})\b/g,
    ];
    let m;
    for (const pat of pats) {
      while ((m = pat.exec(tp)) !== null) pares.push([m[1].padStart(2, '0'), m[2].padStart(2, '0')]);
    }
    if (tieneParleExplicito || tieneOp) {
      const p4 = /\b(\d{4})\b/g;
      while ((m = p4.exec(tp)) !== null) pares.push([m[1].substring(0, 2).padStart(2, '0'), m[1].substring(2).padStart(2, '0')]);
    }
    return pares;
  }

  function extractParlePairs(line) {
    const pares = extractParlePairsFromText(line);
    const esParleImplicito = /\d{1,2}\s*[xX*]\s*\d{1,2}/.test(line);
    const mParle = line.match(/\bparle\b(?:\s*[:=]|\s*)?(?:con\s*)?(\d+(?:[.,]\d+)?)/i) ||
                   line.match(/\bp\s*(\d+(?:[.,]\d+)?)/i) ||
                   (esParleImplicito ? line.match(/\bcon\s+(\d+(?:[.,]\d+)?)/i) : null);
    const monto = mParle ? lm(mParle[1]) : null;
    if (!pares.length && monto === null) return null;
    if (pares.length && monto === null && !/\bparle\b/i.test(line) && !esParleImplicito) return null;
    return { pares, monto };
  }

  function extractMontosAfterCon(line) {
    const m = line.match(/\b(con|de|a)\b([\s\S]*)/i);
    if (!m) return [];
    const montos = [];
    const np = /(\d+(?:[.,]\d+)?)/g;
    let match;
    while ((match = np.exec(m[2])) !== null) {
      const mo = lm(match[0]);
      if (mo !== null) montos.push(mo);
    }
    return montos;
  }

  function extractMontosFromText(text) {
    const montos = [];
    const np = /(\d+(?:[.,]\d+)?)/g;
    let match;
    while ((match = np.exec(text)) !== null) {
      const mo = lm(match[0]);
      if (mo !== null) montos.push(mo);
    }
    return montos;
  }

  return {
    expandirTodasLasCentenas,
    expandirPorLaCentena,
    expandirVolteoNumeros,
    expandirPatronPR,
    expandirRangos,
    normalizeNumToken,
    extractNumsFromSegment,
    extractNumsBeforeKeywords,
    extractParlePairsFromText,
    extractParlePairs,
    extractMontosAfterCon,
    extractMontosFromText,
  };
}

const Expansion = createExpansion();

// ═══════════════════════════════════════════════════
// MODULE: evaluator.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/evaluator.js
 *
 * CORRECCIÓN: parle local con pares explícitos usa la cantidad de pares,
 * no la combinatoria de números expandidos.
 * 
 * MEJORA: Reparto exacto de candados (y parlés) para evitar diferencias de centavos.
 *         Regla: "Nunca adaptar apuestas al dinero. Adaptar el dinero a apuestas válidas."
 *
 * ──────────────────────────────────────────────────────────────────
 * TRACING: Importa trace() de tracer.js. PROHIBIDO usar console.log directo.
 * ──────────────────────────────────────────────────────────────────
 */

function comb2(n) { return n < 2 ? 0 : n * (n - 1) / 2; }
function pad2(s) { return String(s || '').padStart(2, '0'); }
function pad3(s) { return String(s || '').padStart(3, '0'); }
function generarPares(nums) {
  const pares = [];
  for (let i = 0; i < nums.length; i++)
    for (let j = i + 1; j < nums.length; j++)
      pares.push([pad2(nums[i]), pad2(nums[j])]);
  return pares;
}

/**
 * Reparte un monto total en n partes iguales, ajustando a la baja para que
 * la suma de las partes sea exacta (sin decimales no divisibles).
 * Devuelve:
 *   - unit: monto unitario por parte (real / n)
 *   - real: total efectivo (múltiplo de n en centésimas)
 *   - diff: diferencia con el total original (ahorro del usuario)
 */
function repartirExacto(total, n) {
  const cents = Math.floor((total * 100) / n) * n;
  const real = cents / 100;
  const unit = real / n;
  const diff = +(total - real).toFixed(2);
  return { unit, real, diff };
}

// ──────────────── DETECCIÓN DE OPERADORES MAL ESCRITOS (Levenshtein) ─────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return Math.abs(m - n);
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}

const DSL_SEMANTIC_OPS = ['parle', 'candado', 'centena', 'total'];
const TYPO_THRESHOLD = 2;

function detectarOperadorMalEscrito(token) {
  const tok = token.toLowerCase();
  const allOps = [...DSL_SEMANTIC_OPS, 'con', 'y', 'al', 'de', 'a'];
  if (allOps.includes(tok)) return { isTypo: false };
  if (tok.length < 3) return { isTypo: false };
  for (const op of DSL_SEMANTIC_OPS) {
    if (Math.abs(tok.length - op.length) > 2) continue;
    const d = levenshtein(tok, op);
    if (d <= TYPO_THRESHOLD) return { isTypo: true, closestOp: op, distance: d };
  }
  return { isTypo: false };
}

function clasificarTokens(linea) {
  const raw = linea.trim().split(/\s+/);
  const resultado = [];
  let postCon = false;
  for (const tok of raw) {
    if (!tok) continue;
    const tokL = tok.toLowerCase();
    if (/^\d{1,3}$/.test(tok)) {
      resultado.push({ tok, type: postCon ? 'MONTO' : 'NUM' });
    } else if (/^\d+[.,]\d+$/.test(tok)) {
      resultado.push({ tok, type: 'MONTO' });
    } else if (tokL === 'con') {
      postCon = true;
      resultado.push({ tok, type: 'CON' });
    } else if (/^(parle|candado|y|al|centena|total|de|a)$/i.test(tok)) {
      resultado.push({ tok, type: 'OP' });
      if (/^(y|de|a)$/i.test(tok)) postCon = false;
    } else {
      const typoCheck = detectarOperadorMalEscrito(tok);
      resultado.push({ tok, type: typoCheck.isTypo ? 'TYPO_OP' : 'UNK', ...typoCheck });
    }
  }
  return resultado;
}

function validarEstructuraTokens(tokens, lineaNum) {
  const errors = [];
  const typoToken = tokens.find(t => t.type === 'TYPO_OP');
  if (typoToken) {
    errors.push({ code: 'E_TYPO_OP', line: lineaNum, message: `"${typoToken.tok}" parece un operador mal escrito.` });
    return errors;
  }
  const conIdx = tokens.findIndex(t => t.type === 'CON');
  const preCon = conIdx >= 0 ? tokens.slice(0, conIdx) : tokens;
  const numIndices = preCon.reduce((acc, t, i) => { if (t.type === 'NUM') acc.push(i); return acc; }, []);
  if (numIndices.length >= 2) {
    const firstNum = numIndices[0];
    const lastNum = numIndices[numIndices.length - 1];
    const intraNums = preCon.slice(firstNum, lastNum + 1);
    const unkIntra = intraNums.find(t => t.type === 'UNK');
    if (unkIntra) {
      errors.push({ code: 'E_UNK_INTRA_NUM', line: lineaNum, message: `"${unkIntra.tok}" aparece entre números y genera ambigüedad.` });
      return errors;
    }
  }
  return errors;
}

// ──────────────── BUILD DB ────────────────────────────────────────────────
function buildLineaDB(lineaOriginal, lineaExpandida, ex) {
  const beforeCon = (lineaExpandida.split(/\bcon\b/i)[0] || lineaExpandida).trim();
  const centenas = (beforeCon.match(/\b[0-9]{3}\b/g) || []).map(n => ex.normalizeNumToken(n)).filter(s => s && s.length === 3);
  const parleInfo = ex.extractParlePairs(lineaExpandida);
  const esPR = /\b\d{1,2}\s+pr\s+/i.test(lineaOriginal);
  const esPares = /\d{1,2}\s*[xX]\s*\d{1,2}/.test(lineaOriginal);
  const pares = (parleInfo && Array.isArray(parleInfo.pares)) ? parleInfo.pares : [];
  const parleMonto = (parleInfo && parleInfo.monto !== null) ? parleInfo.monto : null;
  let numerosBase = [];
  if (!centenas.length) {
    numerosBase = pares.length ? pares.flatMap(p => [pad2(p[0]), pad2(p[1])]) : ex.extractNumsBeforeKeywords(lineaExpandida).map(pad2);
  }
  const fijosDerivados = centenas.map(c => c.slice(-2));

  const db = { numerosBase, centenas, fijosDerivados, pares, esPR, esPares, parleMonto };
  trace('EVAL_BUILD_OPS', { stage: 'buildLineaDB', lineaOriginal, lineaExpandida, db });
  return db;
}

// ──────────────── VALIDACIÓN DE LÍNEA ─────────────────────────────────────────
function validarLinea(linea, lineaOriginal, db, lineaNum, collectedNums, ex) {
  trace('EVAL_VALIDATE', { stage: 'validarLinea:entrada', lineaNum, linea, lineaOriginal, collectedNums, db });

  const errors = [];

  // Eliminar modificadores 'parle con N' y 'candado con N' antes de contar los 'con'
  // de apuesta, para que no sean contados como un segundo 'con' independiente.
  let tmp = linea.replace(/\bparle\s+con\s+[\d.,]+/gi, '');
  tmp = tmp.replace(/\bcandado\s+con\s+[\d.,]+/gi, '');
  const numCon = (tmp.match(/\bcon\b/gi) || []).length;
  if (numCon > 1) {
    const err = {
      code: 'E_MULTIPLE_CON',
      line: lineaNum,
      message: `Cada línea debe contener exactamente un "con" de apuesta. Esta línea tiene ${numCon}. Use líneas separadas.`,
    };
    trace('ERROR', { source: 'validarLinea', ...err });
    errors.push(err);
    return errors;
  }

  const { numerosBase, centenas, fijosDerivados, pares } = db;
  const tieneCandado = /\bcandado\b/i.test(linea);
  const tieneParle   = /\bparle\b/i.test(linea);

  const tokensClasificados = clasificarTokens(lineaOriginal);
  const structErrors = validarEstructuraTokens(tokensClasificados, lineaNum);
  if (structErrors.length) {
    structErrors.forEach(e => trace('ERROR', { source: 'validarLinea:struct', ...e }));
    return structErrors;
  }

  if (/\bcon\s+\d+(?:[.,]\d+)?\s+con\b/i.test(linea) && !tieneCandado && !tieneParle) {
    const err = { code: 'R010_CON_X_CON_Y', line: lineaNum, message: '"con X con Y" no válido. Use "con X y Y".' };
    trace('ERROR', { source: 'validarLinea', ...err });
    errors.push(err);
    return errors;
  }
  if (/\by\s+candado\b/i.test(linea)) {
    const err = { code: 'R010_Y_ANTES_CANDADO', line: lineaNum, message: '"y candado" no válido.' };
    trace('ERROR', { source: 'validarLinea', ...err });
    errors.push(err);
    return errors;
  }
  if (/\by\s+parle\b/i.test(linea)) {
    const err = { code: 'R010_Y_ANTES_PARLE', line: lineaNum, message: '"y parle" no válido.' };
    trace('ERROR', { source: 'validarLinea', ...err });
    errors.push(err);
    return errors;
  }

  // Strip "parle con N" / "candado con N" before checking corrido sin Y,
  // otherwise the monto inside the modifier is counted as a second bet amount.
  const lineaSinMod = linea
    .replace(/\bparle\s+con\s+[\d.,]+/gi, '')
    .replace(/\bcandado\s+con\s+[\d.,]+/gi, '');
  const afterConMatch = lineaSinMod.match(/\bcon\s+(.+)/i);
  if (afterConMatch) {
    const afterCon = afterConMatch[1];
    const montosRaw = afterCon.split(/\s+/);
    const montosNumericos = montosRaw.filter(t => /^\d+(?:[.,]\d+)?$/.test(t));
    const hasY = /\by\b/i.test(afterCon);
    if (montosNumericos.length > 1 && !hasY) {
      const err = { code: 'R004_CORRIDO_SIN_Y', line: lineaNum, message: 'Para múltiples montos se requiere la palabra "y". Use "con X y Y" para corrido.' };
      trace('ERROR', { source: 'validarLinea', ...err });
      errors.push(err);
      return errors;
    }
  }

  if (!centenas.length) {
    if (tieneCandado && numerosBase.length > 0 && numerosBase.length < 3) {
      const err = { code: 'R006_CANDADO_MIN3', line: lineaNum, message: `Candado necesita al menos 3 números (hay ${numerosBase.length}).` };
      trace('ERROR', { source: 'validarLinea', ...err });
      errors.push(err);
    }
    if (tieneParle && numerosBase.length > 0 && numerosBase.length < 2) {
      const err = { code: 'R005_PARLE_MIN2', line: lineaNum, message: `Parle necesita al menos 2 números (hay ${numerosBase.length}).` };
      trace('ERROR', { source: 'validarLinea', ...err });
      errors.push(err);
    }
  }

  if (centenas.length) {
    if (tieneParle && fijosDerivados.length < 2) {
      const err = { code: 'R008_PARLE_CENTENA_MIN2', line: lineaNum, message: `Parle sobre centenas requiere al menos 2 fijos derivados (hay ${fijosDerivados.length}).` };
      trace('ERROR', { source: 'validarLinea', ...err });
      errors.push(err);
    }
    if (tieneCandado && fijosDerivados.length < 3) {
      const err = { code: 'R009_CANDADO_CENTENA_MIN3', line: lineaNum, message: `Candado sobre centenas requiere al menos 3 fijos derivados (hay ${fijosDerivados.length}).` };
      trace('ERROR', { source: 'validarLinea', ...err });
      errors.push(err);
    }
  }

  if (pares.length) {
    const anteCon = linea.split(/\b(?:con|de|a)\b/i)[0].trim();
    const todosTokens = ex.extractNumsFromSegment(anteCon);
    const digitosCub = new Set(pares.flatMap(p => [pad2(p[0]), pad2(p[1])]));
    const sueltos = todosTokens.filter(t => String(t).length === 2 && !digitosCub.has(pad2(t)));
    if (sueltos.length) {
      const err = { code: 'R010_MEZCLA_SUELTOS_PARES', line: lineaNum, message: `Mezcla inválida: números sueltos y pares parle.` };
      trace('ERROR', { source: 'validarLinea', ...err });
      errors.push(err);
    }
  }

  if (errors.length) {
    trace('EVAL_VALIDATE', { stage: 'validarLinea:resultado', lineaNum, errores: errors });
  } else {
    trace('EVAL_VALIDATE', { stage: 'validarLinea:resultado', lineaNum, resultado: 'OK' });
  }
  return errors;
}

// ──────────────── EXTRACCIÓN DE MONTOS ──────────────────────────────────────
function _montoParle(linea, lm) {
  const m = linea.match(/\bparle\b(?:\s*[:=]|\s*)(?:con\s*)?(\d+(?:[.,]\d+)?)/i);
  return m ? lm(m[1]) : null;
}
function _montoCandado(linea, lm) {
  let m = linea.match(/\bcandado\b(?:\s*con\s*)?(\d+(?:[.,]\d+)?)/i);
  if (!m) m = linea.match(/\bcandado\s+(\d+(?:[.,]\d+)?)/i);
  return m ? lm(m[1]) : null;
}

function _montosFijoCorrido(linea, ex, lm) {
  const corte = linea.search(/\b(parle|candado)\b/i);
  const segmento = corte !== -1 ? linea.slice(0, corte) : linea;
  const montos = ex.extractMontosAfterCon(segmento);
  const tieneY = /\by\b/i.test(segmento);
  if (!tieneY && montos.length > 1) {
    return { v1: montos[0] ?? null, v2: null };
  }
  return { v1: montos[0] ?? null, v2: montos[1] ?? null };
}

function buildOpsNormal(linea, db, ex, lm) {
  const ops = [];
  const nums = db.numerosBase;
  const pares = db.pares;
  const montoParle = _montoParle(linea, lm);
  const montoCandado = _montoCandado(linea, lm);
  const { v1, v2 } = _montosFijoCorrido(linea, ex, lm);
  const montoParleEfectivo = montoParle ?? (pares.length ? db.parleMonto : null);

  if (pares.length && montoParleEfectivo !== null) {
    const numsExp = pares.flatMap(p => [pad2(p[0]), pad2(p[1])]);
    // FIX: solo emitir fijo/corrido si hay keyword parle explícita.
    // Pares NxN implícitos (ej: "41x40 26x27 con 50"): el "con X" ES el monto del parle,
    // no un monto fijo adicional. Emitirlo como fijo duplicaría el cobro.
    const tieneParleExplicito = /\bparle\b/i.test(linea) || /\bp\s*\d/.test(linea);
    if (tieneParleExplicito) {
      if (v1 !== null) ops.push({ tipo: 'fijo', numeros: numsExp.slice(), montoUnitario: v1 });
      if (v2 !== null) ops.push({ tipo: 'corrido', numeros: numsExp.slice(), montoUnitario: v2 });
    }
    ops.push({ tipo: 'parle', numeros: numsExp.slice(), pares: pares.slice(), montoUnitario: montoParleEfectivo });
    trace('EVAL_BUILD_OPS', { stage: 'buildOpsNormal:pares+parle', linea, ops });
    return ops;
  }

  if (pares.length) {
    const numsExp = pares.flatMap(p => [pad2(p[0]), pad2(p[1])]);
    if (v1 !== null) ops.push({ tipo: 'fijo', numeros: numsExp.slice(), montoUnitario: v1 });
    if (v2 !== null) ops.push({ tipo: 'corrido', numeros: numsExp.slice(), montoUnitario: v2 });
    trace('EVAL_BUILD_OPS', { stage: 'buildOpsNormal:pares', linea, ops });
    return ops;
  }

  if (v1 !== null && nums.length) ops.push({ tipo: 'fijo', numeros: nums.slice(), montoUnitario: v1 });
  if (v2 !== null && nums.length) ops.push({ tipo: 'corrido', numeros: nums.slice(), montoUnitario: v2 });

  // Candado local con ajuste exacto
  if (montoCandado !== null && nums.length) {
    const numComb = comb2(nums.length);
    const { unit, real, diff } = repartirExacto(montoCandado, numComb);
    trace('EVAL_CANDADO_AJUSTE', { original: montoCandado, real, diff, unit, numComb });
    ops.push({
      tipo: 'candado',
      numeros: nums.slice(),
      pares: generarPares(nums),
      montoUnitario: unit,        // unitario por combinación (real / n)
      totalReal: real,            // total efectivo de la apuesta
      diff: diff,                 // diferencia con el total original
      totalOriginal: montoCandado
    });
  }

  // Parle local sin ajuste (el total es múltiplo del número de combinaciones porque se especifica unitario)
  if (montoParle !== null && nums.length) {
    ops.push({ tipo: 'parle', numeros: nums.slice(), pares: generarPares(nums), montoUnitario: montoParle });
  }

  trace('EVAL_BUILD_OPS', { stage: 'buildOpsNormal', linea, ops });
  return ops;
}

function buildOpsCentena(linea, db, ex, lm) {
  const ops = [];
  const { centenas, fijosDerivados } = db;
  const corte = linea.search(/\b(parle|candado)\b/i);
  const segBase = corte !== -1 ? linea.slice(0, corte) : linea;
  const montos = ex.extractMontosAfterCon(segBase);
  const tieneY = /\by\b/i.test(segBase);
  let m1 = montos[0] ?? null;
  let m2 = null;
  let m3 = null;
  if (tieneY && montos.length >= 2) {
    m2 = montos[1] ?? null;
    if (montos.length >= 3) m3 = montos[2] ?? null;
  } else if (!tieneY && montos.length > 1) {
    m1 = montos[0];
  }
  if (m1 !== null) ops.push({ tipo: 'centena', numeros: centenas.slice(), montoUnitario: m1 });
  if (m2 !== null) ops.push({ tipo: 'fijo', numeros: fijosDerivados.slice(), montoUnitario: m2 });
  if (m3 !== null) ops.push({ tipo: 'corrido', numeros: fijosDerivados.slice(), montoUnitario: m3 });

  const mp = _montoParle(linea, lm);
  if (mp !== null) ops.push({ tipo: 'parle', numeros: fijosDerivados.slice(), pares: generarPares(fijosDerivados), montoUnitario: mp });

  const mc = _montoCandado(linea, lm);
  if (mc !== null) {
    const numComb = comb2(fijosDerivados.length);
    const { unit, real, diff } = repartirExacto(mc, numComb);
    trace('EVAL_CANDADO_AJUSTE_CENTENA', { original: mc, real, diff, unit, numComb });
    ops.push({
      tipo: 'candado',
      numeros: fijosDerivados.slice(),
      pares: generarPares(fijosDerivados),
      montoUnitario: unit,
      totalReal: real,
      diff: diff,
      totalOriginal: mc
    });
  }

  trace('EVAL_BUILD_OPS', { stage: 'buildOpsCentena', linea, centenas, fijosDerivados, ops });
  return ops;
}

function buildOpsParleGlobal(linea, collectedNums, lm) {
  trace('EVAL_BUILD_OPS', { stage: 'buildOpsParleGlobal:entrada', linea, collectedNums });

  const m = linea.match(/^\s*parle\b(?:\s*[:=]?\s*|\s*con\s*)(\d+(?:[.,]\d+)?)/i);
  if (!m) {
    trace('EVAL_BUILD_OPS', { stage: 'buildOpsParleGlobal:sin monto', linea });
    return [];
  }
  const nums = collectedNums.map(pad2);
  const op = { tipo: 'parle_global', numeros: nums.slice(), pares: generarPares(nums), montoUnitario: lm(m[1]) };
  trace('EVAL_BUILD_OPS', { stage: 'buildOpsParleGlobal:op generado', op });
  return [op];
}

function buildOpsCandadoGlobal(linea, collectedNums, lm) {
  trace('EVAL_BUILD_OPS', { stage: 'buildOpsCandadoGlobal:entrada', linea, collectedNums });

  const m = linea.match(/^\s*candado\b(?:\s*[:=]?\s*|\s*con\s*)(\d+(?:[.,]\d+)?)/i);
  if (!m) {
    trace('EVAL_BUILD_OPS', { stage: 'buildOpsCandadoGlobal:sin monto', linea });
    return [];
  }
  const nums = collectedNums.map(pad2);
  const numComb = comb2(nums.length);
  const { unit, real, diff } = repartirExacto(lm(m[1]), numComb);
  const op = {
    tipo: 'candado_global',
    numeros: nums.slice(),
    pares: generarPares(nums),
    montoUnitario: unit,
    totalReal: real,
    diff: diff,
    totalOriginal: lm(m[1])
  };
  trace('EVAL_BUILD_OPS', { stage: 'buildOpsCandadoGlobal:op generado', op });
  return [op];
}

// ──────────────── CENTENA GLOBAL ─────────────────────────────────────────────
/**
 * Genera ops de centena para cada jugada base del bloque.
 *
 * @param {string} spec           - 'ALL' o dígito '0'..'9'
 * @param {Array}  jugadasBase    - Array de { numeros: string[], montoUnitario: number, tipo: string }
 *                                  Cada elemento representa una línea fijo/corrido original.
 * @returns {Array} ops centena_global listas para evaluarOperacion()
 */
/**
 * @param {string} spec         - 'ALL' o '0'..'9'
 * @param {Array}  jugadasBase  - jugadas fijo/corrido del bloque
 * @param {number|null} montoGlobal - monto explícito de la instrucción (null = usar monto base)
 */
function buildOpsCentenaGlobal(spec, jugadasBase, montoGlobal = null) {
  trace('EVAL_BUILD_OPS', { stage: 'buildOpsCentenaGlobal:entrada', spec, montoGlobal, jugadasBase });

  const ops = [];
  const centenas = spec === 'ALL'
    ? ['0','1','2','3','4','5','6','7','8','9']
    : spec.split(',').map(s => s.trim()).filter(s => /^[0-9]$/.test(s));

  for (const jugada of jugadasBase) {
    // Solo números de 2 dígitos (los de 3 ya tienen centena explícita)
    const nums2 = jugada.numeros.filter(n => String(n).replace(/^0+/, '').length <= 2 || String(n).length === 2);
    if (!nums2.length) continue;

    const monto = montoGlobal !== null ? montoGlobal : jugada.montoUnitario;

    for (const c of centenas) {
      const numerosConCentena = nums2.map(n => c + String(n).padStart(2, '0'));
      ops.push({
        tipo: 'centena_global',
        centena: c,
        numeros: numerosConCentena,
        montoUnitario: monto,
        origenNumeros: nums2.slice(),
        origenTipo: jugada.tipo,
      });
    }
  }

  trace('EVAL_BUILD_OPS', { stage: 'buildOpsCentenaGlobal:resultado', ops });
  return ops;
}

// ──────────────── EVALUADOR ──────────────────────────────────────────────
function evaluarOperacion(op) {
  trace('EVAL_OPERATION', { stage: 'evaluarOperacion:entrada', op });

  const n = op.numeros.length;
  const cantPares = op.pares ? op.pares.length : comb2(n);
  const mu = op.montoUnitario ?? 0;
  let monto = 0;
  switch (op.tipo) {
    case 'fijo':
    case 'corrido':
    case 'centena':
    case 'centena_global':
      monto = n * mu;
      break;
    case 'parle':
    case 'parle_global':
      monto = cantPares * mu;
      break;
    case 'candado':
    case 'candado_global':
      // Usar totalReal (efectivo) si está definido, si no, mantener mu (compatibilidad)
      monto = op.totalReal !== undefined ? op.totalReal : mu;
      break;
    default:
      monto = 0;
  }
  let combinaciones = '';
  if (op.pares && op.pares.length) {
    combinaciones = op.pares.map(p => pad2(p[0]) + pad2(p[1])).join(',');
  } else if (['parle', 'parle_global', 'candado', 'candado_global'].includes(op.tipo)) {
    combinaciones = generarPares(op.numeros).map(p => p[0] + p[1]).join(',');
  }
  const montoUnitarioDisplay = (['candado', 'candado_global'].includes(op.tipo) && cantPares > 0)
    ? mu
    : mu;
  const resultado = {
    tipo: op.tipo,
    numeros: op.numeros.map(['centena','centena_global'].includes(op.tipo) ? pad3 : pad2),
    pares: op.pares || null,
    combinaciones,
    monto,
    monto_unitario: montoUnitarioDisplay,
    centena: op.centena,          // solo centena_global
    origenNumeros: op.origenNumeros,
    origenTipo: op.origenTipo,
    // Propiedades opcionales para mostrar ajuste
    totalOriginal: op.totalOriginal,
    totalReal: op.totalReal,
    diff: op.diff,
  };

  trace('EVAL_RESULT', { stage: 'evaluarOperacion:resultado', resultado });
  return resultado;
}

function detalleLineaTexto(resultado) {
  const n = resultado.numeros.length;
  const cPares = resultado.pares ? resultado.pares.length : comb2(n);
  switch (resultado.tipo) {
    case 'fijo':
      return `Fijos: ${resultado.numeros.join(', ')} × (${resultado.monto_unitario.toFixed(2)}) = ${resultado.monto.toFixed(2)}\n`;
    case 'corrido':
      return `Corridos: ${n} × (${resultado.monto_unitario.toFixed(2)}) = ${resultado.monto.toFixed(2)}\n`;
    case 'centena':
      return `CENTENA: ${resultado.numeros.join(', ')} (${n} nums)\n  Centena: ${n} × (${resultado.monto_unitario.toFixed(2)}) = ${resultado.monto.toFixed(2)}\n`;
    case 'centena_global':
      return `Centena: ${resultado.numeros.join(', ')} (${n} nums) × (${resultado.monto_unitario.toFixed(2)}) = ${resultado.monto.toFixed(2)}
`;
    case 'parle':
    case 'parle_global':
      return `Parle: ${resultado.numeros.join(', ')} (${n} nums)\n  ${cPares} comb. × (${resultado.monto_unitario.toFixed(2)}) = ${resultado.monto.toFixed(2)}\n`;
    case 'candado':
    case 'candado_global': {
      let texto = `Parle: ${resultado.numeros.join(', ')} (${n} nums)\n  ${cPares} × (${resultado.monto_unitario.toFixed(2)}) = ${resultado.monto.toFixed(2)}`;
      if (resultado.diff && resultado.diff > 0) {
        texto += ` (apuesta ajustada de ${resultado.totalOriginal.toFixed(2)} a ${resultado.totalReal.toFixed(2)}, ahorro ${resultado.diff.toFixed(2)})`;
      }
      return texto + '\n';
    }
    default:
      return '';
  }
}

// ═══════════════════════════════════════════════════
// MODULE: betAuditLedger.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/betAuditLedger.js
 *
 * RULE: NO_BET_LOSS_GUARANTEE
 *
 * Ledger centralizado que garantiza que toda línea candidata a jugada
 * termina en uno de tres estados: ACCEPTED · RECOVERED · FLAGGED.
 *
 * Nunca puede quedar en estado implícito "desaparecida".
 *
 * ── ESTADOS ─────────────────────────────────────────────────────────
 *
 *   ACCEPTED  – parseada correctamente, convertida a estructura interna.
 *   RECOVERED – tenía ruido/errores menores; limpiada sin ambigüedad.
 *   FLAGGED   – incompleta, huérfana, ambigua o destruida por limpieza.
 *               Requiere revisión humana.
 *
 * ── REGLA DE AUDITORÍA ───────────────────────────────────────────────
 *
 *   processed_lines + flagged_lines = candidate_lines_detected
 *
 *   Si cualquier candidato falta → CRITICAL_ERROR "Posible pérdida de jugada"
 *
 * ──────────────────────────────────────────────────────────────────
 * TRACING: Importa trace() de tracer.js. PROHIBIDO usar console.log directo.
 * ──────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// DETECCIÓN DE CANDIDATOS
// Una línea es "candidata" si contiene dígitos O una keyword de apuesta.
// ─────────────────────────────────────────────────────────────────────────────

const BET_KEYWORD_RE = /\b(con|parle|candado|de|a)\b/i;

/**
 * Determina si una línea raw es candidata a jugada.
 * Criterio: contiene dígitos O keyword de apuesta.
 *
 * @param {string} line
 * @returns {boolean}
 */
function esLineaCandidato(line) {
  if (typeof line !== 'string' || line.trim() === '') return false;
  return /\d/.test(line) || BET_KEYWORD_RE.test(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFINICIÓN DEL LEDGER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'ACCEPTED'|'RECOVERED'|'FLAGGED'|'WARNING_AMBIGUOUS'|'PENDING_REVIEW'|'ATTACHED_TO_PREVIOUS'} BetStatus
 */

/**
 * @typedef {Object} BetEntry
 * @property {number}    lineIndex  - Índice original en el rawInput (0-based)
 * @property {string}    raw        - Texto original sin ningún procesamiento
 * @property {string}    cleaned    - Texto tras normalización (vacío si fue descartada)
 * @property {BetStatus} status     - Estado final de la línea
 * @property {string}    reason     - Motivo del estado (descripción legible)
 * @property {'warning'|'error'} severity - Gravedad (solo relevante para FLAGGED)
 * @property {string}    action     - Acción recomendada
 * @property {string|null} code     - Código de error estructurado (opcional)
 */

/**
 * Crea un nuevo ledger vacío.
 * Se debe crear uno por llamada a `preprocesarJugada` para evitar contaminación
 * entre peticiones concurrentes.
 *
 * @returns {BetAuditLedger}
 */
function createBetAuditLedger() {
  /** @type {BetEntry[]} */
  const entries = [];

  /** @type {number} */
  let candidateCount = 0;

  // ── REGISTRO ───────────────────────────────────────────────────────────────

  /**
   * Registra una línea candidata cuando se detecta por primera vez.
   * Debe llamarse ANTES de procesarLineaRaw para que el ledger la conozca.
   *
   * @param {number} lineIndex
   * @param {string} raw
   */
  function registerCandidate(lineIndex, raw) {
    candidateCount++;
    trace('AUDIT_LEDGER', { stage: 'registerCandidate', lineIndex, raw, candidateCount });
  }

  /**
   * Registra una línea como ACCEPTED (procesada y válida).
   *
   * @param {number} lineIndex
   * @param {string} raw
   * @param {string} cleaned
   * @param {string} [reason]
   */
  function accept(lineIndex, raw, cleaned, reason = 'Jugada procesada correctamente.') {
    const entry = {
      lineIndex,
      raw,
      cleaned,
      status: 'ACCEPTED',
      reason,
      severity: null,
      action: null,
      code: null,
    };
    entries.push(entry);
    trace('AUDIT_LEDGER', { stage: 'accept', lineIndex, raw, cleaned });
  }

  /**
   * Registra una línea como RECOVERED (normalizada con éxito tras limpiar ruido).
   *
   * @param {number} lineIndex
   * @param {string} raw
   * @param {string} cleaned
   * @param {string} reason
   */
  function recover(lineIndex, raw, cleaned, reason) {
    const entry = {
      lineIndex,
      raw,
      cleaned,
      status: 'RECOVERED',
      reason,
      severity: 'warning',
      action: 'Verificar que la intención original fue conservada.',
      code: null,
    };
    entries.push(entry);
    trace('AUDIT_LEDGER', { stage: 'recover', lineIndex, raw, cleaned, reason });
  }

  /**
   * Registra una línea como FLAGGED (incompleta, huérfana, inválida o ambigua).
   *
   * @param {number}              lineIndex
   * @param {string}              raw
   * @param {string}              cleaned     - Texto limpio (puede ser vacío)
   * @param {string}              reason
   * @param {'warning'|'error'}   [severity]
   * @param {string|null}         [code]
   */
  function flag(lineIndex, raw, cleaned, reason, severity = 'error', code = null) {
    const entry = {
      lineIndex,
      raw,
      cleaned,
      status: 'FLAGGED',
      reason,
      severity,
      action: 'Revisar con comercial',
      code,
    };
    entries.push(entry);
    trace('AUDIT_LEDGER', { stage: 'flag', lineIndex, raw, cleaned, reason, severity, code });
  }

  // ── CONSULTA ───────────────────────────────────────────────────────────────

  /** @returns {BetEntry[]} */
  function getEntries()  { return entries.slice(); }

  /** @returns {BetEntry[]} */
  function getFlagged()  { return entries.filter(e => e.status === 'FLAGGED'); }

  /** @returns {BetEntry[]} */
  function getAccepted() { return entries.filter(e => e.status === 'ACCEPTED'); }

  /** @returns {BetEntry[]} */
  function getRecovered(){ return entries.filter(e => e.status === 'RECOVERED'); }

  // ── AUDITORÍA FINAL ────────────────────────────────────────────────────────

  /**
   * Verifica la invariante:
   *   processed_lines + flagged_lines = candidate_lines_detected
   *
   * @returns {{
   *   ok:              boolean,
   *   candidateCount:  number,
   *   acceptedCount:   number,
   *   recoveredCount:  number,
   *   flaggedCount:    number,
   *   processedCount:  number,
   *   missingCount:    number,
   *   criticalError:   string | null,
   *   flaggedEntries:  BetEntry[],
   * }}
   */
  function audit() {
    const accepted  = entries.filter(e => e.status === 'ACCEPTED').length;
    const recovered = entries.filter(e => e.status === 'RECOVERED').length;
    const flagged   = entries.filter(e => e.status === 'FLAGGED').length;
    const processed = accepted + recovered;
    const total     = processed + flagged;
    const missing   = candidateCount - total;
    const ok        = missing === 0;

    const result = {
      ok,
      candidateCount,
      acceptedCount:  accepted,
      recoveredCount: recovered,
      flaggedCount:   flagged,
      processedCount: processed,
      missingCount:   missing,
      criticalError:  ok ? null : `Posible pérdida de jugada: ${missing} candidato(s) sin estado registrado.`,
      flaggedEntries: entries.filter(e => e.status === 'FLAGGED'),
    };

    trace('AUDIT_LEDGER', { stage: 'audit', result });

    if (!ok) {
      trace('ERROR', {
        code:    'AUDIT_MISSING_CANDIDATES',
        message: result.criticalError,
        missing,
        candidateCount,
        total,
      });
    }

    return result;
  }

  // ── API PÚBLICA ────────────────────────────────────────────────────────────

  return {
    registerCandidate,
    accept,
    recover,
    flag,
    getEntries,
    getFlagged,
    getAccepted,
    getRecovered,
    audit,
    /** Número total de candidatos detectados (para depuración). */
    get candidateCount() { return candidateCount; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE CLASIFICACIÓN DE FLAGGED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detecta si una línea limpia es "huérfana" (tiene estructura parcial de jugada
 * pero no cierra un patrón completo válido).
 *
 * Condiciones de orfandad:
 *   - Números sin monto (sin "con" / "de" / "a")
 *   - Monto sin números propios y sin contexto acumulado
 *   - "parle" o "candado" sin monto
 *   - "con/de/a" sin valor numérico a continuación
 *   - Tokens que sugieren apuesta pero no cierran patrón
 *
 * @param {string} cleaned  - Texto ya normalizado/limpio
 * @returns {{ isOrphan: boolean, reason: string | null }}
 */
function detectarLineaHuerfana(cleaned) {
  if (!cleaned || typeof cleaned !== 'string') {
    return { isOrphan: false, reason: null };
  }

  const t = cleaned.trim().toLowerCase();

  // Parle/candado sin monto
  if (/\bparle\b/.test(t) && !/\bparle\s+(?:con\s+)?\d/.test(t)) {
    return { isOrphan: true, reason: 'Parle sin monto' };
  }
  if (/\bcandado\b/.test(t) && !/\bcandado\s+(?:con\s+)?\d/.test(t)) {
    return { isOrphan: true, reason: 'Candado sin monto' };
  }

  // "con/de/a" al final sin número después
  if (/\b(con|de|a)\s*$/.test(t)) {
    return { isOrphan: true, reason: 'Conector sin monto al final de línea' };
  }

  // "con/de/a" seguido de algo que no es número
  if (/\b(con|de|a)\s+(?!\d)/.test(t) && !/\b(con|de|a)\s+\d/.test(t)) {
    return { isOrphan: true, reason: 'Falta primer monto válido después de conector' };
  }

  // Números solos sin conector ni monto (puede ser válido como acumulación de contexto,
  // pero si contiene keyword de apuesta sin estructura completa → huérfano)
  if (/\b(con|de|a|parle|candado)\b/.test(t)) {
    // Tiene keyword pero no cierra patrón básico de monto
    if (!/\b(con|de|a)\s+\d/.test(t) && !/\b(parle|candado)\s+(?:con\s+)?\d/.test(t)) {
      return { isOrphan: true, reason: 'Keyword de apuesta sin estructura numérica completa' };
    }
  }

  return { isOrphan: false, reason: null };
}

/**
 * Determina la razón de flagging para una línea que contiene dígitos pero
 * fue descartada por el preprocesador (razón original pasada como parámetro).
 *
 * Mapea razones internas del preprocesador a mensajes legibles para auditoría.
 *
 * @param {string} razonInterna  - Valor del campo `razon` en PRE_FILTERED
 * @param {string} raw           - Línea original
 * @param {string} cleaned       - Línea limpia (puede ser vacía)
 * @returns {{ reason: string, severity: 'warning'|'error', code: string }}
 */
function mapearRazonFlag(razonInterna, raw, cleaned) {
  if (!razonInterna) {
    return { reason: 'Descartada por razón desconocida.', severity: 'error', code: 'UNKNOWN_DISCARD' };
  }

  const r = razonInterna.toLowerCase();

  if (r.includes('ruido')) {
    return { reason: 'Línea de ruido: contiene dígitos pero no estructura de jugada reconocible.', severity: 'warning', code: 'NOISE_WITH_DIGITS' };
  }
  if (r.includes('encabezado')) {
    return { reason: 'Parece encabezado de lotería/sorteo (texto + número suelto). Si es una jugada, agregar "con <monto>".', severity: 'warning', code: 'HEADER_DISCARDED' };
  }
  if (r.includes('right_side_rule') || r.includes('right_empty') || r.includes('right_no_match')) {
    const orphan = detectarLineaHuerfana(cleaned || raw);
    return {
      reason: orphan.isOrphan ? orphan.reason : `Lado derecho inválido tras limpieza: "${cleaned || raw}"`,
      severity: 'error',
      code: 'RIGHT_SIDE_INVALID',
    };
  }
  if (r.includes('ponme')) {
    return { reason: 'Instrucción operativa descartada ("ponme"). No es una jugada.', severity: 'warning', code: 'OP_INSTRUCTION' };
  }
  if (r.includes('parejas sin')) {
    return { reason: 'Parejas sin monto. Escriba "parejas con <monto>".', severity: 'error', code: 'R_PAREJAS_SIN_CON' };
  }

  // Fallback genérico
  return { reason: `Descartada: ${razonInterna}`, severity: 'error', code: 'GENERIC_DISCARD' };
}

// ═══════════════════════════════════════════════════
// MODULE: rightSideSanitizer.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/rightSideSanitizer.js
 *
 * RULE: RIGHT_SIDE_ALLOWED_PATTERNS
 *
 * Sanitiza y valida el lado derecho de una línea DSL
 * (todo lo que va desde la primera keyword "con" / "parle" / "candado" en adelante).
 *
 * Sólo sobreviven los tokens y estructuras definidos en la regla:
 *
 *   BASE NUMERIC GROUP  :  uno o más números separados por espacio
 *   CONNECTORS_ALLOWED  :  con | de | a
 *   JOINER_ALLOWED      :  y
 *   MODIFIERS_ALLOWED   :  p | parle | c | candado
 *
 * Patrones válidos finales (en orden de precedencia):
 *   1. RANGE WITH CONNECTOR  →  <nums> <connector> <monto>  [y <monto2>]
 *   2. PARLE                 →  <nums> p<monto>  |  <nums> parle <monto>
 *   3. CANDADO               →  <nums> c<monto>  |  <nums> candado <monto>
 *   4. COMBINED              →  RANGE_PATTERN + <modifier>
 *
 * Errores posibles:
 *   { ok: false, code: 'RIGHT_EMPTY',      message }  → lado derecho vacío tras limpieza
 *   { ok: false, code: 'RIGHT_NO_MATCH',   message }  → no encaja con ningún patrón
 *
 * ──────────────────────────────────────────────────────────────────
 * TRACING: Importa trace() de tracer.js. PROHIBIDO usar console.log directo.
 * ──────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// TOKENS PERMITIDOS EN EL LADO DERECHO
// ─────────────────────────────────────────────────────────────────────────────

/** Palabras clave permitidas en el lado derecho (exactas, minúsculas). */
const RIGHT_KEYWORDS = new Set(['con', 'de', 'a', 'y', 'parle', 'candado', 'p', 'c']);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — LIMPIAR TOKENS INVÁLIDOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Elimina del lado derecho todo lo que no sean:
 *   - dígitos  (0-9)
 *   - espacios
 *   - keywords permitidas (con / de / a / y / p / parle / c / candado)
 *
 * Símbolos, puntuación y palabras desconocidas se descartan.
 * Espacios múltiples se colapsan a uno.
 *
 * @param {string} ladoDerecho  - Fragmento desde la primera keyword de monto en adelante.
 * @returns {string}            - Texto limpio.
 */
function limpiarLadoDerecho(ladoDerecho) {
  if (typeof ladoDerecho !== 'string') return '';

  const original = ladoDerecho;

  // 1. Separar tokens (whitespace split).
  const tokens = ladoDerecho.trim().split(/\s+/).filter(Boolean);

  // 2. Filtrar: mantener dígitos puros o keywords.
  const limpios = tokens.filter(tok => {
    if (/^\d+([.,]\d+)?$/.test(tok)) return true;          // número (entero o decimal)
    if (RIGHT_KEYWORDS.has(tok.toLowerCase())) return true; // keyword exacta
    if (/^\d+[xX*]\d+$/.test(tok)) return true;            // par implícito NxN / N*N
    // Descartar todo lo demás: letras desconocidas, símbolos, tokens mixtos.
    return false;
  });

  const resultado = limpios.join(' ');

  trace('RIGHT_SIDE_SANITIZER', {
    stage: 'limpiarLadoDerecho',
    input: original,
    output: resultado,
    descartados: tokens.filter(t => !limpios.includes(t)),
  });

  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — RECONSTRUIR ESPACIOS
// ─────────────────────────────────────────────────────────────────────────────

/** Colapsa múltiples espacios a uno y recorta. */
function normalizeSpaces(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — VALIDAR PATRÓN FINAL
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Gramática (en expresiones regulares, aplicadas sobre el texto limpio):
 *
 *  NUM   = \d+([.,]\d+)?
 *  NUMS  = NUM(\s+NUM)*
 *  CONN  = con|de|a
 *  MOD   = (p|parle)\s+NUM | (c|candado)\s+NUM
 *
 *  RANGE_CON = NUMS \s+ CONN \s+ NUM (\s+ y \s+ NUM)?
 *  PARLE_PAT = NUMS \s+ (p|parle) \s+ NUM
 *  CAND_PAT  = NUMS \s+ (c|candado) \s+ NUM
 *  COMBINED  = RANGE_CON \s+ MOD
 *
 * Nota: "NUMS" aquí es el grupo base de números ANTES del conector/modificador.
 * En el lado derecho que recibimos, ese grupo puede ser vacío si la keyword
 * ya abre la secuencia (ej: "con 10 y 20 p5" donde los números de sujeto
 * vienen del lado izquierdo). El validador acepta ambas variantes.
 */

// Fragmento regex reutilizable
const _N  = '\\d+(?:[.,]\\d+)?';          // un número (entero o decimal)
const _NS = `(?:${_N})(?:\\s+(?:${_N}))*`; // uno o más números
const _CONN = '(?:con|de|a)';
// After the preprocessor runs, canonical forms are "parle con N" and "candado con N".
// The optional "con" group handles both raw ("parle 5") and post-preprocessor ("parle con 5").
const _MOD_P = `(?:p|parle)(?:\\s+con)?\\s+${_N}`;
const _MOD_C = `(?:c|candado)(?:\\s+con)?\\s+${_N}`;

// Patrones completos (anclan inicio y fin)
// Pair notation NxN / N*N
const _PAIR = '\\d+[xX*]\\d+';
// Chain item: plain number OR pair (for y-chains that mix both)
const _ITEM = `(?:${_PAIR}|${_N})`;

const PATTERNS = [
  // 4. COMBINED: <nums?> <conn> <monto> [y <monto> ...] <modifier>
  new RegExp(
    `^(?:${_NS}\\s+)?${_CONN}\\s+${_N}(?:\\s+y\\s+${_N})*\\s+(?:${_MOD_P}|${_MOD_C})$`,
    'i'
  ),
  // 1. RANGE WITH CONNECTOR: <nums?> <conn> N (y ITEM)* [conn N]
  //    Handles: "con 40 y 10 y 54x24 con 100" — y-chain may contain NxN pairs
  new RegExp(
    `^(?:${_NS}\\s+)?${_CONN}\\s+${_N}(?:\\s+y\\s+${_ITEM})*(?:\\s+${_CONN}\\s+${_N})?$`,
    'i'
  ),
  // 2. PARLE: <nums?> (p|parle) [con] <monto>
  new RegExp(
    `^(?:${_NS}\\s+)?(?:p|parle)(?:\\s+con)?\\s+${_N}$`,
    'i'
  ),
  // 3. CANDADO: <nums?> (c|candado) [con] <monto>
  new RegExp(
    `^(?:${_NS}\\s+)?(?:c|candado)(?:\\s+con)?\\s+${_N}$`,
    'i'
  ),
  // 5. STANDALONE PAIR: NxN con M
  new RegExp(
    `^(?:${_NS}\\s+)?${_PAIR}\\s+${_CONN}\\s+${_N}$`,
    'i'
  ),
  // Sólo números base (grupo base sin monto — válido para acumulación de contexto)
  new RegExp(`^${_NS}$`),
];

/**
 * Valida que el texto limpio encaje con al menos uno de los patrones permitidos.
 *
 * @param {string} texto
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
function validarPatronLadoDerecho(texto) {
  const t = normalizeSpaces(texto);

  if (!t) {
    return {
      ok: false,
      code: 'RIGHT_EMPTY',
      message: 'Sin contenido válido en el lado derecho tras la limpieza.',
    };
  }

  for (const pat of PATTERNS) {
    if (pat.test(t)) {
      trace('RIGHT_SIDE_SANITIZER', { stage: 'validarPatron:match', texto: t, patron: pat.source });
      return { ok: true };
    }
  }

  trace('RIGHT_SIDE_SANITIZER', { stage: 'validarPatron:no-match', texto: t });
  return {
    ok: false,
    code: 'RIGHT_NO_MATCH',
    message: `Formato no permitido en lado derecho: "${t}"`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitiza y valida el lado derecho de una línea DSL.
 *
 * Pipeline:
 *   1. limpiarLadoDerecho  → elimina tokens inválidos
 *   2. normalizeSpaces     → colapsa espacios
 *   3. validarPatron       → verifica gramática final
 *
 * @param {string} ladoDerecho
 * @returns {{
 *   ok:      boolean,
 *   clean:   string,            // texto limpio (vacío si hubo error)
 *   code?:   string,            // código de error (si !ok)
 *   message?: string,           // descripción del error (si !ok)
 * }}
 */
function sanitizarLadoDerecho(ladoDerecho) {
  trace('RIGHT_SIDE_SANITIZER', { stage: 'sanitizarLadoDerecho:entrada', ladoDerecho });

  // Paso 1 & 2
  const cleaned = normalizeSpaces(limpiarLadoDerecho(ladoDerecho));

  // Paso 3
  const validation = validarPatronLadoDerecho(cleaned);

  const resultado = validation.ok
    ? { ok: true,  clean: cleaned }
    : { ok: false, clean: '',     code: validation.code, message: validation.message };

  trace('RIGHT_SIDE_SANITIZER', { stage: 'sanitizarLadoDerecho:resultado', ladoDerecho, resultado });
  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRACIÓN CON EL PREPROCESADOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aplica RIGHT_SIDE_ALLOWED_PATTERNS sobre una línea completa preprocesada.
 *
 * Divide la línea en lado izquierdo (hasta la primera keyword de monto / operador)
 * y lado derecho, sanitiza el lado derecho, y devuelve la línea reconstruida.
 *
 * Si el lado derecho resulta inválido, devuelve null para que el preprocesador
 * pueda emitir un error o descartar la línea.
 *
 * @param {string} linea  - Línea ya normalizada por procesarLineaRaw().
 * @returns {{ linea: string | null, error?: { code: string, message: string } }}
 */
function aplicarRightSideRule(linea) {
  if (typeof linea !== 'string' || !/\d/.test(linea)) {
    return { linea }; // sin dígitos → no aplica la regla
  }

  trace('RIGHT_SIDE_SANITIZER', { stage: 'aplicarRightSideRule:entrada', linea });

  // Encontrar la primera keyword de monto/operador
  const kwMatch = linea.match(/\b(con|parle|candado)\b/i);
  if (!kwMatch) {
    // Sin keyword: todo es lado izquierdo → la regla no aplica aquí.
    return { linea };
  }

  const splitIdx = kwMatch.index;
  const ladoIzq  = linea.slice(0, splitIdx);
  const ladoDer  = linea.slice(splitIdx); // incluye la keyword

  const result = sanitizarLadoDerecho(ladoDer);

  if (!result.ok) {
    trace('RIGHT_SIDE_SANITIZER', {
      stage: 'aplicarRightSideRule:error',
      linea, ladoDer, code: result.code, message: result.message,
    });
    return { linea: null, error: { code: result.code, message: result.message } };
  }

  const lineaReconstruida = (ladoIzq + result.clean).replace(/\s+/g, ' ').trim();
  trace('RIGHT_SIDE_SANITIZER', {
    stage: 'aplicarRightSideRule:ok',
    original: linea,
    reconstruida: lineaReconstruida,
  });

  return { linea: lineaReconstruida };
}

// ═══════════════════════════════════════════════════
// MODULE: classifier.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/classifier.js
 *
 * CAPA INTERMEDIA OBLIGATORIA entre preprocesador y engine.
 *
 * ──────────────────────────────────────────────────────────────────
 * TRACING: Importa trace() de tracer.js. PROHIBIDO usar console.log directo.
 * ──────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS DE OPERACIÓN
// ─────────────────────────────────────────────────────────────────────────────

const LineType = Object.freeze({
  OPERATION:  'OPERATION',
  SEPARATOR:  'SEPARATOR',   // BLANK_SEP / null / empty — resets accumulator context
  JOINED:     'JOINED',      // \x00JOINED\x00 — lines were artificially merged; do NOT reset
  IGNORE:     'IGNORE',
  INVALID:    'INVALID',
});

const OpKind = Object.freeze({
  NORMAL:          'NORMAL',
  CENTENA:         'CENTENA',
  PARLE_GLOBAL:    'PARLE_GLOBAL',
  CANDADO_GLOBAL:  'CANDADO_GLOBAL',
  PARLE_ACUM:      'PARLE_ACUM',    // par(es) NxN sin monto — acumular para monto posterior
  MONTO_SOLO:      'MONTO_SOLO',    // "con X" o "parle con X" sin números propios — aplica a acumulados
  CENTENA_GLOBAL:  'CENTENA_GLOBAL', // instrucción de centena global (t0..t9 o ALL)
});

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR DE SEPARADORES
// ─────────────────────────────────────────────────────────────────────────────

function esJoined(lineaRaw) {
  return lineaRaw === '\x00JOINED\x00';
}

function esSeparador(lineaRaw) {
  return (
    lineaRaw === '\x00BLANK_SEP\x00' ||
    lineaRaw === null ||
    lineaRaw === undefined ||
    String(lineaRaw).trim() === ''
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR DE RUIDO
// ─────────────────────────────────────────────────────────────────────────────

function esRuido(lineaTrim) {
  return !/\d/.test(lineaTrim);
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECCIÓN DE KIND
// ─────────────────────────────────────────────────────────────────────────────

function detectarOpKind(lineaExp, db) {
  const trimmed = lineaExp.trim().toLowerCase();

  trace('CLASSIFIER_OPKIND', {
    stage: 'detectarOpKind:entrada',
    lineaExp: trimmed,
    numerosBase: db.numerosBase,
    centenas: db.centenas,
    pares: db.pares,
  });

  // FIX: "parle NxN con X" — explicit pair with amount — must NOT be PARLE_GLOBAL.
  // PARLE_GLOBAL consumes accumulated context; explicit pairs are self-contained.
  // Detect: line starts with "parle" AND db has pares AND there is a monto → NORMAL.
  const esParleExplicito = /^parle\b/i.test(trimmed) &&
                           db.pares.length > 0 &&
                           /\bcon\s+\d/.test(trimmed);
  if (esParleExplicito) {
    trace('CLASSIFIER_OPKIND', { resultado: 'NORMAL', razon: 'parle con pares explícitos NxN — no depende de acumulados' });
    return OpKind.NORMAL;
  }

  // PARLE_GLOBAL / CANDADO_GLOBAL deben chequearse ANTES que MONTO_SOLO.
  // "parle con X" coincide con ambos patrones — PARLE_GLOBAL debe ganar.
  const tieneParleGlobal = /^parle\b.*\bcon\s+\d/.test(trimmed) ||
                           /^parle\s+\d/.test(trimmed);
  if (/^parle\b/.test(trimmed) && tieneParleGlobal) {
    trace('CLASSIFIER_OPKIND', { resultado: 'PARLE_GLOBAL', razon: 'línea empieza con "parle" y tiene monto' });
    return OpKind.PARLE_GLOBAL;
  }

  const tieneCandadoGlobal = /^candado\b.*\bcon\s+\d/.test(trimmed) ||
                             /^candado\s+\d/.test(trimmed);
  if (/^candado\b/.test(trimmed) && tieneCandadoGlobal) {
    trace('CLASSIFIER_OPKIND', { resultado: 'CANDADO_GLOBAL', razon: 'línea empieza con "candado" y tiene monto' });
    return OpKind.CANDADO_GLOBAL;
  }

  // MONTO_SOLO: solo "con X" sin números propios.
  // Líneas que empiezan con "parle" o "candado" ya fueron manejadas arriba.
  const esMontoSolo = /^con\s+[\d.]+/.test(trimmed) && db.numerosBase.length === 0 && db.pares.length === 0;
  if (esMontoSolo) {
    trace('CLASSIFIER_OPKIND', { resultado: 'MONTO_SOLO', razon: 'solo monto sin números propios' });
    return OpKind.MONTO_SOLO;
  }

  // PARLE_ACUM: línea que contiene solo pares NxN sin monto — acumular para monto posterior.
  const esSoloPares = db.pares.length > 0 && db.numerosBase.length === 0 && !/\bcon\b/.test(trimmed);
  if (esSoloPares) {
    trace('CLASSIFIER_OPKIND', { resultado: 'PARLE_ACUM', razon: 'pares NxN sin monto → acumular' });
    return OpKind.PARLE_ACUM;
  }

  if (db.centenas.length > 0) {
    trace('CLASSIFIER_OPKIND', { resultado: 'CENTENA', razon: `centenas detectadas: ${db.centenas.join(', ')}` });
    return OpKind.CENTENA;
  }

  trace('CLASSIFIER_OPKIND', { resultado: 'NORMAL', razon: 'ninguna condición especial detectada' });
  return OpKind.NORMAL;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASIFICAR UNA LÍNEA
// ─────────────────────────────────────────────────────────────────────────────

function clasificarLinea(lineaRaw, lineNum, ex, buildDB) {
  const id = nextId();
  trace('CLASSIFIER_INPUT', { id, lineNum, lineaRaw });

  // ── CENTENA GLOBAL (token de control emitido por preprocesador) ─────────
  if (typeof lineaRaw === 'string' && lineaRaw.startsWith('\x00CENTENA_GLOBAL\x00')) {
    const spec = lineaRaw.slice('\x00CENTENA_GLOBAL\x00'.length).replace(/\x00$/, '');
    trace('CLASSIFIER_TYPE', { id, lineNum, type: LineType.OPERATION, opKind: OpKind.CENTENA_GLOBAL, spec });
    return {
      type:     LineType.OPERATION,
      opKind:   OpKind.CENTENA_GLOBAL,
      lineaExp: spec,       // 'ALL' o '0'..'9'
      lineaOrig: lineaRaw,
      db:       null,
      lineNum,
    };
  }

  // ── JOINED (líneas fusionadas — NO resetear contexto) ────────────────────
  if (esJoined(lineaRaw)) {
    trace('CLASSIFIER_TYPE', { id, lineNum, type: LineType.JOINED, lineaRaw });
    return {
      type:     LineType.JOINED,
      opKind:   null,
      lineaExp: '',
      lineaOrig: '\x00JOINED\x00',
      db:       null,
      lineNum,
    };
  }

  // ── SEPARADORES ──────────────────────────────────────────────────────────
  if (esSeparador(lineaRaw)) {
    trace('CLASSIFIER_TYPE', { id, lineNum, type: LineType.SEPARATOR, lineaRaw });
    return {
      type:     LineType.SEPARATOR,
      opKind:   null,
      lineaExp: '',
      lineaOrig: String(lineaRaw ?? ''),
      db:       null,
      lineNum,
    };
  }

  const lineaTrim = String(lineaRaw).trim();

  // ── RUIDO (sin dígitos) ───────────────────────────────────────────────────
  if (esRuido(lineaTrim)) {
    trace('CLASSIFIER_TYPE', { id, lineNum, type: LineType.IGNORE, lineaTrim, razon: 'sin dígitos' });
    return {
      type:     LineType.IGNORE,
      opKind:   null,
      lineaExp: lineaTrim,
      lineaOrig: lineaTrim,
      db:       null,
      lineNum,
    };
  }

  // ── EXPANSIÓN ─────────────────────────────────────────────────────────────
  let lineaExp = ex.expandirTodasLasCentenas(lineaTrim);
  lineaExp     = ex.expandirPorLaCentena(lineaExp);
  lineaExp     = ex.expandirVolteoNumeros(lineaExp);
  lineaExp     = ex.expandirPatronPR(lineaExp);
  lineaExp     = ex.expandirRangos(lineaExp);

  if (lineaExp !== lineaTrim) {
    trace('CLASSIFIER_INPUT', { id, lineNum, stage: 'post-expansión', lineaTrim, lineaExp });
  }

  // ── BUILD DB ─────────────────────────────────────────────────────────────
  const db = buildDB(lineaTrim, lineaExp, ex);
  trace('CLASSIFIER_DB', { id, lineNum, db });

  // ── DETECTAR KIND ─────────────────────────────────────────────────────────
  const opKind = detectarOpKind(lineaExp, db);

  // ── VALIDACIÓN ESTRUCTURAL FINAL ─────────────────────────────────────────
  let isValidOperation = false;
  if (opKind === OpKind.PARLE_GLOBAL || opKind === OpKind.CANDADO_GLOBAL) {
    isValidOperation = true;
  } else if (opKind === OpKind.MONTO_SOLO) {
    isValidOperation = true;
  } else if (opKind === OpKind.PARLE_ACUM && db.pares.length > 0) {
    isValidOperation = true;
  } else if (opKind === OpKind.CENTENA && db.centenas.length > 0) {
    isValidOperation = true;
  } else if (opKind === OpKind.NORMAL && (db.numerosBase.length > 0 || db.pares.length > 0)) {
    isValidOperation = true;
  }

  if (!isValidOperation) {
    trace('CLASSIFIER_TYPE', {
      id,
      lineNum,
      type: LineType.INVALID,
      opKind,
      razon: 'estructura no válida (no hay números/pares/centenas que soporten el opKind)',
      lineaExp,
      db,
    });
    return {
      type:      LineType.INVALID,
      opKind:    null,
      lineaExp,
      lineaOrig: lineaTrim,
      db:        null,
      lineNum,
    };
  }

  trace('CLASSIFIER_TYPE', { id, lineNum, type: LineType.OPERATION, opKind, lineaExp });
  return {
    type:     LineType.OPERATION,
    opKind,
    lineaExp,
    lineaOrig: lineaTrim,
    db,
    lineNum,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASIFICAR TODAS LAS LÍNEAS DE UN BLOQUE
// ─────────────────────────────────────────────────────────────────────────────

function clasificarBloque(jugadaLines, lineOffset, ex, buildDB) {
  trace('CLASSIFIER_INPUT', {
    stage: 'clasificarBloque:inicio',
    totalLineas: jugadaLines.length,
    lineOffset,
    jugadaLines,
  });

  const tokens = jugadaLines.map((lineaRaw, idx) =>
    clasificarLinea(lineaRaw, lineOffset + idx + 1, ex, buildDB)
  );

  trace('CLASSIFIER_INPUT', {
    stage: 'clasificarBloque:fin',
    resumen: tokens.map(t => ({ type: t.type, opKind: t.opKind, lineNum: t.lineNum, lineaExp: t.lineaExp })),
  });

  return tokens;
}

// ═══════════════════════════════════════════════════
// MODULE: parser.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/parser.js
 *
 * DETECCIÓN DE BLOQUES POR CONTEXTO ESTRUCTURAL
 * - Un nombre de bloque es la última línea sin dígitos antes de la primera jugada.
 * - No se analiza el contenido (puede contener emojis, puntuación, etc.).
 * - Simplemente se excluyen palabras reservadas del DSL (`con`, `parle`, `candado`, etc.).
 *
 * ──────────────────────────────────────────────────────────────────
 * TRACING: Importa trace() de tracer.js.
 * ──────────────────────────────────────────────────────────────────
 */

const TYPO_PATTERNS = [
  { pattern: /\b(c[aá]b[dn]a?d[ao]o?|cand[ao]{2}|candago|cabdado|cnadado|candao|candao|canado|cadnado|cnadao|canddo)\b/gi, keyword: 'candado' },
  { pattern: /\b(parlee+|pr[ae]le?t?|pal?ret?)\b/gi, keyword: 'parle' },
];

// Palabras reservadas del DSL que NUNCA pueden ser nombre de bloque
const DSL_KEYWORDS = new Set([
  'con', 'y', 'parle', 'candado', 'total', 'centena', 'centenas',
  'pareja', 'parejas', 'p', 'c', 'd', 't', 'v', 'decena', 'terminal',
  'fijo', 'corrido', 'volteo', 'bote', 'tarjeta', 'rango',
  'ponme', 'nota', 'obs', 'observacion', 'ref', 'referencia',
  'flo', 'parlet', 'candao'
]);

/**
 * Calcula un puntaje contextual para determinar si una línea es nombre de bloque.
 *
 * Puntos positivos:
 *   +4  si tiene 1 palabra
 *   +2  si tiene 2 palabras
 *   +1  si tiene 3 palabras
 *   +2  si contiene solo letras y espacios (sin puntuación ni símbolos extra)
 *   +2  si la primera letra es mayúscula (línea original)
 *   +2  si está rodeada por líneas vacías (anterior y siguiente)
 *   +3  si la siguiente línea no-vacía contiene dígitos (jugada inmediata)
 *
 * Penalizaciones:
 *   -6  si contiene verbos de acción comunes (pago, dame, ponme, manda, juega,
 *       cobra, envio, pongo, quiero)
 *   -4  si contiene conectores / preposiciones (por, para, con, de, y, tambien)
 *   -5  si tiene más de 3 palabras
 *   -6  si parece frase conversacional (signo de interrogación / exclamación,
 *       "favor", "necesito", "puedes", "quieres", "gracias", "hola", "ok",
 *       "si", "no", "sí")
 *
 * Requisitos previos (veto inmediato, score irrelevante):
 *   - La línea no puede contener dígitos.
 *   - La línea no puede ser exactamente una palabra reservada DSL.
 *
 * @param {string}   line      - Línea a evaluar (preprocesada; el preprocesador la preserva verbatim si no tiene dígitos).
 * @param {number}   index     - Índice de esta línea dentro de rawLines.
 * @param {string[]} rawLines  - Array completo de líneas del input (preprocesadas).
 * @returns {{ score: number, esNombre: boolean }}
 */
function scoreNombreBloque(line, index, rawLines) {
  const SCORE_THRESHOLD = 5;

  if (!line || typeof line !== 'string') return { score: -Infinity, esNombre: false };
  const trimmed = line.trim();
  if (trimmed === '') return { score: -Infinity, esNombre: false };
  if (/\d/.test(trimmed)) return { score: -Infinity, esNombre: false };
  const lower = trimmed.toLowerCase();
  if (DSL_KEYWORDS.has(lower)) return { score: -Infinity, esNombre: false };

  // Tokenizar por espacios sobre texto stripeado (emojis y puntuación no cuentan como palabras)
  // Nota: `stripped` se calcula más abajo, pero lo necesitamos aquí para el conteo.
  // Lo calculamos de forma anticipada y reutilizamos más adelante.
  const _stripped = trimmed.replace(/[\p{Emoji}\p{P}\p{S}\p{Mn}\p{Cf}\uFE0F\uFE0E]/gu, '').trim();
  // Veto post-strip: si tras quitar puntuación/emojis el texto es una sola palabra reservada DSL,
  // rechazar (cubre casos como "Fijo:", "Corrido:", "Parle:" que el veto previo no captura).
  if (DSL_KEYWORDS.has(_stripped.toLowerCase())) return { score: -Infinity, esNombre: false };
  const words = _stripped.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  let score = 0;

  // ── Puntos positivos ──────────────────────────────────────────────────────

  // Longitud en palabras
  if (wordCount === 1) score += 4;
  else if (wordCount === 2) score += 2;
  else if (wordCount === 3) score += 1;

  // Solo letras (Unicode) y espacios — se usan las palabras stripeadas calculadas arriba
  if (_stripped.length > 0 && /^[\p{L}\s]+$/u.test(_stripped)) score += 2;

  // Primera letra mayúscula — se evalúa sobre el texto stripeado (ignorando emoji inicial)
  if (_stripped.length > 0 && /^\p{Lu}/u.test(_stripped)) score += 2;

  // Rodeada por líneas vacías (anterior Y siguiente)
  const prevEmpty = index === 0 || (rawLines[index - 1] ?? '').trim() === '';
  const nextEmpty = index >= rawLines.length - 1 || (rawLines[index + 1] ?? '').trim() === '';
  if (prevEmpty && nextEmpty) score += 2;

  // Siguiente línea no-vacía contiene dígitos (jugada inmediata)
  for (let k = index + 1; k < rawLines.length; k++) {
    const nextTrim = (rawLines[k] ?? '').trim();
    if (nextTrim === '') continue;
    if (/\d/.test(nextTrim)) score += 3;
    break; // solo la primera no-vacía importa
  }

  // ── Penalizaciones ────────────────────────────────────────────────────────

  // Verbos de acción comunes
  if (/\b(pago|dame|ponme|manda|juega|cobra|env[íi]o|pongo|quiero)\b/i.test(lower)) score -= 6;

  // Conectores / preposiciones
  if (/\b(por|para|con|de|y|tambi[eé]n)\b/i.test(lower)) score -= 4;

  // Más de 3 palabras
  if (wordCount > 3) score -= 5;

  // Frase conversacional
  const conversacional =
    /[¿?¡!]/.test(trimmed) ||
    /\b(favor|necesito|puedes|quieres|gracias|hola|ok|s[íi]|no)\b/i.test(lower);
  if (conversacional) score -= 6;

  return { score, esNombre: score >= SCORE_THRESHOLD };
}

/**
 * Mantiene compatibilidad con el resto del código que llama esNombreBloque(line).
 * Delega en scoreNombreBloque sin contexto de rawLines (index=0, rawLines=[]).
 */
function esNombreBloque(line) {
  return scoreNombreBloque(line, 0, []).esNombre;
}

function isLineTotal(line) {
  const t = (line || '').trim();
  return /^\s*total\s*[:\-=.\s]?\s*[\d.]/i.test(t) || /^\s*total\s*$/i.test(t);
}

/**
 * Une líneas que son solo números o pares NxN en una sola.
 */
function joinNumberLines(rawLines) {
  let i = 0;
  const joined = [];
  while (i < rawLines.length) {
    const linea = rawLines[i];
    const trim = (linea || '').trim();
    const esSoloNums = trim !== '' &&
      /^\d[\d\s.,]*$/.test(trim) &&
      !/\b(con|parle|candado|total|centena|rango)\b/i.test(trim);
    const esSoloPares = trim !== '' &&
      /^[\dx\s]+$/i.test(trim) && /\d[xX]\d/.test(trim) &&
      !/\b(con|parle|candado|total|centena|rango)\b/i.test(trim);
    if (esSoloNums || esSoloPares) {
      let j = i + 1;
      let acum = trim;
      while (j < rawLines.length) {
        const nextTrim = (rawLines[j] || '').trim();
        if (!nextTrim) { j++; continue; }
        const nextSoloNums = /^\d[\d\s.,]*$/.test(nextTrim) &&
          !/\b(con|parle|candado|total|centena|rango)\b/i.test(nextTrim);
        const nextSoloPares = /^[\dx\s]+$/i.test(nextTrim) && /\d[xX]\d/.test(nextTrim) &&
          !/\b(con|parle|candado|total|centena|rango)\b/i.test(nextTrim);
        if ((esSoloNums && nextSoloNums) || (esSoloPares && nextSoloPares)) {
          acum += ' ' + nextTrim;
          j++;
          continue;
        }
        if (/\bcon\b/i.test(nextTrim)) {
          // Look ahead: if the line after "con X" is a candado/parle global, absorb it
          // so it stays in the same logical line and can consume the accumulated numbers.
          let combinedLine = acum + ' ' + nextTrim;
          let consumedUpTo = j + 1;
          const afterConIdx = j + 1;
          if (afterConIdx < rawLines.length) {
            const afterConTrim = (rawLines[afterConIdx] || '').trim();
            if (/^\s*(candado|parle[t]?)\s+con\b/i.test(afterConTrim)) {
              combinedLine = combinedLine + ' ' + afterConTrim;
              consumedUpTo = afterConIdx + 1;
            }
          }
          for (let k = i; k < j; k++) joined.push('\x00JOINED\x00');
          joined.push(combinedLine);
          i = consumedUpTo;
          acum = null;
        }
        break;
      }
      if (acum !== null) { joined.push(linea); i++; }
    } else {
      joined.push(linea);
      i++;
    }
  }
  return joined;
}

function parsearBloques(rawLinesPreprocesadas, rawLinesOriginales, limpiarMonto) {
  // rawLinesOriginales se conserva como parámetro para compatibilidad con llamadores existentes,
  // pero ya no se usa internamente: el preprocesador preserva las líneas sin dígitos verbatim,
  // por lo que preprocLine ES la línea original para fines de nombre y scoring.
  // Eliminar el lookup posicional evita desalineaciones cuando el preprocesador
  // inserta o elimina líneas (p.ej. expansión de terminales, unión de números).

  const bloques = [];
  let currentBlock = null;      // { nombre, lines, totalDeclarado, lineOffset }
  let pendingName = null;       // última línea sin dígitos vista fuera de bloque
  let pendingOffset = 0;
  let pendingMeta = [];         // metadatos (lotería, alias) asociados al pendingName actual

  function cerrarBloque() {
    if (currentBlock && currentBlock.lines.length > 0) {
      bloques.push({
        nombre: currentBlock.nombre ?? '⚠️ SIN NOMBRE',
        jugadaLines: currentBlock.lines,
        totalDeclarado: currentBlock.totalDeclarado ?? null,
        lineOffset: currentBlock.lineOffset,
        sinNombre: !currentBlock.nombre,
        meta: currentBlock.meta ?? [],   // líneas de contexto (lotería, alias) antes de la jugada
      });
      trace('PARSER_BLOCK_END', {
        nombre: currentBlock.nombre ?? '⚠️ SIN NOMBRE',
        totalLineas: currentBlock.lines.length,
        totalDeclarado: currentBlock.totalDeclarado,
        lineOffset: currentBlock.lineOffset,
      });
    }
    currentBlock = null;
    pendingMeta = [];
  }

  for (let i = 0; i < rawLinesPreprocesadas.length; i++) {
    const preprocLine = rawLinesPreprocesadas[i];
    const trimmedPre = preprocLine.trim();

    // El preprocesador preserva las líneas sin dígitos verbatim → usamos preprocLine directamente.
    const hasDigit = /\d/.test(trimmedPre);
    const originalLine = preprocLine;
    const trimmedOrig = trimmedPre;

    trace('PARSER_LINE', { index: i, preprocLine, trimmedPre });

    // 1. Línea vacía → ya NO cierra ni delimita bloques.
    //    Si hay un bloque abierto, se inserta como separador interno (\x00BLANK_SEP\x00)
    //    para que el engine/classifier pueda resetear acumuladores donde corresponda.
    //    Si no hay bloque abierto, se ignora.
    if (trimmedPre === '' || trimmedOrig === '') {
      if (currentBlock) {
        currentBlock.lines.push('\x00BLANK_SEP\x00');
        trace('PARSER_SEPARATOR', { index: i, reason: 'línea vacía dentro de bloque → separador interno' });
      } else {
        trace('PARSER_SEPARATOR', { index: i, reason: 'línea vacía fuera de bloque → ignorada' });
      }
      continue;
    }

    // 2. Línea "total" → cierra bloque actual con total declarado.
    if (isLineTotal(trimmedOrig)) {
      const mt = trimmedOrig.match(/^\s*total\b[:\s]*([0-9.,]+)/i);
      const totalVal = mt ? limpiarMonto(mt[1]) : null;
      if (currentBlock) {
        currentBlock.totalDeclarado = totalVal;
        cerrarBloque();
      }
      pendingName = null;
      pendingMeta = [];
      trace('PARSER_LINE', { index: i, tipo: 'TOTAL', valor: totalVal });
      continue;
    }

    // 3. Línea con dígitos (jugada)
    if (hasDigit) {
      if (!currentBlock) {
        // Iniciamos bloque con el primer candidato capturado (pendingName).
        // pendingMeta contiene líneas de contexto subsiguientes (lotería, alias, etc.)
        // que llegaron después del nombre pero antes de la primera jugada.
        const nombre = pendingName;
        const offset = (nombre !== null) ? pendingOffset : i;
        currentBlock = {
          nombre: nombre,
          lines: [],
          totalDeclarado: null,
          lineOffset: offset,
          meta: pendingMeta.slice(),  // lotería / alias detectados antes de la jugada
        };
        trace('PARSER_BLOCK_START', {
          nombre: currentBlock.nombre ?? '⚠️ SIN NOMBRE',
          sinNombre: !currentBlock.nombre,
          lineOffset: offset,
          primeraLinea: trimmedPre,
          meta: currentBlock.meta,
        });
        pendingName = null;  // nombre usado, limpiamos
        pendingMeta = [];
      }
      // ── NO_BET_LOSS: parser-level ATTACHED_TO_PREVIOUS safety net ──────────
      // Si el preprocesador crasheó y envió una línea cruda como "Y 20 corrido"
      // (texto de ruido + un solo número sin con), intentar fusionarla con la
      // línea anterior del bloque para no perder el monto.
      //
      // Condición: línea con UN solo número, todos los tokens no-numéricos son
      // palabras de ruido DSL (corrido, fijo, y, etc.), sin keyword con/parle/candado.
      {
        const _ruidoParserSet = new Set([
          'fijo','corrido','parle','parlet','candado','candao','total','centena',
          'y','al','de','a','con','p','c','t','d','v','flo','tarjeta','rango',
          'bote','pareja','parejas','terminal','decena','cent','volteo',
        ]);
        const _sinCon = !/\bcon\b/i.test(trimmedPre);
        const _tieneTexto = /[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]{2,}/.test(trimmedPre);
        const _mNumP = trimmedPre.match(/^[^\d]*(\d+(?:[.,]\d+)?)[^\d]*$/);
        const _soloUnNum = !!_mNumP;
        if (_sinCon && _tieneTexto && _soloUnNum && currentBlock.lines.length > 0) {
          const _tok = trimmedPre.replace(/\d+(?:[.,]\d+)?/g, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
          const _todosRuido = _tok.length > 0 && _tok.every(t => _ruidoParserSet.has(t));
          if (_todosRuido) {
            const _numStr = _mNumP[1];
            // Find last real jugada line (skip separators/joined tokens)
            let _prevIdx = currentBlock.lines.length - 1;
            while (_prevIdx >= 0 &&
                   (currentBlock.lines[_prevIdx] === '\x00BLANK_SEP\x00' ||
                    currentBlock.lines[_prevIdx] === '\x00JOINED\x00')) {
              _prevIdx--;
            }
            if (_prevIdx >= 0) {
              const _prevLine = currentBlock.lines[_prevIdx];
              const _prevHasCon = /\bcon\s+\d/i.test(_prevLine);
              const _prevNoY   = !/\by\s+\d/i.test(_prevLine);
              if (_prevHasCon && _prevNoY) {
                const _fused = _prevLine + ' y ' + _numStr;
                currentBlock.lines[_prevIdx] = _fused;
                trace('PARSER_ADD_LINE', {
                  index: i,
                  line: _fused,
                  totalLineasBloque: currentBlock.lines.length,
                  action: 'ATTACHED_TO_PREVIOUS',
                  originalLine: preprocLine,
                  attachedNum: _numStr,
                  prevLine: _prevLine,
                });
                continue;
              }
            }
          }
        }
      }

      currentBlock.lines.push(preprocLine);
      trace('PARSER_ADD_LINE', { index: i, line: preprocLine, totalLineasBloque: currentBlock.lines.length });
      continue;
    }

    // 4. Línea sin dígitos (texto, comentario, posible nombre)
    if (!hasDigit) {
      const { score, esNombre } = scoreNombreBloque(originalLine, i, rawLinesPreprocesadas);
      if (esNombre && !currentBlock) {
        if (pendingName === null) {
          // Primer candidato: registrar como nombre del próximo bloque.
          pendingName   = originalLine;
          pendingOffset = i;
          pendingMeta   = [];
          trace('PARSER_CANDIDATE_NAME', { index: i, candidato: pendingName, score, esNombre, aceptado: true, razon: 'primer candidato' });
        } else {
          // ── PRIORIDAD CONTEXTUAL ──────────────────────────────────────────
          // Ya hay un nombre activo (pendingName). Un segundo candidato-nombre
          // NO debe reemplazarlo. Reglas en orden de prioridad:
          //
          //   1. Si la línea es una sola palabra sin dígitos Y parece alias de
          //      lotería o metadata de contexto → guardar en pendingMeta y emitir
          //      warning. El bloque se abrirá con el nombre original intacto.
          //
          //   2. En cualquier otro caso → conservar pendingName anterior y tratar
          //      esta línea como metadata. Nunca silenciar el nombre ya capturado.
          //
          // Esto cubre:
          //   "Belkys\nGeorgia\n07 08 con 5"  → jugador=Belkys, meta=["Georgia"]
          //   "Yoha\npareja Georgia\n..."      → jugador=Yoha, meta=["pareja Georgia"]
          //   "DanielR Giorgia\n..."           → pendingName="DanielR Giorgia" (una sola
          //                                       línea de 2 palabras, score=7, ya era
          //                                       el primer candidato completo — Giorgia
          //                                       solo aparece aquí como línea separada si
          //                                       DanielR y Giorgia están en líneas distintas)
          pendingMeta.push(originalLine);
          trace('PARSER_CANDIDATE_NAME', {
            index: i,
            candidato: originalLine,
            score,
            esNombre,
            aceptado: false,
            razon: `pendingName ya establecido ("${pendingName}") → línea tratada como metadata del bloque; se conserva nombre original`,
            pendingMeta,
          });
        }
      } else {
        // Dentro de bloque con score suficiente → verificar si hay BLANK_SEP previo.
        // Si es así, el usuario separó con línea en blanco → cerrar bloque actual
        // y tratar esta línea como nombre del siguiente bloque.
        if (currentBlock && esNombre) {
          const lastLine = currentBlock.lines[currentBlock.lines.length - 1];
          if (lastLine === '\x00BLANK_SEP\x00') {
            // Quitar el BLANK_SEP del bloque (era separador entre bloques, no interno)
            currentBlock.lines.pop();
            cerrarBloque();
            pendingName   = originalLine;
            pendingOffset = i;
            pendingMeta   = [];
            trace('PARSER_CANDIDATE_NAME', { index: i, candidato: pendingName, score, esNombre, aceptado: true,
              razon: 'nombre tras BLANK_SEP dentro de bloque → cierra bloque anterior y abre pendingName nuevo' });
            continue;
          }
        }
        // Dentro de bloque sin BLANK_SEP previo: comentario normal.
        // Fuera de bloque pero score insuficiente: también ignorar.
        trace('PARSER_CANDIDATE_NAME', { index: i, candidato: originalLine, score, esNombre, aceptado: false,
          reason: currentBlock ? 'dentro de bloque → comentario' : 'fuera de bloque → score insuficiente' });
      }
      continue;
    }
  }

  // Cerrar bloque si quedó abierto
  cerrarBloque();

  // Limpieza: eliminar separadores consecutivos dentro de cada bloque
  for (const bloque of bloques) {
    const nuevas = [];
    for (let i = 0; i < bloque.jugadaLines.length; i++) {
      const line = bloque.jugadaLines[i];
      if (line === '\x00BLANK_SEP\x00') {
        if (i === 0 || bloque.jugadaLines[i-1] !== '\x00BLANK_SEP\x00') nuevas.push(line);
      } else {
        nuevas.push(line);
      }
    }
    bloque.jugadaLines = nuevas;
  }

  return bloques.filter(b => b.jugadaLines.length > 0);
}

/**
 * Punto de entrada principal.
 */
function parsearInput(rawInput, deps) {
  const { limpiarMonto, preprocesarJugada } = deps;

  const rawLinesOriginal = rawInput.replace(/\r/g, '').split('\n');

  let procesado = rawInput;
  let auditResult = null;

  if (typeof preprocesarJugada === 'function') {
    try {
      const r = preprocesarJugada.length === 0 ? preprocesarJugada() : preprocesarJugada(rawInput);

      // Handle new { result, audit, ledger } shape (NO_BET_LOSS_GUARANTEE)
      if (r && typeof r === 'object' && typeof r.result === 'string') {
        if (r.result.trim()) procesado = r.result;
        auditResult = r.audit ?? null;
        trace('PARSER_LINE', { stage: 'audit-recibido', audit: auditResult });
      } else if (typeof r === 'string' && r.trim()) {
        // Legacy shape: plain string (backwards compat with old preprocesarJugada)
        procesado = r;
      }
    } catch (e) {
      // CRITICAL: preprocesarJugada lanzó una excepción.
      // procesado ya quedó en rawInput (el fallback por defecto).
      // Emitir trace detallado y registrar como error de parseo para que
      // el engine/UI lo superficen — nunca silenciar.
      trace('ERROR', {
        source:  'parser.parsearInput',
        code:    'PREPROCESSOR_CRASH',
        error:   e.message,
        stack:   e.stack,
        message: 'preprocesarJugada() lanzó excepción. Las líneas se procesarán sin normalizar. ' +
                 'Esto puede provocar pérdida de apuestas. Revisar el preprocesador.',
      });
      // Forzar auditResult con error crítico para que el engine lo reporte
      auditResult = {
        ok: false,
        candidateCount: 0,
        acceptedCount: 0,
        recoveredCount: 0,
        flaggedCount: 0,
        processedCount: 0,
        missingCount: 0,
        criticalError: 'PREPROCESSOR_CRASH: ' + e.message,
        flaggedEntries: [],
      };
    }
  }

  const rawLinesPreprocesadas = procesado.replace(/\r/g, '').split('\n');

  trace('PARSER_LINE', {
    stage: 'inicio',
    totalLineasOriginales: rawLinesOriginal.length,
    totalLineasPreprocesadas: rawLinesPreprocesadas.length,
  });

  const bloques = parsearBloques(rawLinesPreprocesadas, rawLinesOriginal, limpiarMonto);

  // Unión de líneas numéricas (compatibilidad)
  bloques.forEach(b => { b.jugadaLines = joinNumberLines(b.jugadaLines); });

  trace('PARSER_LINE', {
    stage: 'fin',
    totalBloques: bloques.length,
    bloques: bloques.map(b => ({ nombre: b.nombre, lineas: b.jugadaLines.length })),
  });

  // ── NO_BET_LOSS_GUARANTEE: Surfacear entradas FLAGGED como errores parseables ──
  // Las entradas FLAGGED no interrumpen el parseo (el bloque sigue procesándose)
  // pero se exponen en el array de errores para que el engine/UI las muestre.
  const parseErrors = [];

  if (auditResult) {
    // CRITICAL: candidatos desaparecidos — error bloqueante
    if (!auditResult.ok) {
      trace('ERROR', {
        source: 'parser.parsearInput',
        code: 'AUDIT_MISSING_CANDIDATES',
        message: auditResult.criticalError,
        audit: auditResult,
      });
      parseErrors.push({
        code:    'AUDIT_MISSING_CANDIDATES',
        line:    0,
        message: auditResult.criticalError,
        severity: 'error',
      });
    }

    // Entradas FLAGGED → warnings/errors individuales por línea
    for (const entry of auditResult.flaggedEntries) {
      parseErrors.push({
        code:     entry.code || 'FLAGGED',
        line:     (entry.lineIndex ?? 0) + 1,   // 1-based para UI
        message:  entry.reason,
        raw:      entry.raw,
        cleaned:  entry.cleaned,
        severity: entry.severity,
        action:   entry.action,
        status:   'FLAGGED',
      });
      trace('PARSER_ORPHAN', { entry });
    }
  }

  return { errors: parseErrors, bloques, audit: auditResult };
}

// ═══════════════════════════════════════════════════
// MODULE: preprocesador.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/preprocesador.js
 *
 * LIMPIEZA DSL + DIVISIÓN ATÓMICA DE MÚLTIPLES "con" (N-001)
 * 
 * REGLA: Las líneas sin dígitos se preservan intactas.
 *        Las líneas con múltiples apuestas separadas por "con" se dividen automáticamente.
 *
 * FIX: Se garantiza que nunca se devuelve undefined. Todas las salidas son strings o arrays de strings.
 */

// ========================= DIVISIÓN DE MÚLTIPLES "con" (ROBUSTA) =========================
function dividirMultiplesCon(linea) {
  // Entrada siempre string
  if (typeof linea !== 'string') return '';
  const original = linea;
  trace('PRE_RAW', { stage: 'dividirMultiplesCon', input: linea });

  if (!/\d/.test(linea) || !/\bcon\b/i.test(linea)) {
    trace('PRE_SPLIT', { result: 'sin múltiples con → retorna igual', linea });
    return original;
  }

  const totalCon = (linea.match(/\bcon\b/gi) || []).length;
  if (totalCon < 2) return original;

  const tokens = linea.split(/\s+/);
  const n = tokens.length;

  // Clasificar cada "con": 'parle', 'candado' o 'apuesta'
  const conInfo = [];
  for (let i = 0; i < n; i++) {
    if (tokens[i]?.toLowerCase() !== 'con') continue;
    const prev = i > 0 ? tokens[i - 1].toLowerCase() : '';
    const tipo = (prev === 'parle') ? 'parle' : (prev === 'candado') ? 'candado' : 'apuesta';
    conInfo.push({ idx: i, tipo });
  }

  if (conInfo.length < 2) return original;

  const segmentos = [];
  for (let c = 0; c < conInfo.length; c++) {
    const { idx: conIdx, tipo } = conInfo[c];
    const sujetoStart = c === 0 ? 0 : segmentos[c - 1]._nextSubjectStart;
    const sujetoToks = tokens.slice(sujetoStart, conIdx);

    let montoEnd, nextSubjectStart;

    if (c + 1 < conInfo.length) {
      const next = conInfo[c + 1];
      if (next.tipo === 'parle' || next.tipo === 'candado') {
        const kw = next.idx - 1;
        montoEnd = kw;
        nextSubjectStart = kw;
      } else {
        let subjectStart = next.idx - 1;
        if (subjectStart > conIdx && tokens[subjectStart - 1]?.toLowerCase() === 'y') {
          subjectStart--;
        }
        if (subjectStart > conIdx + 1) {
          montoEnd = subjectStart;
          nextSubjectStart = tokens[subjectStart]?.toLowerCase() === 'y' ? subjectStart + 1 : subjectStart;
        } else {
          montoEnd = next.idx - 1 > conIdx ? next.idx - 1 : conIdx + 1;
          nextSubjectStart = next.idx - 1 > conIdx ? next.idx - 1 : conIdx + 1;
        }
      }
    } else {
      // Último segmento: buscar un "con" embebido dentro del monto potencial.
      // Ej: "parle con 1 34 con 50 10" → recortar en "34" (token antes del "con" embebido)
      // y guardar el resto como cola para emitirla como sublínea adicional.
      montoEnd = n;
      nextSubjectStart = n;
      for (let k = conIdx + 1; k < n; k++) {
        if (tokens[k]?.toLowerCase() === 'con') {
          montoEnd = k - 1; // token antes del "con" embebido pertenece al sujeto siguiente
          nextSubjectStart = k - 1;
          break;
        }
      }
    }

    const montoToks = tokens.slice(conIdx + 1, montoEnd);
    while (montoToks.length && montoToks[montoToks.length - 1].toLowerCase() === 'y') montoToks.pop();

    // Tokens sobrantes cuando se encontró un "con" embebido en el último segmento
    const colaToks = montoEnd < n ? tokens.slice(montoEnd) : [];

    segmentos.push({ sujetoToks, montoToks, tipo, _nextSubjectStart: nextSubjectStart, _colaToks: colaToks });
  }

  const nuevasLineas = [];
  for (let si = 0; si < segmentos.length; si++) {
    const seg = segmentos[si];
    const esUltimo = si === segmentos.length - 1;
    const tieneNumOp = seg.sujetoToks.some(t => /\d/.test(t) || /\b(parle|candado)\b/i.test(t));
    if (!tieneNumOp || seg.montoToks.length === 0) continue;

    const lineaSeg = (seg.sujetoToks.join(' ') + ' con ' + seg.montoToks.join(' '))
      .replace(/\s+/g, ' ').trim();

    // Si el sujeto de este segmento es SOLO "parle" o "candado" (sin números propios),
    // fusionarlo con la línea anterior en lugar de emitirlo como línea separada.
    // Ej: seg anterior="23 45 con 10 y 20", seg actual="parle con 1"
    //   → "23 45 con 10 y 20 parle con 1"
    const sujetoEsSoloOperador = seg.sujetoToks.length > 0 &&
      seg.sujetoToks.every(t => /^(parle|candado)$/i.test(t));

    if (sujetoEsSoloOperador && nuevasLineas.length > 0) {
      nuevasLineas[nuevasLineas.length - 1] =
        (nuevasLineas[nuevasLineas.length - 1] + ' ' + lineaSeg).replace(/\s+/g, ' ').trim();
      trace('PRE_SPLIT', {
        stage: 'dividirMultiplesCon:fusión operador suelto',
        lineaSeg,
        fusionado: nuevasLineas[nuevasLineas.length - 1],
      });
    } else {
      nuevasLineas.push(lineaSeg);
    }

    // La cola solo existe en el último segmento (cuando se encontró un "con" embebido
    // dentro del monto del último "con" de la línea). Procesarla como sublínea adicional.
    if (esUltimo && seg._colaToks && seg._colaToks.length > 0) {
      const colaStr = seg._colaToks.join(' ').trim();
      if (colaStr && /\bcon\b/i.test(colaStr)) {
        dividirMultiplesCon(colaStr)
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)
          .forEach(sub => nuevasLineas.push(sub));
      }
    }
  }

  const salida = nuevasLineas.length > 1 ? nuevasLineas.join('\n') : original;
  trace('PRE_SPLIT', {
    input: linea,
    lineasResultantes: salida.includes('\n') ? salida.split('\n') : [salida],
    dividido: nuevasLineas.length > 1,
  });
  return salida; // siempre string (puede contener saltos de línea)
}

// ========================= HELPERS (se mantienen) =========================
function limpiarLineaAuto(linea) {
  if (!linea || typeof linea !== 'string') return '';
  const tieneParleCandadoExplicito = /\b(parle[t]?|candado)\b/i.test(linea);
  const tieneParImplicito = /\d{1,2}\s*[xX*]\s*\d{1,2}/.test(linea);
  const esParle = tieneParleCandadoExplicito || tieneParImplicito;

  if (esParle) {
    let prevP = '';
    while (prevP !== linea) {
      prevP = linea;
      linea = linea.replace(/(\d+)\s*\*\s*(\d+)/g, '$1x$2');
    }
    linea = linea.replace(/(\d)p\s*(\d)/gi, '$1 p$2');
    linea = linea.replace(/((?:\d{1,2}[xX]){2,}\d{1,2})/g, m => m.split(/[xX]/).join(' '));
    linea = linea.replace(/(\d+[xX]\d+)\s*,\s*(?=\d+[xX])/g, '$1 ');
  
/*  
    if (tieneParleCandadoExplicito && /\bcandado\b/i.test(linea)) {
      let prevC = '';
      while (prevC !== linea) {
        prevC = linea;
        linea = linea.replace(/(\d{1,2})[xX](\d{1,2})/g, '$1 $2');
      }
    } */
    const PH = '\x01PUNTO\x01';
    linea = linea.replace(/\b(con|y|p|c|candado|parle|total)[ \t]+(\d+)[,.](\d+)/gi, (m, kw, a, b) => kw + ' ' + a + PH + b);
    linea = linea.replace(/,/g, ' ');
    linea = linea.split(PH).join('.');
    linea = linea.replace(/(\d+)\s*\/\s*(\d+)/g, '$1 $2');
    linea = linea.replace(/[()\\/{}'[\]|;:¡!¿?@#%&=+~^`"<>]/g, ' ');
  } else {
    const PH = '\x01PUNTO\x01';
    linea = linea.replace(/\b(con|y|p|c|candado|parle|total)[ \t]+(\d+)\.(\d+)/gi, (m, kw, a, b) => kw + ' ' + a + PH + b);
    linea = linea.replace(/\b(con|y|p|c|candado|parle|total)[ \t]+(\d+),(\d+)/gi, (m, kw, a, b) => kw + ' ' + a + PH + b);
    linea = linea.replace(/\b(con|y|p|c|candado|parle|total)[ \t]+\.(\d+)/gi, (m, kw, b) => kw + ' ' + b);
    linea = linea.replace(/(\d)\s*,\s*(\d)/g, '$1 $2');
    linea = linea.replace(/(\d)\.(\d)/g, '$1 $2');
    linea = linea.replace(/,/g, ' ');
    let prev = '';
    while (prev !== linea) {
      prev = linea;
      linea = linea.replace(/(\d+)\s*[*]\s*(\d+)/g, '$1x$2');
    }
    linea = linea.replace(/(\d+)\s*\/\s*(\d+)/g, '$1 $2');
    linea = linea.replace(/\s+-\s+/g, ' ');
    linea = linea.replace(/[()\\/{}'[\]|;:¡!¿?@#%&=+~^`"<>]/g, ' ');
    linea = linea.split(PH).join('.');
  }
  return linea.replace(/ +/g, ' ').trim();
}

function _expandirRangosLinea(l) {
  if (typeof l !== 'string') return '';
  return l.replace(/(\b\d+(?:\.\d+)?)[ \t]+al[ \t]+(\d+(?:\.\d+)?\b)/gi, (match, aStr, bStr) => {
    const aNum = parseFloat(aStr);
    const bNum = parseFloat(bStr);
    if (isNaN(aNum) || isNaN(bNum) || aNum > bNum) return match;
    const aHasDot = aStr.includes('.');
    const bHasDot = bStr.includes('.');
    if (aHasDot !== bHasDot) return match;
    if (aHasDot) {
      let start = Math.round(aNum * 100);
      let end   = Math.round(bNum * 100);
      start = Math.max(0, Math.min(99, start));
      end   = Math.max(0, Math.min(99, end));
      if (start > end) return match;
      const nums = [];
      for (let i = start; i <= end; i++) nums.push(String(i).padStart(2, '0'));
      return nums.join(' ');
    } else {
      const sn = Math.round(aNum);
      const fn = Math.round(bNum);
      if (sn > fn) return match;
      const nums = [];
      for (let i = sn; i <= fn; i++) nums.push(String(i).padStart(sn >= 100 ? 3 : 2, '0'));
      return nums.join(' ');
    }
  });
}

function _normalizarCandadoParle(l) {
  if (typeof l !== 'string') return '';
  l = l.replace(/candado([0-9.,]+)/ig, 'candado con $1');
  l = l.replace(/([0-9.,]+)candado/ig, 'candado con $1');
  l = l.replace(/candado[ \t]+(?!con[ \t])([0-9.,]+)/ig, 'candado con $1');
  l = l.replace(/parlet([0-9.,]+)/ig, 'parle con $1');
  l = l.replace(/([0-9.,]+)parlet/ig, 'parle con $1');
  l = l.replace(/parlét([0-9.,]+)/ig, 'parle con $1');
  l = l.replace(/([0-9.,]+)parlét/ig, 'parle con $1');
  l = l.replace(/parlét\b/ig, 'parle');
  l = l.replace(/parle([0-9.,]+)/ig, 'parle con $1');
  l = l.replace(/([0-9.,]+)parle(?!t)/ig, 'parle con $1');
  l = l.replace(/parletcon/ig, 'parle con');
  l = l.replace(/parlet[ \t]+con/ig, 'parle con');
  l = l.replace(/parlet[ \t]+([0-9.,]+)/ig, 'parle con $1');
  l = l.replace(/parlet/ig, 'parle');
  // FIX: do NOT insert 'con' when the line has explicit pairs (NxN / N*N).
  // "parle 41x88 con 10" must stay as-is; only "parle 10" gets 'con' inserted.
  if (!/\d\s*[xX*]\s*\d/.test(l)) {
    l = l.replace(/parle[ \t]+(?!con[ \t]|con$)([0-9.,]+)/ig, 'parle con $1');
  }
  l = l.replace(/([0-9.,]+)[ \t]+de[ \t]+parle/ig, 'candado con $1');
  l = l.replace(/([0-9.,]+)[ \t]+al[ \t]+(?:parle|candado)/ig, 'candado con $1');
  l = l.replace(/y[ \t]+([0-9.,]+)[ \t]+parle(?!\s*con)/ig, 'candado con $1');
  l = l.replace(/\bfijo\b/ig, '');
  if (/\bcon\b/i.test(l)) {
    const pi = l.search(/\bcon\b/i);
    let pa = l.slice(0, pi);
    let pd = l.slice(pi);
    pd = pd.replace(/\bp[ \t]*([0-9.,]+)/ig, 'parle con $1');
    l = pa + pd;
  } else {
    l = l.replace(/(?<![a-zA-Z])p[ \t]+([0-9.,]+)/ig, 'parle con $1');
    l = l.replace(/\bp([0-9.,]+)/ig, 'parle con $1');
  }
  if (/\bcon\b/i.test(l)) {
    const idx = l.search(/\bcon\b/i);
    let antes = l.slice(0, idx);
    let desde = l.slice(idx);
    desde = desde.replace(/\bc(?!andado)[ \t]*([0-9.,]+)/ig, 'candado con $1');
    desde = desde.replace(/(\d+)c\b/gi, '$1');
    desde = desde.replace(/\bc\b/gi, '');
    antes = antes.replace(/\bc(\d+)/gi, '$1').replace(/\bc\b/gi, '');
    l = antes + desde;
  } else {
    l = l.replace(/\bc(?!andado)[ \t]+([0-9.,]+)/ig, 'candado con $1');
    l = l.replace(/(\d+)c\b/gi, '$1');
    l = l.replace(/\bc\b/gi, '');
  }
  return l;
}

const _TYPO_RE_PREP = /\b(c[aá]b[dn]a?d[ao]o?|cand[ao]{2}|candago|cabdado|cnadado|candao|canado|cadnado|cnadao|canddo|parlee+|pr[ae]le?t?|pal?ret?|parl[eé]t?)\b/gi;

// ─────────────────────────────────────────────────────────────────────────────
// RULE: LEFT_SIDE_ALLOWED_TOKENS
//
// En el lado izquierdo (antes de "con") solo se permiten tokens del dominio DSL.
//
// ALLOW (left side):
//   - Números: dígitos 0-9, secuencias numéricas
//   - Símbolos de par: * y x  →  SOLO cuando están entre dos operandos numéricos
//   - Tokens letra: pr
//   - Variantes de: decena(s), terminal(es), centena(s)
//     → a esta altura ya fueron reducidos a 'd' / 't' o expandidos a números,
//       pero 'pr' puede aún aparecer como raw token
//
// ALLOW (right side, después de "con" / "parle" / "candado"):
//   - con, y, parle, candado, a, de + sus números
//
// REJECT: cualquier texto libre no reconocido, letras aisladas sin significado DSL,
//         símbolos distintos de * y x, x/* fuera de contexto de par numérico.
// ─────────────────────────────────────────────────────────────────────────────

const _LEFT_WORD_ALLOW  = new Set(['pr', 'total']);
const _RIGHT_WORD_ALLOW = new Set(['con', 'y', 'candado', 'parle', 'a', 'de']);
// Placeholder for pair operator (NxN / N*N) during word-stripping pass.
const _PAIR_OP_PH = '__PAROP__';

function _sanitizarLadoIzquierdo(lado) {
  if (!lado) return '';

  // 1. Protect valid pair operators (N x N, NxN, N*N, N * N) before word stripping.
  //    Any x or * that sits between two digit tokens is a DSL pair operator — keep it.
  lado = lado.replace(/(\d)\s*[xX*]\s*(\d)/g, (m, a, b) => a + _PAIR_OP_PH + b);

  // 2. Eliminate word tokens not in the left-side whitelist.
  lado = lado.replace(/\b([a-záéíóúüñ]+)\b/gi, (tok) =>
    _LEFT_WORD_ALLOW.has(tok.toLowerCase()) ? tok : ''
  );

  // 3. Restore pair operators (placeholder → x, normalized form).
  lado = lado.replace(/__PAROP__/g, 'x');

  // 4. Strip any remaining bare x or * that are NOT between digit operands
  //    (survived because they were not adjacent to digits on both sides).
  lado = lado.replace(/(?<!\d)\s*[xX]\s*(?!\d)/g, ' ');
  lado = lado.replace(/(?<!\d)\s*\*\s*(?!\d)/g, ' ');

  return lado;
}

function _eliminarPalabrasNoReservadas(l) {
  if (typeof l !== 'string') return '';
  if (!/\d/.test(l)) return l;
  _TYPO_RE_PREP.lastIndex = 0;
  if (_TYPO_RE_PREP.test(l)) { _TYPO_RE_PREP.lastIndex = 0; return l; }

  // Dividir la línea en lado izquierdo (antes de la primera keyword de monto/operador)
  // y lado derecho (desde la keyword inclusive).
  //
  // Caso especial: si la línea abre con "parle"/"candado" seguido de pares (NxN),
  // esa palabra no cumple función — es ruido delante del lado izquierdo real.
  // Re-anclar el split a "con" para que _sanitizarLadoIzquierdo reciba
  // "parle 41x88 " y elimine "parle" (no está en _LEFT_WORD_ALLOW), dejando "41x88".
  //   "parle 41x88 con 10"      → ladoIzq="parle 41x88 " → "41x88" → "41x88 con 10"
  //   "candado 41x88x98 con 10" → ladoIzq="candado 41x88x98 " → "41x88x98" → limpio
  let km = l.match(/\b(con|candado|parle)\b/i);
  const _conM = l.match(/\bcon\b/i);
  if (
    km &&
    /^(parle|candado)\b/i.test(l) &&
    _conM &&
    /\d[xX]\d/.test(l.slice(0, _conM.index))
  ) {
    km = _conM; // re-anchor: left side = "parle/candado <pairs>", right side = "con N"
  }
  if (km) {
    const si = km.index;
    let ladoIzq = l.slice(0, si);
    let ladoDer = l.slice(si);

    // Sanitizar lado izquierdo con la regla DSL.
    ladoIzq = _sanitizarLadoIzquierdo(ladoIzq);

    // Sanitizar lado derecho: solo keywords permitidas y números.
    ladoDer = ladoDer.replace(/\b([a-záéíóúüñ]{2,})\b/gi, (tok) =>
      _RIGHT_WORD_ALLOW.has(tok.toLowerCase()) ? tok : ''
    );

    l = ladoIzq + ladoDer;
  } else {
    // Sin keyword de monto: toda la línea es lado izquierdo.
    l = _sanitizarLadoIzquierdo(l);
  }

  return l.replace(/ +/g, ' ').trim();
}

const ruidoSet = new Set([
  'fijo', 'corrido', 'parle', 'parlet', 'candado', 'candao',
  'total', 'centena', 'y', 'al', 'de', 'a', 'con', 'p', 'c', 't', 'd', 'v',
  'flo', 'tarjeta', 'rango', 'bote', 'pareja', 'parejas', 'terminal', 'decena', 'cent',
  'volteo', 'ponme', 'nota', 'obs', 'observacion', 'ref', 'referencia'
]);

function esLineaRuido(linea) {
  if (typeof linea !== 'string') return true;
  const trimmed = linea.trim();
  if (!trimmed) return true;
  if (/\d/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  for (const tok of tokens) if (!ruidoSet.has(tok)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECCIÓN DE INSTRUCCIONES CENTENA GLOBAL
//
// Retorna:
//   'ALL'          → todas las centenas (0-9)
//   '0'..'9'       → centena específica (t0..t9)
//   null           → no es instrucción de centena global
//
// Patrones reconocidos (sobre texto ya lowercaseado):
//   "por todas las centenas"  → ALL
//   "todas las centenas"      → ALL
//   "centenas globales"       → ALL
//   "centena global"          → ALL
//   "t3 global"               → '3'
//   "t0 global" .. "t9 global"→ '0'..'9'
// ─────────────────────────────────────────────────────────────────────────────
function _detectarCentenaGlobal(l) {
  const t = l.trim().toLowerCase();

  // Extrae monto opcional al final: "... con N" o "... N"
  function _monto(str) {
    const m = str.match(/\bcon\s+([\d.,]+)\s*$/) || str.match(/\s+([\d.,]+)\s*$/);
    return m ? m[1] : '';
  }

  // ── SINTAXIS CORTA: xc, xc3, xc35, xc 3 5 ────────────────────────────────
  // xc          → todas las centenas
  // xc3         → solo centena 3
  // xc35        → centenas 3 y 5
  // xc 3 5      → centenas 3 y 5 (con espacio)
  // xc con 10   → todas con monto 10
  // xc3 con 10  → centena 3 con monto 10
  // xc 3 5 con 10 → centenas 3 y 5 con monto 10
  const mXC = t.match(/^xc([0-9]*)((?:\s+[0-9])*)(.*)/);
  if (mXC) {
    const digitsInline = mXC[1]; // "35" en "xc35"
    const digitsSpaced = mXC[2].trim(); // "3 5" en "xc 3 5"
    const resto = mXC[3];
    const monto = _monto(resto);

    let centenas;
    if (digitsInline) {
      centenas = digitsInline.split('').join(',');
    } else if (digitsSpaced) {
      centenas = digitsSpaced.split(/\s+/).join(',');
    } else {
      centenas = 'ALL';
    }
    return centenas + ':' + monto;
  }

  // ── SINTAXIS LARGA (backward compat) ─────────────────────────────────────
  if (
    /\btodas?\s+(?:las\s+)?centenas?\b/.test(t) ||
    /\bpor\s+(?:todas?\s+(?:las\s+)?)?centenas?\b/.test(t) ||
    /\bcentenas?\s+globales?\b/.test(t) ||
    /\bcentena\s+global\b/.test(t)
  ) {
    return 'ALL:' + _monto(t);
  }

  // "t<n> global [con N]"
  const mTn = t.match(/^t\s*([0-9])\s+global\b(.*)/);
  if (mTn) return mTn[1] + ':' + _monto(mTn[2]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RULE: BANCA_GUION_NOTATION
//
// Convierte notación compacta con guión a DSL canónico antes de cualquier otro
// procesamiento. Ejemplos:
//
//   33-300         → "33 con 300"
//   33-55-40-300   → "33 55 40 con 300"   (último segmento = monto)
//   58- 200        → "58 con 200"          (espacios alrededor del guión)
//   58 - 200       → "58 con 200"
//
// NO aplica si:
//   - La línea ya contiene "con" / "parle" / "candado" (ya es DSL canónico)
//   - La línea tiene "/" (parle implícito tipo 33/01-50 → conservar lógica parle)
//   - Hay menos de 2 segmentos numéricos (ej. "Total-900" con texto)
//   - Algún segmento contiene letras (texto con guiones de ortografía)
// ─────────────────────────────────────────────────────────────────────────────
function _normalizarBancaGuion(linea) {
  if (typeof linea !== 'string') return linea;
  if (/\b(con|parle|candado)\b/i.test(linea)) return linea;

  // Líneas con operadores de par: normalizar N/M→NxM y extraer monto final
  if (/[xX*\/]/.test(linea)) {
    const norm = linea.replace(/(\d{1,2})\/(\d{1,2})/g, '$1x$2');
    const mMonto = norm.match(/^(.+?)\s+-\s*(\d+)\s*$/) || norm.match(/^(.+)-(\d+)\s*$/);
    if (mMonto && /^\d+$/.test(mMonto[2])) return mMonto[1].trimEnd() + ' con ' + mMonto[2];
    return norm;
  }

  // Notación banca: N-M o N1-N2-...-MONTO
  const partes = linea.split(/\s*-\s*/);
  if (partes.length < 2) return linea;
  if (!partes.every(p => /^\d[\d\s]*$/.test(p.trim()))) return linea;
  const monto = partes[partes.length - 1].trim();
  const numeros = partes.slice(0, -1).map(p => p.trim()).join(' ');
  return numeros + ' con ' + monto;
}

/**
 * Procesa una línea raw del input DSL.
 *
 * @param {string}              rawLine
 * @param {object|null}         [ledger]    - BetAuditLedger activo (de createBetAuditLedger).
 *                                            Si es null, el comportamiento legacy se mantiene.
 * @param {number}              [lineIndex] - Índice original de la línea en el rawInput.
 * @returns {string}  Línea normalizada (vacía si debe descartarse).
 */
function procesarLineaRaw(rawLine, ledger = null, lineIndex = -1) {
  const id = nextId();
  // Strip de acentos: NFD descompone, luego eliminar combining marks (U+0300-U+036F).
  // parlét->parlet, candadó->candado, etc., sin importar origen (WhatsApp, iOS, Android).
  // Luego normalizar variantes de parle/candado antes de cualquier otro procesamiento.
  let l = String(rawLine ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bparle[t]?\b/gi, 'parle')
    .replace(/\bcandao\b/gi, 'candado');
  // RULE: BANCA_GUION_NOTATION — convertir "33-300" → "33 con 300" antes de todo
  l = _normalizarBancaGuion(l);
  trace('PRE_RAW', { id, rawLine });

  const trimmed = l.trim();
  if (trimmed === '') {
    trace('PRE_FILTERED', { id, rawLine, resultado: '', razon: 'línea vacía' });
    return '';
  }

  if (!/\d/.test(trimmed)) {
    const esRuido = esLineaRuido(trimmed);
    const res = esRuido ? '' : rawLine;
    trace('PRE_LINE_NO_DIGIT', { id, rawLine, esRuido, resultado: res });
    trace('PRE_FILTERED', { id, rawLine, resultado: res, razon: esRuido ? 'ruido (sin dígitos)' : 'nombre/texto preservado' });
    return res;
  }

  // ── DETECCIÓN TEMPRANA: xc / xc3 / xc35 / xc 3 5 ──────────────────────────
  // DEBE ocurrir ANTES de _eliminarPalabrasNoReservadas, que destruye "xc"
  // porque la 'x' sin dígitos adyacentes es eliminada como token inválido.
  {
    const cgEarly = _detectarCentenaGlobal(trimmed);
    if (cgEarly !== null) {
      trace('PRE_FILTERED', { id, rawLine, resultado: `CENTENA_GLOBAL:${cgEarly}`, razon: 'instrucción centena global (detección temprana xc)' });
      return `\x00CENTENA_GLOBAL\x00${cgEarly}\x00`;
    }
  }

  // ── HELPER interno: flag + return '' ────────────────────────────────────────
  // Centraliza el patrón "registrar en ledger y devolver cadena vacía" para que
  // ningún return '' salga sin pasar por el ledger cuando hay candidato.
  const flagAndDiscard = (razon, cleaned = '') => {
    // ── NO_BET_LOSS_POLICY: NUNCA descartar silenciosamente una línea con dígitos ──
    // Si llegamos aquí con una línea que tiene números, es un error crítico de flujo.
    // Emitir trace NUMERIC_LINE_DISCARDED_FATAL y convertir en WARNING_AMBIGUOUS.
    if (/\d/.test(rawLine)) {
      trace('NUMERIC_LINE_DISCARDED_FATAL', {
        id,
        rawLine,
        cleaned,
        razon,
        policy: 'NO_BET_LOSS — línea con dígitos NO puede ser descartada silenciosamente',
      });
    }
    if (ledger && esLineaCandidato(rawLine)) {
      const { reason, severity, code } = mapearRazonFlag(razon, rawLine, cleaned);
      ledger.flag(lineIndex, rawLine, cleaned, reason, severity, code);
    }
    trace('PRE_FILTERED', { id, rawLine, resultado: '', razon });
    return '';
  };

  // ── NO_BET_LOSS_POLICY: heurística "header" refactorizada ──────────────────
  //
  // Regla anterior: "texto + número suelto sin con → HEADER_DISCARDED"
  //   Problema: descartaba silenciosamente "Y 20 corrido" provocando pérdida real de apuesta.
  //
  // Regla nueva:
  //   • Si la línea tiene texto + un único número Y tiene tokens que el preprocesador
  //     elimina como ruido (corrido, fijo, volteo, etc.) → intentar extraer el número
  //     y emitirlo como monto pendiente de contexto (WARNING_AMBIGUOUS).
  //   • Solo cuando NO hay absolutamente ninguna estructura recuperable → FLAG con
  //     severity=warning y status=PENDING_REVIEW (nunca silencio total).
  //   • Nunca HEADER_DISCARDED para líneas con dígitos.
  {
    const sinCon = !/\bcon\b/i.test(trimmed);
    const tieneTexto = /[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]{2,}/.test(trimmed);
    const soloUnNumero = /^[^\d]*(\d+(?:[.,]\d+)?)[^\d]*$/.test(trimmed);
    const esTotal = /^\s*total\b/i.test(trimmed);
    const esParejasSinCon = /^\s*parejas?\s+\d+[.,]?\d*\s*$/i.test(trimmed);
    const esCandadoParle = /^\s*(candado|parle)\b/i.test(trimmed);

    if (sinCon && tieneTexto && soloUnNumero && !esTotal && !esParejasSinCon && !esCandadoParle) {
      // Extraer el número presente en la línea
      const mNum = trimmed.match(/(\d+(?:[.,]\d+)?)/);
      const numStr = mNum ? mNum[1] : null;

      // Detectar si los tokens de texto son todos palabras de ruido DSL conocidas
      // (corrido, fijo, volteo, y, etc.) — si es así, el número es recuperable.
      const tokensTexto = trimmed.replace(/\d+(?:[.,]\d+)?/g, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      const todosSonRuido = tokensTexto.length > 0 && tokensTexto.every(tok => ruidoSet.has(tok));

      if (numStr && todosSonRuido) {
        // Caso recuperable: "Y 20 corrido", "20 corrido", "20 fijo" etc.
        // Devolver el número como monto solo — el engine/parser lo adjuntará al contexto acumulado.
        // El ledger lo registra como RECOVERED para trazabilidad completa.
        const cleaned = numStr.replace(',', '.');
        trace('PRE_NORMALIZED', { id, rawLine, normalizado: cleaned, paso: 'numeric-recovery-from-noise-line' });
        if (ledger && esLineaCandidato(rawLine)) {
          ledger.recover(
            lineIndex, rawLine, cleaned,
            `Línea con texto de ruido + número: "${rawLine.trim()}" → número ${cleaned} recuperado. ` +
            `Tokens de texto descartados: [${tokensTexto.join(', ')}]. ` +
            `Verificar que era continuación de la apuesta anterior.`
          );
        }
        trace('PRE_FILTERED', { id, rawLine, resultado: cleaned, razon: 'numeric-recovery: número extraído de línea de ruido' });
        return cleaned;
      }

      // Caso no recuperable: el texto no es todo ruido DSL conocido
      // (ej: "Florida 2", "New York 3" — son encabezados reales de lotería).
      // Registrar como PENDING_REVIEW, nunca silenciar.
      if (ledger && esLineaCandidato(rawLine)) {
        ledger.flag(
          lineIndex, rawLine, numStr || '',
          `Posible encabezado de lotería/sorteo: "${rawLine.trim()}". ` +
          `Si es una apuesta, agregar "con <monto>": ej. "${(numStr || '??')} con <monto>".`,
          'warning',
          'PENDING_REVIEW'
        );
      }
      trace('PRE_FILTERED', {
        id, rawLine,
        resultado: '',
        razon: 'PENDING_REVIEW: texto no-DSL + número suelto sin con — requiere revisión',
      });
      return '';
    }
  }

  // "parejas N" sin "con" → error explícito para el usuario final
  if (/^\s*parejas?\s+\d+[.,]?\d*\s*$/i.test(trimmed)) {
    // Registrar en ledger antes de emitir el marcador de error
    if (ledger && esLineaCandidato(rawLine)) {
      ledger.flag(lineIndex, rawLine, trimmed,
        'Parejas sin monto. Escriba "parejas con <monto>".',
        'error', 'R_PAREJAS_SIN_CON');
    }
    trace('PRE_FILTERED', {
      id, rawLine,
      resultado: `\x00ERROR\x00R_PAREJAS_SIN_CON\x00${trimmed}\x00`,
      razon: 'parejas sin "con" → marcador de error para el usuario',
    });
    return `\x00ERROR\x00R_PAREJAS_SIN_CON\x00${trimmed}\x00`;
  }

  // FIX BUG3: 🔒 debe convertirse a "candado" ANTES del strip /[^a-z0-9\sx.]/ que lo borra
  l = l.replace(/🔒/g, ' candado ');
  l = l.replace(/[\u{1F510}\u{1F512}\u{1F50F}]/gu, ' candado ');

  l = l.toLowerCase();
  trace('PRE_NORMALIZED', { id, rawLine, normalizado: l, paso: 'lowercase' });

  // Normalizar variantes acentuadas de parle/parlé/parlét ANTES del strip de no-ASCII (línea 383),
  // que convertiría "parlét" → "parl t" rompiendo la detección de parle.
  l = l.replace(/parle[t]?/g, 'parle');            // parlé → parle, parlét → parle (ASCII exacto, post-lowercase)
  l = l.replace(/parlé[t]?/g, 'parle');           // parle + combining accent (U+0301)
  l = l.replace(/parl[eé][t]?(?=s|$)/g, 'parle'); // parlé (U+00E9) con o sin t
  // "parle a N" → "parle con N" (usuario escribe "en parlét a 10")
  l = l.replace(/parles+as+(?=d)/gi, 'parle con ');
  trace('PRE_NORMALIZED', { id, rawLine, normalizado: l, paso: 'parle-accent-normalize' });

  // 🔥 CORRECCIÓN: "parejas con N" → expansión a 00 11 ... 99 con N
  l = l.replace(/\b(?:parejas?|pares)\s+con\s+(\d+)/gi, (match, monto) => {
    const numeros = [];
    for (let i = 0; i <= 9; i++) {
      numeros.push(String(i).repeat(2).padStart(2, '0'));
    }
    return numeros.join(' ') + ' con ' + monto;
  });

  // Asteriscos y x entre números
  l = l.replace(/(\d+)((?:\s*[*x]\s*\d+)+)/gi, (m, first, rest) => {
    const parts = [first, ...rest.split(/\s*[*x]\s*/i).filter(Boolean)];
    return parts.length === 2 ? parts[0] + 'x' + parts[1] : parts.join(' ');
  });
  l = l.replace(/\s+/g, ' ').trim();

  // Comas entre números: antes de keyword separador, después decimal
  {
    const kwMatch = l.match(/\b(con|parle|candado)\b/i);
    if (kwMatch) {
      const ki = kwMatch.index;
      const antes = l.slice(0, ki).replace(/(\d),(\d)/g, '$1 $2');
      const desde = l.slice(ki).replace(/(\d),(\d)/g, '$1.$2');
      l = antes + desde;
    } else {
      l = l.replace(/(\d),(\d)/g, '$1 $2');
    }
  }
  l = l.replace(/[^a-z0-9\sx.]/g, ' ');
  l = l.replace(/\bparlet\b/g, 'parle');
  l = l.replace(/\bcandao\b/g, 'candado');
  // "parle a N" / "candado a N" — 'a' como conector de monto tras keyword
  l = l.replace(/\bparle[ \t]+a[ \t]+(\d)/ig, 'parle con $1');
  l = l.replace(/\bcandado[ \t]+a[ \t]+(\d)/ig, 'candado con $1');
  l = l.replace(/\b(terminal|termin(?:a(?:r)?)?|termi)[ \t]*(\d)/gi, 't$2');
  l = l.replace(/\b(decenas?|decen|dece|decer)[ \t]*(\d)/gi, 'd$2');
  l = l.replace(/\b(ter(?:m(?:in(?:a(?:r)?)?)?)?)[ \t]*(\d)\b/gi, 't$2');
  l = l.replace(/\b(dec(?:en(?:as?)?)?)[ \t]*(\d)\b/gi, 'd$2');
  l = l.replace(/\b([td])(\d{2,})\b/gi, (_, tipo, num) => tipo + num.charAt(0));

  if (esLineaRuido(l)) {
    trace('PRE_LINE_NOISE', { id, rawLine, lineaNormalizada: l, razon: 'esLineaRuido → true tras normalización básica' });
    return flagAndDiscard('línea de ruido', l);
  }

  l = l.replace(/(\d)\.(\d)/g, '$1__DEC__$2');
  l = l.replace(/\./g, ' ');
  l = l.replace(/__DEC__/g, '.');
  l = l.replace(/\s+parle[ \t]+con\s*/g, ' parle con ');
  l = l.replace(/\b(fijo|corrido|volteo|rango|bote|pareja|terminal|decena|cent)\b/g, '');
  l = l.replace(/\b(con|cn|coon|con)\b/g, 'con');
  l = l.replace(/\bparle[ \t]+(\d+(?:[.,]\d+)?)\b/gi, 'parle con $1');
  l = l.replace(/\bcandado[ \t]+(\d+(?:[.,]\d+)?)\b/gi, 'candado con $1');
  l = l.replace(/\s+/g, ' ').trim();
  l = l.replace(/\btodos[ \t]+(?=[\u{1F510}\u{1F512}\u{1F50F}]|\bcandado\b)/giu, '');
  l = l.replace(/[\u{1F510}\u{1F512}\u{1F50F}][ \t]*(\d+)/gu, 'EMCAND__$1__');
  l = l.replace(/[\u{1F510}\u{1F512}\u{1F50F}]/gu, 'EMCAND__0__');
  l = l.replace(/\b(d|t|decena|terminal)[ \t]*-\s*/gi, '$1 ');
  l = limpiarLineaAuto(l);
  l = l.replace(
    /((?:\d+[ \t]+)+)(?:por[ \t]+)?(?:todas[ \t]+(?:las[ \t]+)?)?centenas([^\n]*)/gi,
    (match, nums, resto) => {
      const numeros = nums.trim().split(/\s+/);
      return numeros.map(numero => {
        const base = numero.padStart(2, '0');
        const cs = [];
        for (let c = 0; c <= 9; c++) cs.push(String(c) + base);
        return cs.join(' ') + (resto || '');
      }).join('\n');
    },
  );
  // FIX: "00 al 99" es patrón de parejas, NO rango numérico — interceptar ANTES de _expandirRangosLinea
  l = l.replace(/\b00\s+al\s+99\b/gi, '00 11 22 33 44 55 66 77 88 99');
  l = _expandirRangosLinea(l);
  l = l.replace(/\b(d|decena)[ \t]+(\d{1,2})\b/gi, (match, tipo, num) => {
    const n = parseInt(num, 10);
    const d = num.length === 2 ? Math.floor(n / 10) : n;
    return 'd ' + d;
  });
  l = l.replace(/\b(t|terminal)[ \t]+(\d{1,2})\b/gi, (match, tipo, num) => 't ' + (parseInt(num, 10) % 10));
  l = l.replace(/(\d+)(de|a|con|y)(\d+)/gi, '$1 $2 $3');
  l = l.replace(/(de|a|con|y)(\d+)/gi, '$1 $2');
  l = l.replace(/(\d+)(de|a|con|y)\b/gi, '$1 $2');
  l = l.replace(/\bpor[ \t]+(\d+)/gi, 'con $1');
  l = l.replace(/conel/gi, 'con el');
  l = l.replace(/\bcon el\b/gi, 'con');
  l = l.replace(/\ba el\b/gi, 'a');
  l = l.replace(/\be\b/gi, 'y');
  l = l.replace(/\bi\b/gi, 'y');
  l = l.replace(/(\d+),(\d+)/g, '$1.$2');
  l = l.replace(/\$(\d+)/g, '$1');
  l = l.replace(/(\d+)\$/g, '$1');
  l = l.replace(/\bcon(\d+)/gi, 'con $1');
  l = l.replace(/\bde(\d+)/gi, 'de $1');
  l = l.replace(/\ba(\d+)/gi, 'a $1');
  l = l.replace(/\by(\d+)/gi, 'y $1');
  l = l.replace(/\bdecena\b/gi, 'd');
  l = l.replace(/\bterminal\b/gi, 't');
  l = l.replace(/(\d)[\-_](?=\d)/g, '$1 ');
  l = l.replace(/(\d+)con[ \t]*(\d+)/ig, '$1 con $2');
  l = l.replace(/\bcon(\d+)/ig, 'con $1');
  l = l.replace(/(\d+)y(\d+)/ig, '$1 y $2');
  l = l.replace(/EMCAND__(\d+)__/g, 'candado con $1');
  l = l.replace(/^\s*tarjeta[ \t]+([0-9.,]+)\s*$/ig, 'total $1');
  if (/^\s*ponme[ \t]+(por|en|a)[ \t]+/i.test(l) || /^\s*ponme\s*$/i.test(l)) {
    return flagAndDiscard('ponme → ruido');
  }
  l = l.replace(/(\d+)f\b/gi, '$1');
  l = l.replace(/\bf(\d+)/gi, '$1');
  l = l.replace(/(\d+)C\b/g, '$1');
  l = _normalizarCandadoParle(l);
  l = l.replace(/\bponle\b/ig, 'con');
  if (/\b(parle|candado)\b/i.test(l)) {
    l = l.replace(/(\d)[ \t]+\b(a|de)[ \t]+(?=\d)/gi, (m, d, kw) => d + ' con ');
  } else if (!/\bcon\b/i.test(l) && !/\b(al|centena|terminal|decena|total)\b/i.test(l)) {
    l = l.replace(/[ \t]+\b(a|de)[ \t]+/gi, ' con ');
  }
  l = l.replace(/[ \t]+\by\b[ \t]+(?=parle\b|candado\b)/gi, ' ');
  l = l.replace(/(?:\b(?:parejas?|pares)\b|00[ \t]*al[ \t]*99)/ig, '00 11 22 33 44 55 66 77 88 99');
  // FIX: "t9 y 1 y 5" → "t9 1 5" — join terminal digits separated by 'y'
  // so the expansion loop below handles all of them uniformly.
  l = l.replace(/\b(t\d{1,2})((?:\s+y\s+\d{1,2})+)/gi, (m, first, rest) => {
    return first + ' ' + rest.replace(/\s+y\s+/g, ' ').trim();
  });
  l = l.replace(/\bt((?:\s*\d{1,2})+)\b/ig, (m, nums) => {
    const out = [];
    nums.trim().split(/\s+/).forEach(n => {
      if (/^\d$/.test(n)) for (let k = 0; k < 10; k++) out.push(`${k}${n}`);
      else out.push(n.padStart(2, '0'));
    });
    return out.join(' ');
  });
  l = l.replace(/\bd((?:\s*\d{1,2})+)\b/ig, (m, nums) => {
    const out = [];
    nums.trim().split(/\s+/).forEach(n => {
      if (/^\d$/.test(n)) for (let k = 0; k < 10; k++) out.push(`${n}${k}`);
      else out.push(n.padStart(2, '0'));
    });
    return out.join(' ');
  });
  l = l.replace(/(\d{1,2})v\b/ig, (m, num) => {
    num = num.padStart(2, '0');
    return `${num} ${num.split('').reverse().join('')}`;
  });
  l = _eliminarPalabrasNoReservadas(l);

  // ── RIGHT_SIDE_ALLOWED_PATTERNS ─────────────────────────────────────────────
  // Sanitiza el lado derecho; si queda inválido → FLAGGED (nunca silenciosa).
  {
    const rsResult = aplicarRightSideRule(l);
    if (rsResult.linea === null) {
      return flagAndDiscard(
        `RIGHT_SIDE_RULE: ${rsResult.error?.code} — ${rsResult.error?.message}`,
        l,
      );
    }
    // Si se limpió algo del lado derecho → RECOVERED (no ACCEPTED todavía, eso es trabajo del engine).
    if (rsResult.linea !== l && ledger && esLineaCandidato(rawLine)) {
      ledger.recover(lineIndex, rawLine, rsResult.linea,
        `Lado derecho limpiado: "${l}" → "${rsResult.linea}"`);
    }
    l = rsResult.linea;
  }

  // ── RUIDO FINAL ──────────────────────────────────────────────────────────────
  if (esLineaRuido(l)) {
    trace('PRE_LINE_NOISE', { id, rawLine, lineaNormalizada: l, razon: 'esLineaRuido → true al final' });
    return flagAndDiscard('línea de ruido (final)', l);
  }

/*
  if (/\d+[xX]\d+/.test(l) && /\bcon\s+\d+/.test(l) && !/\b(parle|candado)\b/.test(l)) {
    l = l.replace(/\bcon\s+(\d+)/, 'parle con $1');
  }
*/
  // ── DETECCIÓN DE LÍNEA HUÉRFANA ──────────────────────────────────────────────
  // Una línea que llegó hasta aquí pero tiene estructura parcial (p.ej. "parle" sin
  // monto, o "con" sin número) debe quedar FLAGGED, no silenciada.
  {
    const { isOrphan, reason } = detectarLineaHuerfana(l);
    if (isOrphan) {
      if (ledger && esLineaCandidato(rawLine)) {
        ledger.flag(lineIndex, rawLine, l, reason, 'error', 'ORPHAN_LINE');
      }
      trace('PRE_FILTERED', { id, rawLine, resultado: '', razon: `ORPHAN: ${reason}` });
      return '';
    }
  }

  // ── CENTENA GLOBAL ──────────────────────────────────────────────────────────
  // Detectar instrucciones como "por todas las centenas", "t3 global", etc.
  {
    const cg = _detectarCentenaGlobal(l);
    if (cg !== null) {
      trace('PRE_FILTERED', { id, rawLine, resultado: `CENTENA_GLOBAL:${cg}`, razon: 'instrucción centena global' });
      return `\x00CENTENA_GLOBAL\x00${cg}\x00`;
    }
  }

  trace('PRE_NORMALIZED', { id, rawLine, normalizado: l, paso: 'final' });
  trace('PRE_FILTERED', { id, rawLine, resultado: l, razon: 'procesada correctamente' });
  return l;
}

// ========================= PUNTO DE ENTRADA PRINCIPAL =========================

/**
 * Preprocesa el input completo del DSL.
 *
 * @param {string} rawInput
 * @returns {{
 *   result:  string,        – líneas procesadas (join con \n), mismo contrato que antes
 *   audit:   ReturnType<import('./betAuditLedger.js').createBetAuditLedger['audit']>,
 *   ledger:  BetAuditLedger – ledger vivo para consultas adicionales
 * }}
 *
 * COMPATIBILIDAD: cuando se usa como antes (resultado = preprocesarJugada(raw))
 * el valor devuelto es un objeto — los llamadores que esperaban `string` deben
 * usar `.result`. El engine (parser.js) recibe el resultado vía deps.preprocesarJugada
 * y ya extrae el string; actualizar esa integración si es necesario.
 */
// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP META STRIPPER
// Elimina prefijos automáticos de WhatsApp antes de cualquier procesamiento.
// Formato: [HH:MM a. m./p. m., D/M/YYYY] +XX XXX XXXXXXX:
// Ejemplo: "[10:06 p. m., 29/4/2026] +53 5 2580872: 23 con 500"
//       →  "23 con 500"
// ─────────────────────────────────────────────────────────────────────────────
function stripWhatsAppMeta(line) {
  if (!line) return '';

  let cleaned = line.trim();

  // FIX BUG1: Capturar el teléfono del header ANTES de eliminarlo,
  // para luego borrarlo si cae al cuerpo del mensaje como "ambigüedad".
  const phoneMatch = cleaned.match(/^\[.*?\]\s*\+?([\d\s]{7,15}):/i)
                  || cleaned.match(/^\[\d{1,2}\/\d{1,2}[^\]]*\]\s*\+?([\d\s]{7,15}):/i);
  const phoneDigits = phoneMatch ? phoneMatch[1].replace(/\D/g, '') : null;

  // 1. FORMATO TIPO: [5/5, 1:49 p. m.] +53 5 6468550: Mensaje
  cleaned = cleaned.replace(
    /^\[\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\]\s*[^:]+:\s*/i,
    ''
  );

  // 1b. FORMATO SIN DOS PUNTOS: [5/5, 4:56 p. m.] Yode86
  // Solo el bracket de fecha/hora, el nombre queda como contenido util.
  cleaned = cleaned.replace(
    /^\[\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\]\s*/i,
    ''
  );

  // 1c. FORMATO SIN FECHA: "Yode86: contenido"  (nombre sin bracket de timestamp)
  // Solo aplica si la linea aun empieza con "Palabra:" (el paso 1 no hizo match).
  // Regex conservador: max 30 chars, solo alfanum+guion+punto, seguido de ": ".
  // Tras eliminar el prefijo "Nombre: ", el resto puede ser otro header WA reenviado —
  // re-aplicamos los pasos 1 y 2 sobre lo que queda.
  if (/^[A-Za-zÀ-ɏ0-9_\-\.]{1,30}:\s+/.test(cleaned)) {
    cleaned = cleaned.replace(/^[A-Za-zÀ-ɏ0-9_\-\.]{1,30}:\s+/, '');
    // Re-strip paso 1 (puede ser un header WA reenviado)
    cleaned = cleaned.replace(
      /^\[\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\]\s*[^:]+:\s*/i, ''
    );
    cleaned = cleaned.replace(
      /^\[\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\]\s*/i, ''
    );
  }

  // 2. FORMATO EXPORT WHATSAPP:
  // 5/5/26, 1:49 p. m. - Nombre: Mensaje
  cleaned = cleaned.replace(
    /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[ap]\.?\s*m\.?)?\s*-\s*[^:]+:\s*/i,
    ''
  );

  // 3. SOLO HEADER (sin mensaje) → eliminar
  if (/^\[\d{1,2}:\d{2}[^\]]*\]$/.test(cleaned)) {
    return '';
  }

  // 4. SI TODAVÍA QUEDA "telefono:" al inicio → eliminarlo
  cleaned = cleaned.replace(/^\+?\d[\d\s]{6,}:\s*/, '');

  // FIX BUG1: eliminar el teléfono del header si quedó en el cuerpo del mensaje
  if (phoneDigits && phoneDigits.length >= 7) {
    const re = new RegExp(phoneDigits.split('').join('\\s*'), 'g');
    cleaned = cleaned.replace(re, ' ');
  }
  // También eliminar teléfono suelto al inicio — SOLO si es un número continuo sin espacios
  // internos múltiples (teléfono real), NO si son varios números de lotería separados.
  // "53 5 6468550" → eliminar   |   "33 25 77 65 88 14 81" → NO eliminar (son pares de lotería)
  // Heurística: max 2 grupos separados por espacio (ej: código país + número), no más.
  cleaned = cleaned.replace(/^\s*\+?\d{1,4}\s\d{6,}(?=\s|$)/, '');  // ej: "53 56468550"
  cleaned = cleaned.replace(/^\s*\+?\d{7,}(?=\s|$)/, '');            // ej: "5356468550" (todo junto)

  // 5. colapsar espacios
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

function preprocesarJugada(rawInput) {
  if (rawInput === undefined) {
    try {
      rawInput = (typeof document !== 'undefined' ? document.getElementById('jugada')?.value : undefined) || '';
    } catch (e) { rawInput = ''; }
  }
  let j = String(rawInput || '');
  trace('PRE_START', { rawInput: j });
  trace('INPUT_START', j);

  const ledger = createBetAuditLedger();
  const lines = j.split(/\r?\n/);
  const processedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const _rawStripped = stripWhatsAppMeta(lines[i]);

    // FIX BUG2: extraer nombre real de headers WA con contexto geográfico/descriptivo.
    // Formato: "[hora] +tel: [nombre] [ciudad/contexto]"
    // Estrategia: la primera palabra capitalizada es el nombre; todo lo posterior se descarta.
    // Ejemplos:
    //   "Kirenia NY por tarjeta" → "Kirenia"  (primera palabra, el resto es contexto)
    //   "New york yasi"          → "yasi"     (última palabra — las anteriores son ciudad)
    //   "Zuzel"                  → "Zuzel"    (1 sola palabra, sin cambio)
    //
    // Heurística: si existe una palabra funcional (por/de/con/para/a) en el texto,
    // tomar todo lo que va ANTES de ella y quedarse con la última de esas palabras.
    // Si no hay funcional, tomar la última palabra del conjunto.
    // _wasWAHeader: la línea original era un header de WA (con bracket de fecha)
    // O era "Nombre: [header_reenviado]" — el strip 1c lo resuelve y _rawStripped
    // empieza con el contenido del header interno (puede ser texto ciudad+nombre).
    // Detectamos ambos casos para aplicar el Bug2 fix correctamente.
    const _origTrim = lines[i].trim();
    const _wasWAHeader = /^\[/.test(_origTrim) ||
                         /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(_origTrim) ||
                         /^[A-Za-zÀ-ɏ0-9_\-\.]{1,30}:\s+\[/.test(_origTrim);
    let line = _rawStripped;
    if (_wasWAHeader && _rawStripped && !/\d/.test(_rawStripped)) {
      const _words = _rawStripped.trim().split(/\s+/);
      if (_words.length >= 2) {
        // Encontrar índice de la primera palabra funcional
        const _funcIdx = _words.findIndex(w => /^(por|de|con|para|a|al|y)$/i.test(w));
        const _nameCandidates = _funcIdx > 0 ? _words.slice(0, _funcIdx) : _words;
        // El nombre es la última palabra del grupo pre-funcional
        // (ej: "New york yasi" sin funcional → "yasi"; "Kirenia NY por" → "Kirenia")
        // Con funcional: "Kirenia NY por tarjeta" → candidates=["Kirenia","NY"] → primera = "Kirenia"
        // Sin funcional: "New york yasi" → candidates=["New","york","yasi"] → última = "yasi"
        const _namePick = _funcIdx > 0
          ? _nameCandidates[0]
          : _nameCandidates[_nameCandidates.length - 1];
        line = _namePick;
      }
    }

    trace('PRE_RAW', { lineIndex: i, line });

    // Líneas de comentario (empiezan con #) → descartar siempre.
    if (/^\s*#/.test(line)) {
      trace('PRE_FILTERED', { lineIndex: i, line, razon: 'comentario # → descartado' });
      continue;
    }

    if (/\d/.test(line)) {
      // ── LÍNEAS META / ADMINISTRATIVAS ──────────────────────────────────────
      // Detectar ANTES de registerCandidate: estas líneas nunca son jugadas.
      // Si entran al ledger como candidates y luego se saltean, quedan huérfanas
      // y disparan AUDIT_MISSING_CANDIDATES como falso positivo.
      //
      // Patrón: palabra_meta seguida de número suelto, nada más.
      // Estricto a propósito: "25 con 100 total 140" no hace match (tiene "con").
      // FIX: ampliar para cubrir sufijos emoji/símbolo: "Total 900 💳", "Total 900 ✅"
      const _META_RE = /^\s*(total|tot|subtotal|suma|pago|abono|saldo)\b\s*:?\s*[\d.,]+\s*\S*\s*$/i;
      if (_META_RE.test(line)) {
        const _metaKw = (line.trim().match(/^(\w+)/) || [])[1] || 'meta';
        trace('AUDIT_LEDGER', { stage: 'skipMeta', type: 'META_LINE', keyword: _metaKw, raw: line });
        // total/tot → emitir token de control para el parser (declaración de monto)
        if (/^\s*tot(?:al)?\b/i.test(line)) {
          const _v = line.match(/[\d.,]+/);
          if (_v) processedLines.push('total ' + _v[0]);
        }
        // suma / subtotal / pago / abono / saldo → solo log, no emitir nada
        continue;
      }

      // Registrar candidato ANTES de procesar (solo jugadas reales, nunca meta)
      if (esLineaCandidato(line)) {
        ledger.registerCandidate(i, line);
      }

      // Extraer "Total N" del final ANTES de normalizar
      let lineaSinTotal = line;
      let totalSufijo = '';
      const totalSufijoMatchRaw = line.match(/\btotal\s+([\d.,]+)\s*$/i);
      if (totalSufijoMatchRaw) {
        totalSufijo = '\ntotal ' + totalSufijoMatchRaw[1];
        lineaSinTotal = line.slice(0, totalSufijoMatchRaw.index).trim();
        if (lineaSinTotal === '') {
          processedLines.push('total ' + totalSufijoMatchRaw[1]);
          // Total puro capturado por _META_RE arriba cuando viene solo.
          // Este branch cubre "jugada ... total N" donde lineaSinTotal queda vacío.
          continue;
        }
      }

      // ── EXTRACCIÓN INLINE DE xc ─────────────────────────────────────────────
      // Soporta "23 45 con 10 xc con 5" → jugada base + token CENTENA_GLOBAL.
      // Debe ocurrir ANTES de procesarLineaRaw para que el RIGHT_SIDE_SANITIZER
      // nunca vea "xc" y no rechace el lado derecho como "con 10 con 10".
      //
      // Patrones capturados al final de la línea (case-insensitive):
      //   xc con M           → ALL:M
      //   xc N con M         → N:M
      //   xc N1 N2 Nk con M  → N1,N2,Nk:M
      //   xc3 con M          → 3:M
      //   xc35 con M         → 3,5:M
      // El sufijo debe ir precedido de al menos un espacio para no confundirse
      // con tokens numéricos como "23x4" (par implícito).
      let xcTokenInline = null;
      {
        const mXCInline = lineaSinTotal.match(
          /\s+(xc[0-9]*(?:\s+[0-9])*(?:\s+con\s+[\d.,]+)?)\s*$/i
        );
        if (mXCInline) {
          const xcPart = mXCInline[1].trim();
          const cgSpec = _detectarCentenaGlobal(xcPart);
          if (cgSpec !== null) {
            lineaSinTotal = lineaSinTotal.slice(0, mXCInline.index).trim();
            xcTokenInline = `\x00CENTENA_GLOBAL\x00${cgSpec}\x00`;
            trace('PRE_NORMALIZED', {
              rawLine: line,
              razon: 'sufijo xc inline extraído',
              jugadaBase: lineaSinTotal,
              xcToken: xcTokenInline,
            });
          }
        }
      }

      // Normalización previa (expansión, limpieza, right-side sanitize)
      let normalized = procesarLineaRaw(lineaSinTotal, ledger, i);

      if (normalized === '') {
        // procesarLineaRaw ya registró la entrada en el ledger (flag/recover).
        if (xcTokenInline) processedLines.push(xcTokenInline);
        if (totalSufijo)   processedLines.push(totalSufijo.trim());
        continue;
      }

      // ── ATTACHED_TO_PREVIOUS: adjuntar número recuperado al contexto anterior ──
      //
      // Si procesarLineaRaw devolvió solo un número (ej: "20" recuperado de "Y 20 corrido")
      // Y la línea anterior en processedLines tiene "con" pero sin "y <monto>" posterior,
      // fusionar: "67 con 50" + "20" → "67 con 50 y 20".
      {
        const esSoloNumero = /^\d+(?:[.,]\d+)?$/.test(normalized);
        if (esSoloNumero && processedLines.length > 0) {
          const prevIdx = processedLines.length - 1;
          const prevLine = processedLines[prevIdx];
          const prevTieneConSinY = /\bcon\s+\d/.test(prevLine) && !/\by\s+\d/.test(prevLine);
          const prevEsJugada = typeof prevLine === 'string' &&
            prevLine !== '\x00BLANK_SEP\x00' &&
            prevLine !== '\x00JOINED\x00' &&
            /\d/.test(prevLine);

          if (prevEsJugada && prevTieneConSinY) {
            const fusionada = prevLine + ' y ' + normalized;
            processedLines[prevIdx] = fusionada;
            trace('PRE_NORMALIZED', {
              lineIndex: i, lineRaw: line, normalizado: fusionada, paso: 'ATTACHED_TO_PREVIOUS',
              prevLine, adjuntado: normalized,
            });
            if (xcTokenInline) processedLines.push(xcTokenInline);
            if (totalSufijo)   processedLines.push(totalSufijo.trim());
            continue;
          }
        }
      }

      // Token de control centena global — pasar directo, sin dividir
      // Registrar en ledger para que el audit no reporte candidato huérfano.
      if (normalized.startsWith('\x00CENTENA_GLOBAL\x00')) {
        processedLines.push(normalized);
        if (xcTokenInline) processedLines.push(xcTokenInline);
        if (totalSufijo)   processedLines.push(totalSufijo.trim());
        if (esLineaCandidato(line)) {
          ledger.accept(i, line, normalized, 'Instrucción centena global emitida como token de control.');
        }
        continue;
      }

      // Dividir por múltiples "con"
      const divided = dividirMultiplesCon(normalized);
      const subLines = (divided + totalSufijo).split('\n');
      let subCount = 0;
      for (const sub of subLines) {
        const trimmedSub = sub.trim();
        if (trimmedSub !== '') {
          processedLines.push(trimmedSub);
          subCount++;
        }
      }

      // Emitir el token xc inline DESPUÉS de las sub-líneas de la jugada base.
      // El engine acumula jugadasBase al procesar esas sub-líneas; cuando llega
      // al token CENTENA_GLOBAL ya tiene ctx.jugadasBase poblado.
      if (xcTokenInline) {
        processedLines.push(xcTokenInline);
      }

      // Registrar como ACCEPTED (si no fue ya registrado como RECOVERED por right-side)
      // Solo si no tiene entry previa del ledger para este lineIndex.
      const yaRegistrada = ledger.getEntries().some(e => e.lineIndex === i);
      if (!yaRegistrada && subCount > 0 && esLineaCandidato(line)) {
        ledger.accept(i, line, normalized);
      }

    } else {
      if (line.trim() === '') {
        processedLines.push('');
      } else if (esLineaRuido(line)) {
        trace('PRE_LINE_NOISE', { lineIndex: i, line, razon: 'ruido sin dígitos → descartado' });
      } else {
        // FIX NEW_YORK: línea sin dígitos que no es ruido puede ser nombre o contexto geográfico.
        // Si la siguiente línea no-vacía TAMPOCO tiene dígitos, esta línea es contexto descriptivo
        // (ej: "New York" entre "Zuzel" y los números) → descartarla.
        // Solo se preserva si la siguiente línea con contenido tiene dígitos (jugada inmediata)
        // o si no hay siguiente línea (último nombre del input).
        let _nextHasDigit = false;
        let _hasNext = false;
        for (let _k = i + 1; _k < lines.length; _k++) {
          const _nxt = stripWhatsAppMeta(lines[_k]).trim();
          if (_nxt === '') continue;
          _hasNext = true;
          if (/\d/.test(_nxt)) { _nextHasDigit = true; }
          break;
        }
        const _keepLine = !_hasNext || _nextHasDigit || scoreNombreBloque(line, i, processedLines).esNombre === false;
        // Siempre preservar si es nombre válido (scoreNombreBloque acepta) aunque siguiente no tenga dígitos
        // (cubre caso de nombre seguido de otro nombre, ej: bloques consecutivos sin jugadas)
        const _esNombreValido = scoreNombreBloque(line, i, processedLines).esNombre;
        // FIX NEW_YORK parte 2: si la siguiente línea con dígitos empieza con "con"
        // (monto suelto sin pares), esta línea es contexto geográfico del jugador, no un nombre nuevo.
        // Ejemplo: "New York" → "con 20" → descartar "New York".
        let _nextStartsWithCon = false;
        for (let _k = i + 1; _k < lines.length; _k++) {
          const _nxt = stripWhatsAppMeta(lines[_k]).trim().toLowerCase();
          if (_nxt === '') continue;
          if (/\d/.test(_nxt) && /^con\b/.test(_nxt)) { _nextStartsWithCon = true; }
          break;
        }
        if (_nextHasDigit && !_nextStartsWithCon || (_esNombreValido && !_nextStartsWithCon)) {
          trace('PRE_LINE_NO_DIGIT', { lineIndex: i, line, razon: 'nombre o texto sin dígitos → preservado' });
          processedLines.push(line);
        } else {
          trace('PRE_LINE_NOISE', { lineIndex: i, line, razon: 'texto sin dígitos descartado (contexto geográfico o monto suelto)' });
        }
      }
    }
  }

  // 🔥 FILTRO DE SEGURIDAD: eliminar cualquier valor no string o undefined
  const safeLines = processedLines.filter(l => l !== undefined && l !== null && typeof l === 'string');
  const result = safeLines.join('\n');

  // ── AUDITORÍA FINAL ────────────────────────────────────────────────────────
  const auditResult = ledger.audit();

  trace('PRE_END', {
    resultado: result,
    totalLineas: safeLines.length,
    audit: auditResult,
  });

  if (!auditResult.ok) {
    trace('ERROR', {
      code: 'AUDIT_MISSING_CANDIDATES',
      message: auditResult.criticalError,
      audit: auditResult,
    });
  }

  return { result, audit: auditResult, ledger };
}

const Preprocesador = {
  preprocesarJugada,
  procesarLineaRaw,
  limpiarLineaAuto,
};

// ═══════════════════════════════════════════════════
// MODULE: intentSegmenter.js
// ═══════════════════════════════════════════════════
const NOISE_WORDS_IS = new Set(['hola','oye','mira','ese','esa','eso','ok','dale','ah','eh','no','si','sí','bien','mal','que','los','las','un','una','es','era','fue','hay','ya','me','mi','tu','su','le','se','lo','te','nos','les','esto','eso','aqui','ahi','por','para','pero','pues','porque','como','cuando','donde','entiendo','todavia','siempre','nunca','tambien','tampoco','ponlo','ponme','ponle','dimelo','hazme','quiero','necesito','favor','gracias','dios','mio','aqui','ahi','alla','acá']);
const PRE_PARLE_WORDS_IS = new Set(['el','la']);
const PARLE_ALIAS_IS = /\b(pale|palé|parlet|parlé|parle)\b/gi;
const PAIR_NORM_IS = [[/(\d+)\s*\*\s*(\d+)/g,'$1x$2'],[/(\d+)\s+[xX]\s+(\d+)/g,'$1x$2'],[/(\d+)[xX]\s+(\d+)/g,'$1x$2'],[/(\d+)\s+[xX](\d+)/g,'$1x$2']];
function normalizarPares(line){let l=line;for(const[re,rep]of PAIR_NORM_IS)l=l.replace(re,rep);return l;}
function preNormalizarParleOpeners(line){return line.replace(/\b(?:y|mas|más|aparte|tambien|también|ademas|además)\b\s+(?:\b(?:el|la|un|una)\b\s+)?\bparle\b/gi,'__PARLE_OPEN__');}
function filtrarRuidoHumano(line){return line.trim().split(/\s+/).filter(tok=>{if(tok==='__PARLE_OPEN__')return true;const t=tok.replace(/[^a-záéíóúüñ]/gi,'').toLowerCase();if(PRE_PARLE_WORDS_IS.has(t)&&!/\d/.test(tok))return false;return!NOISE_WORDS_IS.has(t)||/\d/.test(tok);}).join(' ');}
function segmentarLinea(rawLine,lineIndex){
  lineIndex=lineIndex||0;
  let line=normalizarPares(rawLine);
  line=line.replace(/(con|de|a)(?=\d)/gi,'$1 ');
  line=line.replace(PARLE_ALIAS_IS,'parle');
  line=preNormalizarParleOpeners(line);
  const lf=filtrarRuidoHumano(line);
  if(!/\d/.test(lf)&&!lf.includes('__PARLE_OPEN__'))return[];
  const tk=[];
  for(const tok of lf.split(/\s+/).filter(Boolean)){const tl=tok.toLowerCase();if(tok==='__PARLE_OPEN__')tk.push({tok,type:'PARLE_OPEN'});else if(/^\d+x\d+$/i.test(tok))tk.push({tok,type:'PAIR'});else if(/^\d+([.,]\d+)?$/.test(tok))tk.push({tok,type:'NUM'});else if(tl==='con')tk.push({tok,type:'CON'});else if(tl==='y')tk.push({tok,type:'Y'});else if(tl==='parle')tk.push({tok,type:'PARLE'});else if(tl==='candado')tk.push({tok,type:'CANDADO'});else tk.push({tok,type:'UNK'});}
  const bqs=[];function nb(){return{kind:'NORMAL',nums:[],pares:[],montos:[],mm:false};}let b=nb();
  function close(r){if(b.nums.length||b.pares.length||b.montos.length)bqs.push({...b,nums:[...b.nums],pares:[...b.pares],montos:[...b.montos]});b=nb();}
  function hasParleAhead(i,w){w=w||3;for(let k=i;k<Math.min(i+w,tk.length);k++){const t=tk[k].type;if(t==='PARLE_OPEN'||t==='PARLE'||t==='PAIR')return true;}return false;}
  for(let i=0;i<tk.length;i++){const{tok,type}=tk[i];switch(type){case'PARLE_OPEN':close('PO');b.kind='PARLE';b.mm=false;break;case'PARLE':if(b.kind==='NORMAL'&&b.montos.length>0)close('Pk');b.kind='PARLE';b.mm=false;break;case'CANDADO':if(b.montos.length>0)close('Ck');b.kind='CANDADO';b.mm=false;break;case'PAIR':if(b.kind==='NORMAL'){if(b.montos.length>0){close('Pm');b.kind='PARLE';}else if(b.nums.length>0){close('Pn');b.kind='PARLE';}else b.kind='PARLE';}b.pares.push(tok);b.mm=false;break;case'CON':b.mm=true;break;case'Y':{const nx=tk[i+1];if(b.mm)break;if(b.kind==='NORMAL'&&b.montos.length>0&&nx&&nx.type==='NUM'&&!hasParleAhead(i+1,2))b.mm=true;break;}case'NUM':if(b.mm){b.montos.push(tok);const nx=tk[i+1];if(!nx||nx.type!=='Y')b.mm=false;if(nx&&(nx.type==='PAIR'||nx.type==='PARLE'||nx.type==='PARLE_OPEN'||nx.type==='CANDADO'))close('Mn');}else if(b.kind==='PARLE'&&b.montos.length>0){close('NP');b.nums.push(tok);}else if(b.kind==='NORMAL'&&b.montos.length>0){close('NN');b.nums.push(tok);}else b.nums.push(tok);break;}}
  close('end');
  const segs=[];
  for(const q of bqs){if(q.kind==='PARLE'||q.kind==='CANDADO'){const kw=q.kind==='CANDADO'?'candado':null;if(!q.pares.length&&q.nums.length===2){q.pares.push(q.nums[0]+'x'+q.nums[1]);q.nums=[];}if(!q.pares.length){segs.push({dsl:q.nums.join(' ')||'[parle]',kind:q.kind.toLowerCase(),ok:false,warning:'Parle sin pares NxN.',code:'W_PARLE_SIN_PARES'});continue;}const m=q.montos[0]||null;const ps=kw?kw+' '+q.pares.join(' '):q.pares.join(' ');if(!m)segs.push({dsl:ps,kind:q.kind.toLowerCase(),ok:false,warning:`Parle "${ps}" sin monto.`,code:'W_PARLE_SIN_MONTO'});else segs.push({dsl:`${ps} con ${m}`,kind:q.kind.toLowerCase(),ok:true});}else{const nums=q.nums;if(!nums.length&&!q.montos.length)continue;if(!q.montos.length){segs.push({dsl:nums.join(' '),kind:'fijo_corrido',ok:false,warning:`Números sin monto.`,code:'W_NUMS_SIN_MONTO'});continue;}const md=q.montos.join(' y ');segs.push({dsl:nums.length>0?`${nums.join(' ')} con ${md}`:`con ${md}`,kind:'fijo_corrido',ok:nums.length>0,...(nums.length===0?{warning:'Monto sin números.',code:'W_MONTO_SIN_NUMS'}:{})});}}
  for(const s of segs)s.dsl=s.dsl.replace(/\s+/g,' ').trim();
  if(!segs.length&&/\d/.test(rawLine))segs.push({dsl:lf,kind:'unknown',ok:false,warning:'No se pudo segmentar.',code:'W_UNPARSE'});
  return segs;
}
const IntentSegmenter={segmentarLinea,normalizarPares,filtrarRuidoHumano,preNormalizarParleOpeners};

// ═══════════════════════════════════════════════════
// MODULE: engine.js
// ═══════════════════════════════════════════════════
/**
 * lotopro-engine · src/core/engine.js
 *
 * ARQUITECTURA: PREPROCESADOR → PARSER → CLASSIFIER → ENGINE → EVALUATOR
 *
 * ──────────────────────────────────────────────────────────────────
 * TRACING: Importa trace() de tracer.js. PROHIBIDO usar console.log directo.
 * ──────────────────────────────────────────────────────────────────
 */

// Exponer controles de tracing en window (solo en browser)
if (typeof window !== 'undefined') {
  exposeTraceControls();
}

function crearContexto() {
  return {
    collectedNums: [],
    collectedPares: [],   // pares NxN acumulados esperando un MONTO_SOLO
    lastParleNums: [],    // snapshot de collectedNums del último PARLE_GLOBAL procesado OK
    jugadasBase: [],      // jugadas fijo/corrido elegibles para centena global
    reset(reason) {
      trace('ENGINE_CONTEXT_RESET', { reason, collectedNumsAntes: [...this.collectedNums], collectedParesAntes: [...this.collectedPares] });
      this.collectedNums = [];
      this.collectedPares = [];
      this.jugadasBase = [];
      // lastParleNums se limpia solo en SEPARATOR, no en resets por PARLE_GLOBAL
      if (reason === 'SEPARATOR token' || reason === 'error de validación') {
        this.lastParleNums = [];
      }
    },
  };
}

function procesarBloque(bloque, deps) {
  const ex = deps.Expansion;
  const lm = deps.limpiarMonto;

  trace('ENGINE_TOKEN', {
    stage: 'procesarBloque:inicio',
    nombre: bloque.nombre,
    totalLineas: (bloque.jugadaLines || []).length,
    jugadaLines: bloque.jugadaLines,
  });

  let   total          = 0;
  let   detalles       = `=== JUGADOR: ${bloque.nombre} ===\n`;
  const errors         = [];
  const jugadasDetalle = [];
  let   hasError       = false;
  const lineOffset     = bloque.lineOffset ?? 0;
  const ctx            = crearContexto();

  // ── ENGINE_STATS: contadores de lo que el engine realmente ejecuta ────────
  // Fuente de verdad estadística para AUDIT. Independiente del ledger del PRE.
  const stats = {
    processedLines:  0,   // tokens OPERATION que llegaron al switch (intentados)
    validOps:        0,   // ops generadas y evaluadas sin error
    errorLines:      0,   // tokens que produjeron errores (validation + runtime)
    skippedTokens:   0,   // SEPARATOR / JOINED / IGNORE / INVALID
    totalComputed:   0,   // suma real de montos evaluados (se sincroniza con total al final)
  };

  // ── Interceptar marcadores de error emitidos por el preprocesador ────────
  // Formato: "\x00ERROR\x00<CODE>\x00<lineaOrig>\x00"
  // Se extraen antes de pasar al classifier para poder emitir mensajes
  // con código y texto descriptivo visible para el usuario final.
  const MENSAJES_ERROR_PRE = {
    R_PAREJAS_SIN_CON: (lineaOrig) => {
      const monto = (lineaOrig.match(/\d+[.,]?\d*/) || [''])[0];
      return `"${lineaOrig}" — escriba "parejas con ${monto}" para indicar el monto.`;
    },
  };
  const lineasFiltradas = [];
  for (const linea of (bloque.jugadaLines || [])) {
    const m = typeof linea === 'string' &&
      linea.match(/^\x00ERROR\x00([^\x00]+)\x00([^\x00]*)\x00$/);
    if (m) {
      const [, code, lineaOrig] = m;
      const msgFn = MENSAJES_ERROR_PRE[code];
      const err = {
        code,
        line: lineOffset + lineasFiltradas.length + 1,
        message: msgFn ? msgFn(lineaOrig) : `Error en línea: "${lineaOrig}". Revise la sintaxis.`,
      };
      trace('ERROR', { stage: 'marcador_preprocesador', ...err });
      errors.push(err);
      hasError = true;
      continue;
    }
    lineasFiltradas.push(linea);
  }

  const tokens = clasificarBloque(lineasFiltradas, lineOffset, ex, buildLineaDB);

  trace('ENGINE_TOKEN', {
    stage: 'tokens recibidos',
    total: tokens.length,
    resumen: tokens.map(t => ({ type: t.type, opKind: t.opKind, lineNum: t.lineNum, lineaExp: t.lineaExp })),
  });

  for (const token of tokens) {
    const tokenId = nextId();
    trace('ENGINE_TOKEN', { id: tokenId, token });

    // ── JOINED (líneas fusionadas artificialmente — NO resetear) ──────────
    if (token.type === LineType.JOINED) {
      stats.skippedTokens++;
      trace('ENGINE_TOKEN', { id: tokenId, stage: 'JOINED → skip sin reset', lineNum: token.lineNum });
      continue;
    }

    // ── SEPARATOR ──────────────────────────────────────────────────────────
    if (token.type === LineType.SEPARATOR) {
      stats.skippedTokens++;
      trace('ENGINE_SEPARATOR', { id: tokenId, reset: true, lineNum: token.lineNum });
      ctx.reset('SEPARATOR token');
      continue;
    }

    // ── NO OPERATION (IGNORE / INVALID) ────────────────────────────────────
    if (token.type !== LineType.OPERATION) {
      stats.skippedTokens++;
      trace('ENGINE_RESET_BY_INVALID', {
        id: tokenId,
        type: token.type,
        lineNum: token.lineNum,
        lineaExp: token.lineaExp,
        lineaOrig: token.lineaOrig,
      });
      ctx.reset(`token tipo ${token.type}`);
      continue;
    }

    const { opKind, lineaExp, lineaOrig, db, lineNum } = token;
    stats.processedLines++;   // este token llegó al switch como OPERATION

    trace('ENGINE_TOKEN', {
      id: tokenId,
      stage: 'OPERATION a procesar',
      opKind,
      lineaExp,
      lineaOrig,
      lineNum,
      collectedNums: [...ctx.collectedNums],
    });

    // ── VALIDACIÓN ─────────────────────────────────────────────────────────
    // CENTENA_GLOBAL tokens have db:null by design — skip validation.
    const lineErrors = opKind === OpKind.CENTENA_GLOBAL
      ? []
      : validarLinea(lineaExp, lineaOrig, db, lineNum, [...ctx.collectedNums], ex);
    if (lineErrors.length) {
      lineErrors.forEach(e => {
        trace('ERROR', { id: tokenId, ...e, lineaExp, lineaOrig });
        errors.push(e);
      });
      hasError = true;
      stats.errorLines++;
      ctx.reset('error de validación');
      continue;
    }

    let ops = [];

    switch (opKind) {

      // ── PARLE GLOBAL ──────────────────────────────────────────────────────
      case OpKind.PARLE_GLOBAL:
        trace('ENGINE_PARLE_GLOBAL_ENTER', { id: tokenId, lineNum, collectedNums: [...ctx.collectedNums] });
        // Si el contexto está vacío pero hay un snapshot del parle anterior,
        // reutilizarlo (caso: "parle con X" suelto tras otro parle que ya resetó).
        if (ctx.collectedNums.length < 2 && ctx.lastParleNums.length >= 2) {
          trace('ENGINE_PARLE_GLOBAL_ENTER', {
            id: tokenId,
            lineNum,
            razon: 'collectedNums vacío → reutilizando lastParleNums',
            lastParleNums: [...ctx.lastParleNums],
          });
          ctx.collectedNums = [...ctx.lastParleNums];
        }
        if (ctx.collectedNums.length < 2) {
          const err = {
            code: 'R005_PARLE_GLOBAL_MIN2',
            line: lineNum,
            message: `Parle global requiere al menos 2 números acumulados (hay ${ctx.collectedNums.length}).`,
          };
          trace('ERROR', { id: tokenId, ...err });
          errors.push(err);
          hasError = true;
          ctx.reset('PARLE_GLOBAL sin suficientes collectedNums');
          continue;
        }
        ops = buildOpsParleGlobal(lineaExp, ctx.collectedNums, lm);
        trace('ENGINE_PARLE_GLOBAL_OPS', { id: tokenId, ops, lineNum });
        if (!ops.length) {
          const err = { code: 'R005_PARLE_SIN_MONTO', line: lineNum, message: `Parle global sin monto válido.` };
          trace('ERROR', { id: tokenId, ...err });
          errors.push(err);
          hasError = true;
          ctx.reset('PARLE_GLOBAL sin monto válido');
          continue;
        }
        ctx.lastParleNums = [...ctx.collectedNums]; // guardar snapshot antes de resetear
        ctx.reset('PARLE_GLOBAL procesado OK');
        break;

      // ── CANDADO GLOBAL ────────────────────────────────────────────────────
      case OpKind.CANDADO_GLOBAL:
        trace('ENGINE_CANDADO_GLOBAL_ENTER', { id: tokenId, lineNum, collectedNums: [...ctx.collectedNums] });
        if (ctx.collectedNums.length < 3) {
          const err = {
            code: 'R006_CANDADO_GLOBAL_MIN3',
            line: lineNum,
            message: `Candado global requiere al menos 3 números acumulados (hay ${ctx.collectedNums.length}).`,
          };
          trace('ERROR', { id: tokenId, ...err });
          errors.push(err);
          hasError = true;
          ctx.reset('CANDADO_GLOBAL sin suficientes collectedNums');
          continue;
        }
        ops = buildOpsCandadoGlobal(lineaExp, ctx.collectedNums, lm);
        trace('ENGINE_CANDADO_GLOBAL_OPS', { id: tokenId, ops, lineNum });
        if (!ops.length) {
          const err = { code: 'R006_CANDADO_SIN_MONTO', line: lineNum, message: `Candado global sin monto válido.` };
          trace('ERROR', { id: tokenId, ...err });
          errors.push(err);
          hasError = true;
          ctx.reset('CANDADO_GLOBAL sin monto válido');
          continue;
        }
        ctx.reset('CANDADO_GLOBAL procesado OK');
        break;

      // ── CENTENA ───────────────────────────────────────────────────────────
      case OpKind.CENTENA:
        ops = buildOpsCentena(lineaExp, db, ex, lm);
        trace('ENGINE_CENTENA_OPS', { id: tokenId, ops, lineNum, fijosDerivados: db.fijosDerivados });
        trace('ENGINE_COLLECT_BEFORE', { id: tokenId, lineNum, collectedNums: [...ctx.collectedNums] });
        ctx.collectedNums.push(...db.fijosDerivados);
        trace('ENGINE_COLLECT_AFTER', { id: tokenId, lineNum, collectedNums: [...ctx.collectedNums], added: db.fijosDerivados });
        // No acumulamos en jugadasBase: ya tienen centena explícita, no deben expandirse.
        break;

      // ── PARLE_ACUM ────────────────────────────────────────────────────────
      // Par(es) NxN sin monto propio — acumular los pares para MONTO_SOLO posterior.
      // Regla: solo se permiten pares NxN en el grupo; cualquier otro tipo es error.
      case OpKind.PARLE_ACUM:
        trace('ENGINE_PARLE_ACUM', { id: tokenId, lineNum, pares: db.pares });
        ctx.collectedNums.push(...db.pares.flatMap(p => [p[0], p[1]]));
        ctx.collectedPares = ctx.collectedPares || [];
        ctx.collectedPares.push(...db.pares);
        trace('ENGINE_COLLECT_AFTER', { id: tokenId, lineNum, collectedPares: ctx.collectedPares });
        break;

      // ── MONTO_SOLO ────────────────────────────────────────────────────────
      // "con X" o "parle con X" sin números propios — aplica el monto a los
      // pares NxN acumulados en ctx.collectedPares.
      // Regla inviolable: el grupo debe ser SOLO pares NxN (collectedPares).
      // Una línea en blanco (SEPARATOR) ya habrá limpiado ctx antes de llegar aquí.
      case OpKind.MONTO_SOLO: {
        const pares = ctx.collectedPares || [];
        if (pares.length === 0) {
          const err = {
            code: 'R007_MONTO_SOLO_SIN_PARES',
            line: lineNum,
            message: 'Monto suelto "con X" sin pares NxN acumulados. Escriba los pares antes del monto.',
          };
          trace('ERROR', { id: tokenId, ...err });
          errors.push(err);
          hasError = true;
          ctx.reset('MONTO_SOLO sin pares acumulados');
          ctx.collectedPares = [];
          continue;
        }
        // Extraer el monto de la línea
        const montoMatch = lineaExp.match(/con\s+([\d.]+)/i);
        if (!montoMatch) {
          const err = { code: 'R007_MONTO_SOLO_INVALIDO', line: lineNum, message: 'No se pudo extraer el monto.' };
          trace('ERROR', { id: tokenId, ...err });
          errors.push(err);
          hasError = true;
          ctx.reset('MONTO_SOLO sin monto válido');
          ctx.collectedPares = [];
          continue;
        }
        const unit = lm(montoMatch[1]);
        // Sintetizar lineaExp que buildOpsNormal pueda procesar:
        // aplana los pares acumulados como "A B C D parle con X"
        const numsPares = pares.flatMap(p => p.map(n => String(n).padStart(2, '0')));
        const lineaSintetica = numsPares.join(' ') + ' parle con ' + montoMatch[1];
        const dbSint = buildLineaDB(lineaSintetica, lineaSintetica, ex);
        ops = buildOpsNormal(lineaSintetica, dbSint, ex, lm);
        trace('ENGINE_MONTO_SOLO_OPS', { id: tokenId, lineNum, pares, unit, lineaSintetica, ops });
        ctx.reset('MONTO_SOLO procesado OK');
        ctx.collectedPares = [];
        break;
      }

      // ── NORMAL ────────────────────────────────────────────────────────────
      case OpKind.NORMAL:
        trace('ENGINE_NORMAL_LINE', { id: tokenId, lineNum, lineaExp });
        ops = buildOpsNormal(lineaExp, db, ex, lm);
        trace('ENGINE_NORMAL_OPS', { id: tokenId, lineNum, ops });

        if (!ops.length && db.numerosBase.length && !/\bcon\b/i.test(lineaExp)) {
          const err = {
            code: 'R010_NUMS_SIN_MONTO',
            line: lineNum,
            message: `Números sin monto (${db.numerosBase.join(', ')}). Agregue "con X".`,
          };
          trace('ERROR', { id: tokenId, ...err });
          errors.push(err);
          hasError = true;
          ctx.reset('NORMAL sin monto');
          continue;
        }

        // Si hay números acumulados en el contexto (líneas previas en el mismo sub-bloque,
        // sin separador entre ellas), los ops candado/parle inline deben aplicar sobre
        // TODOS los números (previos + los de esta línea) SOLO cuando la línea NO tiene
        // números propios (db.numerosBase vacío). Si la línea tiene sus propios números,
        // el parle/candado aplica solo sobre ellos.
        if (ctx.collectedNums.length > 0 && db.numerosBase.length === 0) {
          const allNums = [...ctx.collectedNums, ...db.numerosBase].map(pad2);
          ops = ops.map(op => {
            if (op.tipo === 'candado') {
              const totalOrig = op.totalOriginal ?? (op.montoUnitario * comb2(op.numeros.length));
              const { unit, real, diff } = repartirExacto(totalOrig, comb2(allNums.length));
              trace('ENGINE_CANDADO_LOCAL_EXPAND', { id: tokenId, lineNum, prevNums: [...ctx.collectedNums], allNums, unit });
              return { ...op, numeros: allNums, pares: generarPares(allNums), montoUnitario: unit, totalReal: real, diff, totalOriginal: totalOrig };
            }
            if (op.tipo === 'parle') {
              trace('ENGINE_PARLE_LOCAL_EXPAND', { id: tokenId, lineNum, prevNums: [...ctx.collectedNums], allNums });
              return { ...op, numeros: allNums, pares: generarPares(allNums) };
            }
            return op;
          });
        }

        const tieneParleLocal   = ops.some(op => op.tipo === 'parle');
        const tieneCandadoLocal = ops.some(op => op.tipo === 'candado');

        // Siempre acumular los números de esta línea, tengan o no parle/candado local.
        // Un parle global posterior necesita todos los números del sub-bloque.
        if (ops.length) {
          trace('ENGINE_COLLECT_BEFORE', { id: tokenId, lineNum, collectedNums: [...ctx.collectedNums] });
          ctx.collectedNums.push(...db.numerosBase);
          trace('ENGINE_COLLECT_AFTER', { id: tokenId, lineNum, collectedNums: [...ctx.collectedNums], added: db.numerosBase });
        }
        if (tieneParleLocal || tieneCandadoLocal) {
          // Actualizar snapshot para PARLE_GLOBAL posterior.
          ctx.lastParleNums = [...ctx.collectedNums];
        }

        // Acumular jugadas fijo/corrido para posible centena global posterior
        for (const op of ops) {
          if (op.tipo === 'fijo' || op.tipo === 'corrido') {
            ctx.jugadasBase.push({ numeros: op.numeros.slice(), montoUnitario: op.montoUnitario, tipo: op.tipo });
          }
        }
        break;

      // ── CENTENA GLOBAL ─────────────────────────────────────────────────────
      case OpKind.CENTENA_GLOBAL: {
        // lineaExp format: "<centenas>:<monto>"
        // centenas = 'ALL' | comma-separated digits e.g. '3,5'
        // monto    = numeric string or '' (empty = inherit from jugadas base)
        const [cgSpec, cgMontoStr] = lineaExp.includes(':')
          ? [lineaExp.slice(0, lineaExp.lastIndexOf(':')), lineaExp.slice(lineaExp.lastIndexOf(':') + 1)]
          : [lineaExp, ''];
        const cgMonto = cgMontoStr ? parseFloat(cgMontoStr.replace(',', '.')) : null;
        trace('ENGINE_CENTENA_GLOBAL_ENTER', { id: tokenId, lineNum, spec: cgSpec, monto: cgMonto, jugadasBase: [...ctx.jugadasBase] });
        if (ctx.jugadasBase.length === 0) {
          const warn = {
            code: 'W_CENTENA_GLOBAL_SIN_BASE',
            line: lineNum,
            message: 'Centena global ignorada: no hay números base en el bloque.',
          };
          trace('ERROR', { id: tokenId, ...warn });
          errors.push(warn);
          hasError = true;
          continue;
        }
        ops = buildOpsCentenaGlobal(cgSpec, ctx.jugadasBase, cgMonto);
        trace('ENGINE_CENTENA_GLOBAL_OPS', { id: tokenId, lineNum, ops });
        if (!ops.length) {
          const warn = {
            code: 'W_CENTENA_GLOBAL_SIN_OPS',
            line: lineNum,
            message: 'Centena global no generó operaciones (todos los números tienen > 2 dígitos).',
          };
          trace('ERROR', { id: tokenId, ...warn });
          errors.push(warn);
          hasError = true;
          continue;
        }
        // No resetear contexto: la centena global no cierra el bloque.
        break;
      }

      default:
        trace('ERROR', {
          id: tokenId,
          code: 'E_UNKNOWN_OPKIND',
          line: lineNum,
          message: `OpKind "${opKind}" desconocido.`,
          token,
        });
        errors.push({ code: 'E_UNKNOWN_OPKIND', line: lineNum, message: `OpKind "${opKind}" desconocido.` });
        hasError = true;
        ctx.reset('OpKind desconocido');
        continue;
    }

    // ── EVALUAR OPS ────────────────────────────────────────────────────────
    for (const op of ops) {
      trace('EVAL_OPERATION', { id: tokenId, lineNum, op });
      const r = evaluarOperacion(op);
      trace('EVAL_RESULT', { id: tokenId, lineNum, resultado: r });
      total    += r.monto;
      detalles += detalleLineaTexto(r);
      jugadasDetalle.push({
        tipo: r.tipo, numeros: r.numeros, pares: r.pares,
        combinaciones: r.combinaciones, monto: r.monto,
        monto_unitario: r.monto_unitario, linea: lineNum,
      });
      stats.validOps++;
    }
    if (ops.length) detalles += '\n';
  }

  // ── Sync totalComputed into stats before returning ─────────────────────
  stats.totalComputed = total;

  const { totalDeclarado } = bloque;
  const diff = totalDeclarado !== null ? total - totalDeclarado : null;
  const diffSig = diff !== null && Math.abs(diff) > 0.01;

  if (diffSig) {
    // Emit structured TOTAL_MISMATCH so AUDIT can compare declarado vs computed.
    trace('ERROR', {
      code:            'TOTAL_MISMATCH',
      jugador:         bloque.nombre,
      totalComputed:   total,
      totalDeclarado,
      diff,
      message:         `Total declarado (${totalDeclarado.toFixed(2)}) ≠ total calculado (${total.toFixed(2)}). Diferencia: ${diff.toFixed(2)}.`,
    });
  }

  if (diff === null || diffSig) {
    detalles += `TOTAL: ${total.toFixed(2)}`;
    if (totalDeclarado !== null)
      detalles += ` | DECLARADO: ${totalDeclarado.toFixed(2)} | DIF: ${diff.toFixed(2)}${Math.abs(diff) > 0.01 ? ' ⚠️' : ' ✅'}`;
    detalles += '\n\n';
  } else {
    detalles = '';
  }

  const bloqueHasError = hasError || errors.length > 0;
  if (bloqueHasError) {
    const errSummary = errors.map(e => `⚠ ERROR línea ${e.line}: ${e.message}`).join('\n');
    detalles = `=== JUGADOR: ${bloque.nombre} ===\n\n⛔ ERRORES (corrija antes de guardar):\n${errSummary}\n`;
  }

  trace('ENGINE_TOKEN', {
    stage: 'procesarBloque:fin',
    nombre: bloque.nombre,
    total,
    hasError: bloqueHasError,
    totalErrores: errors.length,
    errors,
  });

  return {
    total:          bloqueHasError ? 0 : total,
    jugadasDetalle: bloqueHasError ? [] : jugadasDetalle,
    errors,
    detalleTexto:   detalles,
    hasError:       bloqueHasError,
    stats,          // ENGINE_STATS para este bloque
  };
}

function serializeJugadaLines(jugadaLines) {
  const lines = (jugadaLines || [])
    .map(line => {
      if (typeof line !== 'string') return null;
      if (line.startsWith('\x00CENTENA_GLOBAL\x00')) {
        const spec  = line.slice('\x00CENTENA_GLOBAL\x00'.length).replace(/\x00$/, '');
        const colon = spec.indexOf(':');
        const nums  = colon === -1 ? spec : spec.slice(0, colon);
        const monto = colon === -1 ? ''   : spec.slice(colon + 1).trim();
        const xcNums = (nums && nums !== 'ALL')
          ? ' ' + nums.split(',').map(n => n.trim()).filter(Boolean).join(' ')
          : '';
        return 'xc' + xcNums + (monto ? ' con ' + monto : '');
      }
      // BLANK_SEP -> linea vacia real (preservar salto de linea del usuario)
      if (line === '\x00BLANK_SEP\x00') return '';
      // Otros tokens internos -> eliminar sin dejar linea
      if (line.startsWith('\x00')) return null;
      return line;
    })
    .filter(l => l !== null);
  // Colapsar mas de 2 lineas vacias consecutivas (max 1 linea en blanco entre jugadas)
  const result = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

function calcular(ctx, deps) {
  resetTraceId();
  const { rawInput, loteriaId, sorteoId } = ctx;

  trace('INPUT_START', { rawInput, loteriaId, sorteoId });

  if (!loteriaId || !sorteoId)
    return { ok: false, error: 'MISSING_LOTERIA_SORTEO', message: 'Seleccione Lotería y Sorteo.', totalGeneral: 0, jugadas: [], detalleTexto: '', errors: [], bloques: [] };
  if (!rawInput || !rawInput.trim())
    return { ok: false, error: 'EMPTY_INPUT', message: 'Ingrese una jugada.', totalGeneral: 0, jugadas: [], detalleTexto: '', errors: [], bloques: [] };

  const { errors: parseErrors, bloques, audit } = parsearInput(rawInput, deps);

  // ── NO_BET_LOSS_GUARANTEE: separar errores críticos de warnings de auditoría ──
  // AUDIT_MISSING_CANDIDATES es CRÍTICO — abortar (candidato sin estado = pérdida).
  // FLAGGED items son warnings — continuar el engine pero incluirlos en el resultado.
  const criticalErrors = parseErrors.filter(e => e.code === 'AUDIT_MISSING_CANDIDATES');
  const flaggedWarnings = parseErrors.filter(e => e.status === 'FLAGGED');
  const otherErrors    = parseErrors.filter(e => e.code !== 'AUDIT_MISSING_CANDIDATES' && e.status !== 'FLAGGED');

  if (criticalErrors.length || otherErrors.length) {
    return {
      ok: false,
      error: 'PARSE_ERROR',
      totalGeneral: 0,
      jugadas: [],
      detalleTexto: '',
      errors: [...criticalErrors, ...otherErrors],
      flaggedWarnings,
      bloques: [],
      audit,
    };
  }

  if (!bloques.length)
    return { ok: false, error: 'NO_BLOQUES', message: 'No se detectaron bloques.', totalGeneral: 0, jugadas: [], detalleTexto: '', errors: [], flaggedWarnings, bloques: [], audit };

  let totalGeneral = 0, detalleTexto = '';
  const jugadas = [];
  const hayJugadasSinNombre = bloques.some(b => b.sinNombre);

  // ── ENGINE_STATS acumulado (fuente de verdad estadística) ─────────────────
  const engineStats = {
    processedLines: 0,   // total de tokens OPERATION intentados en todos los bloques
    validOps:       0,   // ops generadas y evaluadas sin error
    errorLines:     0,   // tokens con error de validación o runtime
    skippedTokens:  0,   // SEPARATOR / JOINED / IGNORE / INVALID
    totalComputed:  0,   // suma de montos evaluados (todos los bloques)
    totalBloques:   0,   // cantidad de bloques procesados
  };

  // Encabezado de alertas de auditoría (jugadas flaggeadas)
  if (flaggedWarnings.length) {
    detalleTexto += `\n${'='.repeat(70)}\n⚠️ ALERTA: ${flaggedWarnings.length} JUGADA(S) REQUIEREN REVISIÓN\n${'='.repeat(70)}\n`;
    for (const w of flaggedWarnings) {
      detalleTexto += `  • Línea ${w.line}: ${w.reason}`;
      if (w.raw) detalleTexto += ` (original: "${w.raw}")`;
      detalleTexto += '\n';
    }
    detalleTexto += '\n';
  }

  if (hayJugadasSinNombre)
    detalleTexto += `\n${'='.repeat(70)}\n⚠️ ALERTA: JUGADAS SIN NOMBRE DETECTADAS\n${'='.repeat(70)}\n\n`;

  const timestamp = typeof deps.obtenerTimestampLocal === 'function'
    ? deps.obtenerTimestampLocal()
    : new Date().toISOString();

  bloques.forEach(bloque => {
    const r = procesarBloque(bloque, deps);
    totalGeneral += r.total;
    detalleTexto += r.detalleTexto;

    // Accumulate ENGINE_STATS
    if (r.stats) {
      engineStats.processedLines += r.stats.processedLines;
      engineStats.validOps       += r.stats.validOps;
      engineStats.errorLines     += r.stats.errorLines;
      engineStats.skippedTokens  += r.stats.skippedTokens;
      engineStats.totalComputed  += r.stats.totalComputed;
      engineStats.totalBloques++;
    }

    jugadas.push({
      jugador_nombre: bloque.nombre, loteria_id: loteriaId, sorteo_id: sorteoId,
      jugada_texto: serializeJugadaLines(bloque.jugadaLines),
      jugada_original: serializeJugadaLines(bloque.jugadaLines),
      monto_total: r.total, jugadas_detalle: r.jugadasDetalle,
      total_declarado: bloque.totalDeclarado,
      es_valido: bloque.totalDeclarado !== null ? Math.abs(r.total - bloque.totalDeclarado) < 0.01 : !r.hasError,
      tiene_error: r.hasError, sin_nombre: bloque.sinNombre === true,
      estructura_db: { raw: serializeJugadaLines(bloque.jugadaLines), detalles: r.jugadasDetalle, timestamp },
    });
  });

  trace('ENGINE_STATS', { engineStats });
  trace('FINAL_RESULT', { totalGeneral, totalJugadas: jugadas.length, jugadas, engineStats, audit });

  // ── AUDIT: engine vs PRE — comparar lo que el engine procesó contra lo que
  // el preprocesador declaró como aceptado. Son capas distintas y pueden divergir
  // si hay bugs de wiring o tokens que el classifier descarta silenciosamente.
  if (audit) {
    const preAccepted = (audit.acceptedCount ?? 0) + (audit.recoveredCount ?? 0);
    if (engineStats.processedLines !== preAccepted) {
      trace('ERROR', {
        code:    'ENGINE_PRE_MISMATCH',
        message: `Engine procesó ${engineStats.processedLines} línea(s) como OPERATION pero PRE declaró ${preAccepted} aceptadas.`,
        engineProcessedLines: engineStats.processedLines,
        preAccepted,
        diff: engineStats.processedLines - preAccepted,
      });
    }
  }

  return {
    ok: true,
    totalGeneral,
    jugadas,
    detalleTexto,
    errors: [],
    flaggedWarnings,   // jugadas que requieren revisión humana
    bloques,
    hayJugadasSinNombre,
    audit,             // resumen completo de auditoría
    engineStats,       // fuente de verdad estadística del engine
  };
}

// ─────────────────────────────────────────────────────────────────
// EXPOSE GLOBALS
// ─────────────────────────────────────────────────────────────────
global.Tracer        = { trace, enableTrace, disableTrace, setTraceFilter, resetTraceId, nextId, exposeTraceControls };
global.Expansion     = createExpansion();
global.Evaluator     = { buildLineaDB, validarLinea, buildOpsNormal, buildOpsCentena, buildOpsParleGlobal, buildOpsCandadoGlobal, buildOpsCentenaGlobal, evaluarOperacion, detalleLineaTexto, pad2, pad3, comb2, generarPares, repartirExacto, detectarOperadorMalEscrito, levenshtein, clasificarTokens, validarEstructuraTokens };
global.Classifier    = { clasificarLinea, clasificarBloque, LineType, OpKind };
global.Parser        = { parsearInput, parsearBloques, joinNumberLines, TYPO_PATTERNS };
global.Preprocesador = { preprocesarJugada, procesarLineaRaw, stripWhatsAppMeta, limpiarLineaAuto };
global.Utils         = { limpiarMonto };
global.Engine        = { calcular, procesarBloque, serializeJugadaLines };
global.BetAuditLedger = { createBetAuditLedger, esLineaCandidato, detectarLineaHuerfana, mapearRazonFlag };
global.RightSideSanitizer = { sanitizarLadoDerecho, aplicarRightSideRule, limpiarLadoDerecho, validarPatronLadoDerecho };
global.IntentSegmenter    = IntentSegmenter;

if (typeof exposeTraceControls === 'function') exposeTraceControls();

})(typeof window !== 'undefined' ? window : globalThis);
