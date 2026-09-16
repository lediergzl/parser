const { EventEmitter } = require('events');

// Bus de eventos único para todo el proceso.
// El flujo de apuestas (bet-handler.js) emite 'jugada:procesada' y cualquier
// módulo (sender de WhatsApp, marcado de entrega, etc.) se suscribe sin que
// los módulos queden acoplados entre sí.
class Bus extends EventEmitter {}

const bus = new Bus();
bus.setMaxListeners(20);

module.exports = bus;

/*
Forma esperada del payload de 'jugada:procesada':

{
  betId: number,          // id de public.bets (clave de deduplicación)
  cliente: string,        // nombre del jugador ya resuelto por el bot
  telegramId: number,
  loteriaNombre: string,
  sorteoNombre: string,
  fecha: string,          // 'YYYY-MM-DD' en hora de Cuba
  numeros: any,           // detalle ya parseado por lotopro-core
  monto: number,          // total efectivamente cobrado
  moneda: string,
  saldoDespues: number,
  rawText: string,        // texto original de la jugada, para auditoría
  destino: {
    tipo: 'grupo' | 'pv',
    id: string            // '1203630xxxxx@g.us' o '58412xxxxxxx@s.whatsapp.net'
  }
}

Y de 'jugada:enviada_wa' (lo emite el sender tras entregar el mensaje):

{ betId: number, destinoId: string }
*/
