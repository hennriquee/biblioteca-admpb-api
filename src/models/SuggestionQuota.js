import mongoose from 'mongoose';

/**
 * Tetos diarios do "Sugerir um livro" (routes/suggestions.js): quantas
 * sugestoes e quantas fotos ja entraram hoje no acervo inteiro. Um documento
 * por teto e por dia (_id = "sugestoes:2026-10-22", "fotos:2026-10-22").
 *
 * A vaga e reservada com um $inc atomico ANTES de gravar ou enviar a foto:
 * contar e so depois gravar deixaria 45 pedidos simultaneos passarem por um
 * teto de 40. O dia e o de Brasilia. Cada documento some sozinho dois dias
 * depois (indice TTL).
 */
const suggestionQuotaSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    n: { type: Number, default: 0 },
    createdAt: {
      type: Date,
      default: Date.now,
      index: { expireAfterSeconds: 2 * 24 * 60 * 60 },
    },
  },
  { versionKey: false }
);

export default mongoose.model('SuggestionQuota', suggestionQuotaSchema);
