import mongoose from 'mongoose';

/**
 * Uma conversa do WhatsApp da biblioteca com UMA pessoa (grupos, status e
 * canais nao entram).
 *
 * "key" e quem a conversa e: o telefone SEM o 9 de celular que o WhatsApp as
 * vezes tira (ver services/whatsapp/phone.js), para 5534997885466 e
 * 553497885466 serem a mesma conversa. Quando o WhatsApp so informa o "LID"
 * (um codigo no lugar do numero) e o numero ainda nao e conhecido, a chave e
 * "lid:<codigo>" - e a conversa passa para a chave do numero assim que ele
 * aparecer.
 *
 * A ficha da pessoa (Person) NAO e guardada aqui: e achada pelo telefone na
 * hora de mostrar, para a conversa acompanhar quem troca de numero ou de nome.
 */
const waChatSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    // Numero como o WhatsApp informou (so digitos com DDI). Vazio = so LID.
    phone: { type: String, default: '' },
    // Enderecos para ENVIAR: o do numero (@s.whatsapp.net) e/ou o LID.
    jid: { type: String, default: '' },
    lid: { type: String, default: '', index: true },
    // Quando o WhatsApp confirmou que o numero existe (onWhatsApp) e em qual
    // endereco: evita perguntar a cada envio.
    checkedAt: { type: Date, default: null },
    // Nome que a pessoa usa no WhatsApp (so quando ela nao esta no cadastro).
    pushName: { type: String, default: '' },
    // O mesmo nome sem acento/maiuscula, para a busca.
    pushNameSort: { type: String, default: '' },

    lastMessageAt: { type: Date, default: null, index: true },
    lastMessageText: { type: String, default: '' },
    lastMessageKind: { type: String, default: 'text' },
    lastMessageFromMe: { type: Boolean, default: false },

    // Mensagens recebidas que nenhum administrador abriu ainda (compartilhado:
    // abrir a conversa zera para todos).
    unread: { type: Number, default: 0 },
    readAt: { type: Date, default: null },

    // ---- ATENDIMENTO AUTOMATICO (robo), DESLIGADO em 12/11/2026 ----
    // Os campos abaixo eram do robo (services/whatsapp/bot.js, comentado) e
    // SAIRAM DO BANCO: o servidor os apaga ao iniciar (ver "o robô do
    // WhatsApp" em prepareDatabase, server.js). Ficam aqui so como registro.
    // mode: { type: String, enum: ['bot', 'human'], default: 'bot' },
    // humanUntil: { type: Date, default: null },
    // handoffAt: { type: Date, default: null, index: true },
    // handoffReason: { type: String, default: '' },
    // requestDayAt: { type: Date, default: null },
    // requestDayCount: { type: Number, default: 0 },
    // lastRequestKey: { type: String, default: '' },
    // lastRequestAt: { type: Date, default: null },
    // botStep: { type: String, default: '' },
    // botData: { type: mongoose.Schema.Types.Mixed, default: null },
    // botAt: { type: Date, default: null },
    // botWindowAt: { type: Date, default: null },
    // botWindowCount: { type: Number, default: 0 },
    // botDayAt: { type: Date, default: null },
    // botDayCount: { type: Number, default: 0 },
    // botMutedUntil: { type: Date, default: null },
    // botMisses: { type: Number, default: 0 },
    // botClosedAt: { type: Date, default: null },
    // botLastIn: { type: String, default: '' },
    // botLastInAt: { type: Date, default: null },
    // botLastInCount: { type: Number, default: 0 },

    // MENSAGENS TEMPORARIAS: o temporizador desta conversa no WhatsApp, em
    // segundos (0 = desligado; null = ainda nao se sabe), aprendido das
    // mensagens dela, e a hora da mensagem de onde veio (so uma mais nova
    // troca). O painel e o robo enviam com ele, para as mensagens deles
    // sumirem do celular junto com as outras.
    ephemeral: { type: Number, default: null },
    ephemeralAt: { type: Date, default: null },
  },
  { collection: 'wa_chats', timestamps: true }
);

export default mongoose.model('WaChat', waChatSchema);
