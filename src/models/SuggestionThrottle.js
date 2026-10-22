import mongoose from 'mongoose';

/**
 * Contagem de sugestoes de livro por aparelho/rede, para o limite diario de
 * routes/suggestions.js. O limite por minuto do express-rate-limit fica na
 * memoria e zera toda vez que o servidor reinicia (no Render gratuito, cada
 * vez que ele dorme e acorda); este fica no banco e vale o dia inteiro.
 *
 * Nao guarda o IP: guarda um resumo (hash) dele misturado com o segredo do
 * servidor, que nao da para reverter. E cada registro some sozinho depois de
 * 24 horas (indice TTL).
 */
const suggestionThrottleSchema = new mongoose.Schema(
  {
    who: { type: String, required: true, index: true },
    createdAt: {
      type: Date,
      default: Date.now,
      index: { expireAfterSeconds: 24 * 60 * 60 },
    },
  },
  { versionKey: false }
);

export default mongoose.model('SuggestionThrottle', suggestionThrottleSchema);
