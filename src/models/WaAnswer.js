import mongoose from 'mongoose';

/**
 * RESPOSTAS CADASTRADAS do atendimento automatico do WhatsApp (a "base de
 * conhecimento" do robo): o administrador ensina, no painel, o que responder
 * quando a mensagem tiver certas palavras-chave ("horario", "onde fica").
 *
 * - keywords: palavras ou expressoes (sem acento/maiuscula). Uma expressao
 *   ("que horas abre") vale quando TODAS as palavras dela aparecem na
 *   mensagem; plural e um erro de digitacao sao tolerados
 *   (services/whatsapp/intents.js).
 * - answers: de 1 a 5 jeitos de dizer a MESMA coisa; o robo sorteia (texto
 *   sempre igual para todo mundo e um dos sinais que o WhatsApp usa para
 *   desconfiar de automacao).
 */
const waAnswerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    keywords: { type: [String], default: [] },
    answers: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    // Quantas vezes o robo usou esta resposta, e a ultima.
    hits: { type: Number, default: 0 },
    lastHitAt: { type: Date, default: null },
    updatedByName: { type: String, default: '' },
  },
  { collection: 'wa_answers', timestamps: true }
);

export default mongoose.model('WaAnswer', waAnswerSchema);
