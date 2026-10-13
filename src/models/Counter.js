import mongoose from 'mongoose';

/**
 * Contadores do sistema. Hoje existe um: "person", que da o numero visivel de
 * cada pessoa (#1, #2, #3...).
 *
 * Por que uma colecao so para isso: o numero precisa ser unico mesmo se duas
 * pessoas forem cadastradas no mesmo instante. O $inc do MongoDB e atomico,
 * entao cada chamada recebe um numero diferente - diferente de "contar quantas
 * pessoas existem e somar 1", que daria o mesmo numero para as duas.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export default mongoose.model('Counter', counterSchema);
