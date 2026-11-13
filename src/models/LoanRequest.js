import mongoose from 'mongoose';

/**
 * SOLICITACAO DE EMPRESTIMO. Nasce de dois jeitos e passa por tres situacoes
 * ("status"):
 *
 * - "pendente": a pessoa tocou em "Solicitar empréstimo" no acervo publico
 *   (/catalogo), digitou o nome e o dia de preferencia, e o app abriu o
 *   WhatsApp da biblioteca com uma mensagem pronta e um LINK no fim
 *   (/solicitacao/<token>). Ainda nao e uma solicitacao de verdade: NAO
 *   segura exemplar nenhum (o livro continua "disponivel"), porque a
 *   retirada ainda nao foi combinada. Serve so para o link abrir o painel ja
 *   com o livro, o nome e a data preenchidos. Some sozinha (TTL) se ninguem
 *   usar o link.
 * - "solicitado": um administrador combinou a retirada pelo WhatsApp e
 *   registrou a solicitacao (pelo link ou na mao, em Empréstimos). A partir
 *   daqui ela SEGURA UM EXEMPLAR para essa pessoa: nao da para outra pessoa
 *   solicitar nem levar emprestado esse exemplar (ver services/occupancy.js).
 * - "convertendo": um instante so, enquanto o administrador efetua o
 *   emprestimo (ver routes/requests.js). Continua segurando o exemplar.
 *
 * Virou emprestimo ou foi excluida: o registro sai do banco (o emprestimo
 * passa a contar a historia dali em diante).
 *
 * Como no emprestimo, o titulo/capa do livro e o nome de quem pediu ficam
 * copiados aqui, para a lista continuar legivel mesmo que o livro ou a ficha
 * mudem.
 */
const loanRequestSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true, index: true },
    bookTitle: { type: String, required: true },
    bookTitleSort: { type: String, default: '' },
    bookCover: { type: String, default: '' },
    bookIsbn: { type: String, default: '' },

    status: {
      type: String,
      enum: ['pendente', 'solicitado', 'convertendo'],
      required: true,
      index: true,
    },

    // Link da mensagem do WhatsApp. Continua aqui depois de usado, so para o
    // painel conseguir dizer "esse link ja foi usado" se alguem abrir de novo.
    token: { type: String, default: null },
    // O nome como a pessoa digitou no acervo publico (pode nao bater com o
    // cadastro: e o administrador quem escolhe a ficha certa).
    requesterName: { type: String, default: '' },
    requesterNameSort: { type: String, default: '' },
    // No acervo publico a pessoa pode tocar no proprio nome (busca no
    // cadastro) ou dizer "Nao sou nenhuma dessas pessoas" (novo cadastro).
    // So uma indicacao: quem confirma a ficha e o administrador.
    requesterPerson: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
    requesterIsNew: { type: Boolean, default: false },

    // RETIRADA PREVISTA: o dia combinado (ou, ainda pendente, o dia de
    // preferencia que a pessoa escolheu).
    pickupDate: { type: Date, required: true },

    // Quem vai levar: a ficha do cadastro, escolhida pelo administrador.
    // Vazio enquanto pendente.
    person: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null, index: true },
    personName: { type: String, default: '' },
    personNameSort: { type: String, default: '' },
    personCode: { type: Number, default: null },
    personPhone: { type: String, default: '' },

    // O administrador que registrou (sai da sessao, como no emprestimo).
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
    registeredByName: { type: String, default: '' },
    registeredAt: { type: Date, default: null },

    // WHATSAPP DA BIBLIOTECA (services/whatsapp/requestLink.js): a conversa e
    // o numero de onde a mensagem com o link chegou (so anotado, ninguem
    // responde sozinho). O sininho oferece "Abrir conversa" com ela.
    waChat: { type: mongoose.Schema.Types.ObjectId, ref: 'WaChat', default: null },
    waPhone: { type: String, default: '' },
    // (do robo, desligado em 12/11/2026: quando o administrador foi avisado
    // pelo WhatsApp. Saiu do banco - ver prepareDatabase em server.js.)
    // waNotifiedAt: { type: Date, default: null },

    // Marca do "convertendo" (ver recoverStuckConversions em routes/requests.js).
    convertingAt: { type: Date, default: null },

    // Lembrete ao entrar no painel (GET /api/requests/reminders): os
    // administradores que ja fecharam o aviso "retirada e hoje" e o aviso
    // "retirada em atraso" desta solicitacao. Cada um ve cada aviso uma vez
    // so. (Registro de antes destes campos fica sem eles: ninguem viu ainda.)
    todaySeenBy: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    lateSeenBy: { type: [mongoose.Schema.Types.ObjectId], default: undefined },

    // TTL: so a pendente tem data aqui. null nao e data, entao o MongoDB
    // ignora a registrada e ela nunca expira sozinha.
    linkExpiresAt: { type: Date, default: null, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true }
);

// Um link por token. O indice parcial ignora quem nao tem link (registro feito
// na mao), que fica com token null.
loanRequestSchema.index(
  { token: 1 },
  { unique: true, partialFilterExpression: { token: { $type: 'string' } } }
);

export default mongoose.model('LoanRequest', loanRequestSchema);
