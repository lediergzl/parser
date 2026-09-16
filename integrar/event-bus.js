const { EventEmitter } = require('events');

// Bus de eventos único para todo el proceso.
// El parser de Telegram emite 'jugada:procesada' y cualquier módulo
// (WhatsApp sender, guardado en Supabase, etc.) se suscribe sin acoplarse entre sí.
class Bus extends EventEmitter {}

const bus = new Bus();
bus.setMaxListeners(20);

module.exports = bus;

/*
Forma esperada del payload de 'jugada:procesada':

{
  external_id: string,   // id único del mensaje de Telegram (para evitar duplicados)
  cliente: string,
  banca: string,
  numeros: any,          // lo que ya devuelva tu parser (lotopro-core, bet-handler, etc.)
  monto: number,
  raw_text: string,
  destino: {
    tipo: 'grupo' | 'pv',
    id: string            // '1203630xxxxx@g.us' o '58412xxxxxxx@s.whatsapp.net'
  }
}
*/
