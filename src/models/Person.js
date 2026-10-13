import mongoose from 'mongoose';
import { normalizeText } from './Book.js';

/**
 * Pessoa que pega livros emprestados.
 *
 * QUEM E QUEM (identidade): o registro da pessoa e a identidade - o _id no
 * banco e, na tela, o numero curto "code" (#1, #2, #3...). Nunca o nome nem o
 * telefone: os dois podem repetir e podem mudar. Isso resolve os tres casos do
 * dia a dia:
 *
 * - A pessoa trocou de numero: edite o telefone dela aqui (tela Usuarios).
 *   Continua sendo a mesma pessoa, com o mesmo historico; o novo numero passa
 *   a valer tambem nos emprestimos que ela tem em andamento.
 * - Dois nomes iguais (duas "Maria Silva"): sao dois registros diferentes. Ao
 *   cadastrar a segunda, o sistema avisa que o nome ja existe e pergunta se e
 *   a mesma pessoa; confirmando, cria um registro separado. Nas listas elas
 *   aparecem com o telefone do lado, que e o que as diferencia na pratica.
 * - Mesmo numero para duas pessoas (familia que compartilha o WhatsApp): o
 *   sistema avisa de quem e o numero e deixa confirmar. Quem recebe o aviso
 *   de devolucao e o dono do aparelho, com o nome de quem pegou na mensagem.
 */
const personSchema = new mongoose.Schema(
  {
    // Numero curto que aparece na tela (#1, #2...). Vem do contador "person"
    // (ver services/people.js) e nunca muda, nem e reaproveitado quando
    // alguem e excluido: e assim que duas "Maria Silva" se diferenciam.
    // "sparse" deixa o indice ignorar registros antigos que ainda nao tenham
    // numero - o servidor numera todos ao iniciar (backfillPersonCodes).
    code: { type: Number, unique: true, sparse: true },
    fullName: { type: String, required: true, trim: true },
    nameSort: { type: String, index: true },
    phone: { type: String, default: '', index: true },
    loansCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

personSchema.pre('save', function setNameSort(next) {
  this.nameSort = normalizeText(this.fullName);
  next();
});

// Mesmo cuidado quando a pessoa e editada por updateOne/findOneAndUpdate:
// sem isso o nameSort (usado na busca e na ordenacao) ficaria com o nome velho.
personSchema.pre(['findOneAndUpdate', 'updateOne'], function setNameSortOnUpdate(next) {
  const update = this.getUpdate() || {};
  const fullName = update.fullName ?? update.$set?.fullName;
  if (fullName) this.set('nameSort', normalizeText(fullName));
  next();
});

export default mongoose.model('Person', personSchema);
