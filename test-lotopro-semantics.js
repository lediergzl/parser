const assert = require('assert');

require('./lotopro-core.bundle.js');

const { Engine, Expansion, Preprocesador, Utils } = global;

function calcular(raw) {
  return Engine.calcular(
    { rawInput: raw, loteriaId: 'TEST', sorteoId: 'TEST' },
    {
      Expansion,
      limpiarMonto: Utils.limpiarMonto,
      preprocesarJugada: Preprocesador.preprocesarJugada,
    }
  );
}

function detalles(r) {
  return (r.jugadas || []).flatMap(j => j.jugadas_detalle || []);
}

function assertTotal(raw, expected) {
  const r = calcular(raw);
  assert.strictEqual(r.ok, true, `Debe ser válida: ${raw}\n${JSON.stringify(r.errors || [])}`);
  assert.ok(Math.abs(r.totalGeneral - expected) < 1e-9,
    `Total incorrecto para "${raw}": esperado ${expected}, obtenido ${r.totalGeneral}`);
  return r;
}

function assertInvalid(raw) {
  const r = calcular(raw);
  assert.notStrictEqual(r.ok, true, `Debe ser inválida: ${raw}`);
  return r;
}

// Separadores izquierdos: NO cambian la modalidad.
{
  let r = assertTotal('45-68 con 10', 20);
  assert.deepStrictEqual(detalles(r)[0].numeros, ['45', '68']);
  assert.strictEqual(detalles(r)[0].tipo, 'fijo');

  r = assertTotal('45x68 con 10', 20);
  assert.deepStrictEqual(detalles(r)[0].numeros, ['45', '68']);
  assert.strictEqual(detalles(r)[0].tipo, 'fijo');

  r = assertTotal('45x68x98 con 10', 30);
  assert.deepStrictEqual(detalles(r)[0].numeros, ['45', '68', '98']);
  assert.strictEqual(detalles(r)[0].tipo, 'fijo');
}

// x/* + pN: fijo + parle; cadena x de 3 números genera las 3 combinaciones.
{
  let r = assertTotal('45x68 con 10 p3', 23);
  assert.strictEqual(detalles(r).filter(d => d.tipo === 'parle')[0].monto_unitario, 3);

  r = assertTotal('45x68x98 con 10 p3', 39);
  const p = detalles(r).find(d => d.tipo === 'parle');
  assert.strictEqual(p.pares.length, 3);
  assert.deepStrictEqual(p.pares, [['45','68'], ['45','98'], ['68','98']]);
}

// fijo + corrido + parle.
{
  const r = assertTotal('45 68 98 con 10 y 10 p3', 69);
  assert.strictEqual(detalles(r).filter(d => d.tipo === 'fijo')[0].monto, 30);
  assert.strictEqual(detalles(r).filter(d => d.tipo === 'corrido')[0].monto, 30);
  assert.strictEqual(detalles(r).filter(d => d.tipo === 'parle')[0].monto, 9);
}

// Tres montos no se consumen silenciosamente.
assertInvalid('45 68 98 con 10 y 10 y 10 p3');

// xc: todas las centenas o centenas seleccionadas.
{
  let r = assertTotal('45 68 xc 10', 200);
  assert.strictEqual(detalles(r)[0].tipo, 'centena');
  assert.strictEqual(detalles(r)[0].numeros.length, 20);

  r = assertTotal('45 68 xc 1 2 3 10', 60);
  assert.deepStrictEqual(detalles(r)[0].numeros, ['145','168','245','268','345','368']);
}

// pr + decena.
{
  const r = assertTotal('15 pr d0 con 10', 100);
  const p = detalles(r).find(d => d.tipo === 'parle');
  assert.strictEqual(p.pares.length, 10);
  assert.deepStrictEqual(p.pares[0], ['15','00']);
  assert.deepStrictEqual(p.pares[9], ['15','09']);
}

// de/a son equivalentes a con, pero no se encadenan con con.
assertTotal('45 68 de 20', 40);
assertTotal('45 68 a 20', 40);
assertInvalid('45 68 con 10 de 20');

// Candado: mínimo 3 números.
assertInvalid('45 68 c3');
{
  const r = assertTotal('45 68 98 c10', 9.99);
  assert.strictEqual(detalles(r)[0].tipo, 'candado');
}

// Corrido puro.
{
  const r = assertTotal('25 corrido 10', 10);
  assert.strictEqual(detalles(r)[0].tipo, 'corrido');
}

console.log('OK: regresión DSL LotoPro');
