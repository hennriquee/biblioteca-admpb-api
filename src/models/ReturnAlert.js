import mongoose from 'mongoose';

/**
 * "Avise-me quando voltar" do acervo publico (/catalogo): um pedido de aviso
 * de UM aparelho para UM livro que esta todo emprestado.
 *
 * Nao ha nome, e-mail, telefone nem login aqui. O aparelho e identificado so
 * pela "inscricao" de notificacao que o proprio navegador cria (Web Push):
 * um endereco do servico de notificacao do fabricante (Google, Apple,
 * Mozilla, Microsoft) e duas chaves para cifrar a mensagem. Quem conhece o
 * endereco e o proprio aparelho - por isso e ele que serve de "senha" para
 * consultar e cancelar o pedido (ver routes/alerts.js).
 *
 * O pedido vale para UMA devolucao: quando o livro volta para a estante, o
 * aviso e enviado e o pedido sai do banco (ver services/returnAlerts.js). Se o
 * servico do fabricante falhar, o pedido fica para uma nova tentativa.
 */
const returnAlertSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true },
    // Titulo como a pessoa o viu na tela (ja no padrao de escrita do app),
    // so para o texto da notificacao. Vai apenas para o proprio aparelho que
    // pediu o aviso; sem ele, vale o titulo do cadastro.
    bookTitle: { type: String, default: '' },
    endpoint: { type: String, required: true, index: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    // Marca de "enviando agora": so quem marcou manda a notificacao (duas
    // devolucoes ao mesmo tempo nao avisam duas vezes). Marca velha, de um
    // envio que o servidor nao terminou (caiu, dormiu), pode ser tomada de
    // novo. null = esperando o livro voltar.
    sendingAt: { type: Date, default: null },
    // Quantas vezes o envio falhou de forma passageira (servico do fabricante
    // fora do ar). Depois de algumas, o pedido e descartado - um endereco que
    // nunca responde nao pode ficar no banco para sempre.
    failures: { type: Number, default: 0 },
    // TTL index: pedido que nunca foi atendido (livro que ficou meses fora,
    // aparelho trocado) some sozinho depois de 120 dias, para a colecao nao
    // crescer sem limite.
    createdAt: {
      type: Date,
      default: Date.now,
      index: { expireAfterSeconds: 120 * 24 * 60 * 60 },
    },
  },
  { versionKey: false }
);

// Um pedido por aparelho e por livro: tocar duas vezes no botao (ou em duas
// abas) nao manda dois avisos.
returnAlertSchema.index({ book: 1, endpoint: 1 }, { unique: true });

export default mongoose.model('ReturnAlert', returnAlertSchema);
