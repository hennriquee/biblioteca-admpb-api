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
