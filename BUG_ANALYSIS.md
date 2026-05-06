# 🔍 Análisis de Bugs en lotopro-core.bundle.js

## ✅ ACLARACIÓN IMPORTANTE

**NO es un bug que haya números repetidos.** En las loterias, es completamente válido que un jugador apueste al mismo número múltiples veces. Por lo tanto, `generarPares()` NO debe eliminar duplicados.

---

## 🐛 BUGS REALES IDENTIFICADOS

### Bug #1: `pad3()` No Exportado Correctamente
**Severidad:** 🔴 CRÍTICO  
**Ubicación:** Línea 505 (definición) vs Línea 4396 (exports)  
**Problema:**
```javascript
// Línea 505: Función definida
function pad3(s) { return String(s || '').padStart(3, '0'); }

// Línea 994: Usada en evaluarOperacion()
numeros: op.numeros.map(['centena','centena_global'].includes(op.tipo) ? pad3 : pad2),

// Línea 4396: NO ESTÁ EN LOS EXPORTS
global.Evaluator = { 
  buildLineaDB, validarLinea, buildOpsNormal, buildOpsCentena, 
  buildOpsParleGlobal, buildOpsCandadoGlobal, buildOpsCentenaGlobal, 
  evaluarOperacion, detalleLineaTexto, pad2, 
  // pad3 FALTA AQUÍ ❌
};
```

**Impacto:**  
- Si el tipo de operación es 'centena' o 'centena_global', se intenta usar `pad3`
- `pad3` no está en el scope global → **ReferenceError en runtime**

**Solución:**
```javascript
global.Evaluator = { 
  buildLineaDB, validarLinea, buildOpsNormal, buildOpsCentena, 
  buildOpsParleGlobal, buildOpsCandadoGlobal, buildOpsCentenaGlobal, 
  evaluarOperacion, detalleLineaTexto, pad2, pad3  // ✅ AGREGAR
};
```

---

### Bug #2: `comb2()` No Exportado
**Severidad:** 🟡 ALTO  
**Ubicación:** Línea 503 (definición) vs Línea 4396 (exports)
**Problema:**
```javascript
// Línea 503: Función definida
function comb2(n) { return n < 2 ? 0 : n * (n - 1) / 2; }

// Usada en múltiples lugares, pero NO en exports
// Si se intenta acceder desde fuera del bundle → Error
```

**Solución:**
```javascript
global.Evaluator = { 
  buildLineaDB, validarLinea, buildOpsNormal, buildOpsCentena, 
  buildOpsParleGlobal, buildOpsCandadoGlobal, buildOpsCentenaGlobal, 
  evaluarOperacion, detalleLineaTexto, pad2, pad3, comb2  // ✅ AGREGAR
};
```

---

### Bug #3: `generarPares()` No Exportado
**Severidad:** 🟡 ALTO  
**Ubicación:** Línea 506 (definición) vs Línea 4396 (exports)
**Problema:**
```javascript
function generarPares(nums) {
  const pares = [];
  for (let i = 0; i < nums.length; i++)
    for (let j = i + 1; j < nums.length; j++)
      pares.push([pad2(nums[i]), pad2(nums[j])]);
  return pares;
}

// NO ESTÁ EN EXPORTS → No accesible externamente
```

**Solución:**
```javascript
global.Evaluator = { 
  buildLineaDB, validarLinea, buildOpsNormal, buildOpsCentena, 
  buildOpsParleGlobal, buildOpsCandadoGlobal, buildOpsCentenaGlobal, 
  evaluarOperacion, detalleLineaTexto, pad2, pad3, comb2, generarPares  // ✅ AGREGAR
};
```

---

### Bug #4: Funciones Helper de `betAuditLedger.js` No Completamente Exportadas
**Severidad:** 🟡 ALTO  
**Ubicación:** Línea 4401
**Problema:**
```javascript
// Línea 4401
global.BetAuditLedger = { 
  createBetAuditLedger, 
  esLineaCandidato, 
  detectarLineaHuerfana, 
  mapearRazonFlag 
};

// Pero faltan retornar del createBetAuditLedger:
// - registerCandidate
// - accept, recover, flag
// - getEntries, getFlagged, getAccepted, getRecovered
// - audit
// - candidateCount (getter)
```

**Solución:** Asegurar que `createBetAuditLedger()` retorna todos los métodos públicos.

---

### Bug #5: `repartirExacto()` No Exportado
**Severidad:** 🟡 ALTO  
**Ubicación:** Línea 522 (definición) vs Línea 4396 (exports)
**Problema:**
```javascript
function repartirExacto(total, n) {
  const cents = Math.floor((total * 100) / n) * n;
  const real = cents / 100;
  const unit = real / n;
  const diff = +(total - real).toFixed(2);
  return { unit, real, diff };
}

// Usado internamente pero NO EXPORTADO
```

---

### Bug #6: `levenshtein()` No Exportado
**Severidad:** 🟡 ALTO  
**Ubicación:** Línea 531 (definición) vs Línea 4396 (exports)
**Problema:**
```javascript
function levenshtein(a, b) {
  // ... lógica para detectar typos ...
}

// Función de utilidad no exportada
```

---

## 📊 Resumen de Exports Faltantes

| Función | Definida | Exportada | Severidad |
|---------|----------|-----------|----------|
| `pad2` | ✅ L504 | ✅ L4396 | N/A |
| `pad3` | ✅ L505 | ❌ | 🔴 CRÍTICO |
| `comb2` | ✅ L503 | ❌ | 🟡 ALTO |
| `generarPares` | ✅ L506 | ❌ | 🟡 ALTO |
| `repartirExacto` | ✅ L522 | ❌ | 🟡 ALTO |
| `levenshtein` | ✅ L531 | ❌ | 🟡 ALTO |
| `detectarOperadorMalEscrito` | ✅ L549 | ❌ | 🟡 ALTO |
| `clasificarTokens` | ✅ L562 | ❌ | 🟡 ALTO |
| `validarEstructuraTokens` | ✅ L587 | ❌ | 🟡 ALTO |

---

## 🔧 Recomendación

**Actualizar líneas 4394-4403** para exportar todas las funciones necesarias:

```javascript
global.Tracer        = { trace, enableTrace, disableTrace, setTraceFilter, resetTraceId, nextId, exposeTraceControls };
global.Expansion     = createExpansion();
global.Evaluator     = { 
  buildLineaDB, validarLinea, buildOpsNormal, buildOpsCentena, 
  buildOpsParleGlobal, buildOpsCandadoGlobal, buildOpsCentenaGlobal, 
  evaluarOperacion, detalleLineaTexto, 
  pad2, pad3, comb2, generarPares, repartirExacto  // ✅ TODOS
};
global.Classifier    = { clasificarLinea, clasificarBloque, LineType, OpKind };
global.Parser        = { parsearInput, parsearBloques, joinNumberLines, TYPO_PATTERNS };
global.Preprocesador = { preprocesarJugada, procesarLineaRaw, stripWhatsAppMeta, limpiarLineaAuto };
global.Engine        = { calcular, procesarBloque, serializeJugadaLines };
global.BetAuditLedger = { createBetAuditLedger, esLineaCandidato, detectarLineaHuerfana, mapearRazonFlag };
global.RightSideSanitizer = { sanitizarLadoDerecho, aplicarRightSideRule, limpiarLadoDerecho, validarPatronLadoDerecho };
global.IntentSegmenter    = IntentSegmenter;
```
