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

    // ATENDIMENTO (services/whatsapp/bot.js). "bot": o atendimento automatico
    // responde; "human": um administrador esta conversando e o robo fica quieto
    // ate humanUntil (ou ate alguem devolver a conversa ao robo no painel).
    // handoffAt: quando a pessoa pediu para falar com um administrador (vazio
    // depois que alguem responde ou devolve ao robo).
    mode: { type: String, enum: ['bot', 'human'], default: 'bot' },
    humanUntil: { type: Date, default: null },
    handoffAt: { type: Date, default: null, index: true },
    // Por que esta esperando: "admin" (pediu um administrador no menu) ou
    // "request" (mandou um pedido de emprestimo do acervo publico).
    handoffReason: { type: String, default: '' },
    // Avisos de pedido de emprestimo mandados ao administrador por esta
    // conversa nas ultimas 24 h (freio contra enxurrada) e o ultimo pedido
    // sem link (para a mesma mensagem repetida nao avisar duas vezes).
    requestDayAt: { type: Date, default: null },
    requestDayCount: { type: Number, default: 0 },
    lastRequestKey: { type: String, default: '' },
    lastRequestAt: { type: Date, default: null },
    // Onde a pessoa esta no menu do robo (step + dados do passo) e ate quando.
    botStep: { type: String, default: '' },
    botData: { type: mongoose.Schema.Types.Mixed, default: null },
    botAt: { type: Date, default: null },
    // Freio contra conversa sem fim com outro robo: respostas na janela atual.
    botWindowAt: { type: Date, default: null },
    botWindowCount: { type: Number, default: 0 },
    botDayAt: { type: Date, default: null },
    botDayCount: { type: Number, default: 0 },
    // Estourou o freio: o robo fica mudo nesta conversa ate esta hora.
    botMutedUntil: { type: Date, default: null },
  },
  { collection: 'wa_chats', timestamps: true }
);

export default mongoose.model('WaChat', waChatSchema);
