import mongoose from 'mongoose';

/**
 * PERGUNTAS QUE O ROBO NAO SOUBE RESPONDER: o que as pessoas escreveram e
 * caiu no "Nao entendi". O painel mostra as mais repetidas, para o
 * administrador cadastrar a resposta (models/WaAnswer.js) - e assim que o
 * robo "aprende".
 *
 * Guarda so o texto (curto, sem numero de ninguem), junta as repetidas
 * (norm) e some sozinho 30 dias depois da ultima vez.
 */
const waUnknownSchema = new mongoose.Schema(
  {
    norm: { type: String, required: true, unique: true },
    text: { type: String, default: '' },
    count: { type: Number, default: 1 },
    lastAt: { type: Date, default: Date.now },
  },
  { collection: 'wa_unknowns', timestamps: true }
);

waUnknownSchema.index({ lastAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('WaUnknown', waUnknownSchema);
