import mongoose from 'mongoose';

/**
 * Quem JA ESCREVEU para o WhatsApp da biblioteca (opt-in) e como reage as
 * mensagens que o numero manda por conta propria (aviso de atraso).
 *
 * Fica separado de WaChat de proposito: as conversas somem do painel com as
 * mensagens temporarias (7 dias), mas "esta pessoa ja falou com a gente" tem
 * de durar - e o que separa um contato de verdade de uma "lista fria", que e
 * o que mais leva a Meta a bloquear o numero (ver services/whatsapp/policy.js).
 *
 * phone: canonico (services/whatsapp/phone.js: sem o 9 que o WhatsApp tira).
 */
const waContactSchema = new mongoose.Schema(
  {
    phone: { type: String, default: '' },
    lid: { type: String, default: '' },
    firstInboundAt: { type: Date, default: null },
    lastInboundAt: { type: Date, default: null },
    inboundCount: { type: Number, default: 0 },
    // Mensagens que o NUMERO puxou (nao respostas): a ultima e quantas.
    lastProactiveAt: { type: Date, default: null },
    proactiveCount: { type: Number, default: 0 },
    // A pessoa respondeu depois da ultima mensagem puxada pelo numero.
    answeredProactiveAt: { type: Date, default: null },
    // As ultimas mensagens puxadas pelo numero (no maximo 10).
    recentProactive: { type: [Date], default: [] },
    // A pessoa pediu para NAO receber mais avisos ("parar"): o numero nao
    // puxa mais conversa com ela (as respostas ao que ELA escrever continuam).
    // Volta com "quero voltar a receber os avisos".
    optOutAt: { type: Date, default: null },
  },
  { collection: 'wa_contacts', timestamps: true }
);

// UM registro por numero e por LID (duas mensagens ao mesmo tempo nao criam
// dois). Vazio nao conta.
waContactSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string', $gt: '' } } });
waContactSchema.index({ lid: 1 }, { unique: true, partialFilterExpression: { lid: { $type: 'string', $gt: '' } } });
waContactSchema.index({ lastProactiveAt: 1 });

export default mongoose.model('WaContact', waContactSchema);
