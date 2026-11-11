import mongoose from 'mongoose';

const loanSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true },

    // Copias dos dados no momento do emprestimo: mesmo se o livro for editado
    // ou excluido depois, o historico continua fazendo sentido.
    bookTitle: { type: String, required: true },
    bookCover: { type: String, default: '' },
    bookIsbn: { type: String, default: '' },
    bookTitleSort: { type: String, index: true },
    personName: { type: String, required: true },
    personNameSort: { type: String, index: true },
    // Numero visivel de quem pegou o livro (#3). Guardado junto, como o nome:
    // e o que diferencia duas pessoas de nome igual na lista.
    personCode: { type: Number, default: null },
    // WhatsApp (opcional): so digitos com DDI, ex. 5583999998888.
    // Vazio = sem WhatsApp cadastrado, e o botao de aviso nao aparece.
    personPhone: { type: String, default: '' },
    // Marcam quando o administrador abriu o WhatsApp para avisar.
    // reminderSentAt e do aviso "a vencer", que o painel nao oferece mais
    // (fica para os registros antigos).
    reminderSentAt: { type: Date, default: null },
    // COBRANCA de atraso: a ultima vez que alguem abriu o WhatsApp para
    // cobrar, e quem foi. So pode haver uma a cada 30 dias (ver
    // CHARGE_INTERVAL_DAYS em routes/loans.js).
    overdueSentAt: { type: Date, default: null },
    overdueSentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
    },
    overdueSentByName: { type: String, default: '' },
    // AVISO AUTOMATICO de atraso pelo WhatsApp (services/whatsapp/overdue.js):
    // para qual prazo ja foi mandado (um aviso por prazo vencido) e quando.
    overdueAutoFor: { type: Date, default: null },
    overdueAutoAt: { type: Date, default: null },

    // Prazos estendidos, do mais antigo ao mais novo: de que data (from) para
    // qual (to), quando e por quem. dueDate ja e sempre o prazo de agora.
    dueExtensions: {
      type: [
        {
          _id: false,
          from: { type: Date, default: null },
          to: { type: Date, required: true },
          at: { type: Date, required: true },
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
          byName: { type: String, default: '' },
          // "whatsapp": a propria pessoa estendeu pelo atendimento automatico.
          via: { type: String, default: '' },
        },
      ],
      default: [],
    },

    // QUEM APROVOU: o administrador que registrou o emprestimo. Guarda o
    // nome junto (como faz com o do livro e com o de quem pegou) para o
    // historico continuar legivel mesmo que a pessoa deixe de ser
    // administradora, troque de nome ou saia do cadastro.
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
    },
    approvedByName: { type: String, default: '' },

    startDate: { type: Date, required: true },
    dueDate: { type: Date, default: null },
    // TTL index: o MongoDB apaga o documento sozinho 5 dias depois do valor
    // deste campo. Enquanto o emprestimo esta ativo, returnedAt fica null
    // (null nao e uma data, entao o TTL ignora o documento e ele nunca expira).
    // So passa a contar a partir do momento em que a devolucao e confirmada.
    returnedAt: {
      type: Date,
      default: null,
      index: { expireAfterSeconds: 5 * 24 * 60 * 60 },
    },

    status: {
      type: String,
      enum: ['ativo', 'devolvido'],
      default: 'ativo',
      index: true,
    },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('Loan', loanSchema);
