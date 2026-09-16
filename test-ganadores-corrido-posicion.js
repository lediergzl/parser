const assert = require('node:assert/strict');
const { obtenerGanadores } = require('./ganadores');

const baseBet = (detalle) => ({
  id: 9001,
  total_apuesta: 2,
  detalle: JSON.stringify(detalle),
});

// Pick 4 6868 => two corridos at the same number, but different positions.
const resultado = {
  loteria_id: 1,
  sorteo_id: 1,
  fecha: '2026-09-16',
  numero_ganado: {
    fijo: '68',
    corrido: ['68', '68'],
    centena: '168',
  },
};

const ganadores = obtenerGanadores([
  baseBet([{ tipo: 'corrido', numeros: ['68'], monto: 1, monto_unitario: 1 }]),
], resultado);

assert.equal(ganadores.length, 2, '6868 debe producir dos ganadores de corrido');
assert.deepEqual(
  ganadores.map(g => g.posicion_resultado).sort((a, b) => a - b),
  [1, 2]
);
assert.deepEqual(
  ganadores.map(g => g.numeros_ganadores),
  ['68', '68']
);
assert.deepEqual(
  ganadores.map(g => g.monto_premio),
  [30, 30]
);

// Duplicar el mismo número dentro de una apuesta no debe duplicar el premio
// para una misma posición: los importes se consolidan por posición.
const duplicado = obtenerGanadores([
  baseBet([
    { tipo: 'corrido', numeros: ['68'], monto: 1, monto_unitario: 1 },
    { tipo: 'corrido', numeros: ['68'], monto: 1, monto_unitario: 1 },
  ]),
], resultado);

assert.equal(duplicado.length, 2);
assert.deepEqual(duplicado.map(g => g.monto_premio), [60, 60]);

console.log('OK: corrido por posición, incluido 6868 => 68/68, funciona correctamente.');
