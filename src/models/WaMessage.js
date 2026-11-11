import mongoose from 'mongoose';

/**
 * Uma mensagem de uma conversa (ver models/WaChat.js). So o TEXTO e guardado:
 * foto, audio, documento e afins aparecem como um aviso ("Foto") e a pessoa
 * abre no celular - o painel nao baixa anexos.
 */
const waMessageSchema = new mongoose.Schema(
  {
    chat: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WaChat',
      required: true,
    },
    // Id da mensagem no WhatsApp. Com a conversa, e unico: a mesma mensagem
    // chegando duas vezes (reconexao, historico) nao duplica.
    waId: { type: String, required: true },
    fromMe: { type: Boolean, required: true },
    kind: { type: String, default: 'text' },
    text: { type: String, default: '' },
    at: { type: Date, required: true },

    // Entrega das mensagens da biblioteca: 0 erro, 1 enviando, 2 enviada,
    // 3 entregue, 4 lida, 5 ouvida. So sobe.
    status: { type: Number, default: 2 },

    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },

    // Quem enviou pelo painel. Vazio nas mensagens enviadas pelo celular.
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
    },
    sentByName: { type: String, default: '' },
    // Mensagem que o proprio sistema mandou: "bot" (atendimento automatico),
    // "overdue" (aviso de atraso) ou "handoff" (aviso ao administrador).
    auto: { type: String, default: '' },
    // Por que o WhatsApp recusou (status 0): o codigo que ele devolveu.
    errorCode: { type: String, default: '' },
    // Se foi a cobranca de atraso de um emprestimo.
    chargeLoan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      default: null,
    },
  },
  { collection: 'wa_messages', timestamps: true }
);

waMessageSchema.index({ chat: 1, waId: 1 }, { unique: true });
waMessageSchema.index({ chat: 1, at: -1 });
waMessageSchema.index({ chat: 1, updatedAt: 1 });
// Limite diario de envios (services/whatsapp/service.js): so olha as ultimas 24 h.
waMessageSchema.index({ fromMe: 1, at: -1 });
// "getMessage" do Baileys (reenvio de mensagem): acha pelo id da mensagem.
waMessageSchema.index({ waId: 1 });

export default mongoose.model('WaMessage', waMessageSchema);
