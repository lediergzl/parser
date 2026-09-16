// ============================================================================
// ganadores.js — Obtención pura de jugadas ganadoras.
//
// La BD recibe jugadas en formato CANÓNICO:
//   fijo, corrido, centena, parle
//
// El parser/registro es quien transforma:
//   candado / candado_global / candado_combinaciones -> parle
//   parle_global -> parle
//   centena_global -> centena
//
// Por eso este módulo NO interpreta candado ni global. Solo lee las
// combinaciones que ya fueron normalizadas y almacenadas en bets.detalle.
// No modifica bets, saldos ni resultados_sorteo.
// ============================================================================

const TIPOS_FIJO = new Set(['fijo', 'rango']);
const TIPOS_CENTENA = new Set(['centena']);
const TIPOS_PARLE = new Set(['parle']);

const PAYOUT_MULTIPLIERS = {
  fijo: 80,
  rango: 80,
  corrido: 30,
  centena: 500,
  parle: 1000,
};

function normalizarNumero(numero, longitud = 2) {
  if (numero === null || numero === undefined || numero === '') return null;
  return String(numero).trim().padStart(longitud, '0');
}

function normalizarNumeros(valor) {
  if (Array.isArray(valor)) return valor.map(v => String(v).trim()).filter(Boolean);
  if (valor === null || valor === undefined || valor === '') return [];
  return String(valor).split(',').map(v => v.trim()).filter(Boolean);
}

function clavePar(a, b) {
  const aa = normalizarNumero(a);
  const bb = normalizarNumero(b);
  if (!aa || !bb) return null;
  return [aa, bb].sort().join('-');
}

function obtenerParesGanadores(numeroGanado = {}) {
  const fijo = normalizarNumero(numeroGanado.fijo);
  const corrido = normalizarNumero(numeroGanado.corrido);
  const centena = numeroGanado.centena ? String(numeroGanado.centena).padStart(3, '0') : null;
  const centenaCorta = centena ? centena.slice(-2) : null;
  const valores = [fijo, corrido, centenaCorta].filter(Boolean);
  const pares = new Set();

  for (let i = 0; i < valores.length; i++) {
    for (let j = i + 1; j < valores.length; j++) {
      const par = clavePar(valores[i], valores[j]);
      if (par) pares.add(par);
    }
  }
  return pares;
}

function parsearDetalle(bet) {
  if (!bet) return [];
  if (Array.isArray(bet.detalle)) return bet.detalle;
  if (bet.detalle && typeof bet.detalle === 'object') return [bet.detalle];
  if (typeof bet.detalle !== 'string') return [];
  try {
    const parsed = JSON.parse(bet.detalle);
    return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch (_) {
    return [];
  }
}

function obtenerParesDetalle(detalle) {
  const pares = [];
  const origen = Array.isArray(detalle?.pares) ? detalle.pares : [];

  for (const p of origen) {
    if (Array.isArray(p) && p.length >= 2) {
      const clave = clavePar(p[0], p[1]);
      if (clave) pares.push(clave);
      continue;
    }

    if (typeof p === 'string') {
      const partes = p.split(/[-xX*]/).map(x => x.trim()).filter(Boolean);
      if (partes.length >= 2) {
        const clave = clavePar(partes[0], partes[1]);
        if (clave) pares.push(clave);
      }
    }
  }

  // Compatibilidad con registros que guardaron las parejas en
  // `combinaciones` en vez de `pares`.
  if (!pares.length) {
    for (const valor of normalizarNumeros(detalle?.combinaciones)) {
      const m = valor.match(/^(\d{2})[-xX*](\d{2})$/);
      if (!m) continue;
      const clave = clavePar(m[1], m[2]);
      if (clave) pares.push(clave);
    }
  }

  return [...new Set(pares)];
}

function calcularPremio(montoUnitario, tipo) {
  const multiplicador = PAYOUT_MULTIPLIERS[tipo] ?? null;
  if (multiplicador === null) return null;
  return +(Number(montoUnitario || 0) * multiplicador).toFixed(2);
}

/**
 * Obtiene todas las jugadas ganadoras para un resultado.
 *
 * El resultado esperado tiene:
 *   numero_ganado: { fijo, corrido, centena }
 *
 * Las apuestas ya llegan normalizadas desde el registro. Una entrada
 * `parle` puede contener varias parejas; cada pareja ganadora genera su
 * propia entrada de premio.
 */
function obtenerGanadores(bets, resultado) {
  const numeroGanado = resultado?.numero_ganado || {};
  const fijo = normalizarNumero(numeroGanado.fijo);
  const corrido = normalizarNumero(numeroGanado.corrido);
  const centena = numeroGanado.centena ? String(numeroGanado.centena).padStart(3, '0') : null;
  const paresGanadores = obtenerParesGanadores(numeroGanado);
  const ganadores = [];

  for (const bet of Array.isArray(bets) ? bets : []) {
    const detalles = parsearDetalle(bet);

    for (let indice = 0; indice < detalles.length; indice++) {
      const d = detalles[indice] || {};
      const tipo = String(d.tipo || '').trim().toLowerCase();
      const nums = normalizarNumeros(d.numeros).map(String);
      const montoUnitario = Number(d.monto_unitario) || 0;

      if (TIPOS_FIJO.has(tipo)) {
        if (fijo && nums.includes(fijo)) {
          ganadores.push(crearGanador(bet, d, indice, tipo, fijo, montoUnitario));
        }
        continue;
      }

      if (tipo === 'corrido') {
        if (corrido && nums.includes(corrido)) {
          ganadores.push(crearGanador(bet, d, indice, tipo, corrido, montoUnitario));
        }
        continue;
      }

      if (TIPOS_CENTENA.has(tipo)) {
        if (centena && nums.includes(centena)) {
          ganadores.push(crearGanador(bet, d, indice, tipo, centena, montoUnitario));
        }
        continue;
      }

      if (TIPOS_PARLE.has(tipo)) {
        const paresJugados = obtenerParesDetalle(d);
        const vistos = new Set();

        for (const par of paresJugados) {
          if (!paresGanadores.has(par) || vistos.has(par)) continue;
          vistos.add(par);
          ganadores.push(crearGanador(bet, d, indice, 'parle', par, montoUnitario));
        }
      }
    }
  }

  return ganadores;
}

function crearGanador(bet, detalle, indiceDetalle, tipo, numeroGanador, montoUnitario) {
  return {
    bet,
    detalle,
    indice_detalle: indiceDetalle,
    tipo_jugada: tipo,
    numeros_ganadores: numeroGanador,
    monto_apostado: Number(detalle?.monto) || Number(bet?.total_apuesta) || 0,
    monto_unitario: montoUnitario,
    multiplicador: PAYOUT_MULTIPLIERS[tipo] ?? null,
    monto_premio: calcularPremio(montoUnitario, tipo),
  };
}

/**
 * Obtiene las apuestas del sorteo/fecha y devuelve directamente los ganadores.
 */
async function obtenerGanadoresDelResultado(supabase, resultado) {
  if (!supabase || !resultado?.loteria_id || !resultado?.sorteo_id || !resultado?.fecha) {
    return { ok: false, ganadores: [], error: 'Faltan loteria_id, sorteo_id o fecha del resultado.' };
  }

  const { data: bets, error } = await supabase.from('bets').select('*')
    .eq('loteria_id', resultado.loteria_id)
    .eq('sorteo_id', resultado.sorteo_id)
    .eq('fecha_apuesta', resultado.fecha);

  if (error) {
    return { ok: false, ganadores: [], error: error.message || String(error) };
  }

  return {
    ok: true,
    bets: bets || [],
    ganadores: obtenerGanadores(bets || [], resultado),
  };
}

module.exports = {
  PAYOUT_MULTIPLIERS,
  obtenerGanadores,
  obtenerGanadoresDelResultado,
  obtenerParesGanadores,
  calcularPremio,
};
