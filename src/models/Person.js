import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { normalizeText } from './Book.js';

/**
 * Pessoa. E O UNICO REGISTRO DE GENTE DO SISTEMA: quem pega livros
 * emprestados e quem entra no painel sao a mesma coisa, a mesma ficha.
 *
 * A diferenca entre "usuario" e "administrador" e UM campo: quem tem
 * "username" (e a senha) entra no painel; quem tem username = null so pega
 * livros emprestados. E por isso que tornar alguem administrador e so dar um
 * login e uma senha a ficha que ja existe, e tirar e devolver os dois para
 * null - sem copiar nome, telefone, foto ou historico de lugar nenhum.
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
 *
 * A foto de perfil (redonda no app) fica no Cloudinary e e de TODA pessoa, nao
 * so de administrador; "photoPublicId" e o que permite apagar a antiga quando
 * ela e trocada ou removida. Sem foto, o app mostra as iniciais do nome.
 */
const personSchema = new mongoose.Schema(
  {
    // Numero curto que aparece na tela (#1, #2...). Vem do contador "person"
    // (ver services/people.js) e nunca muda, nem e reaproveitado quando
    // alguem e excluido: e assim que duas "Maria Silva" se diferenciam.
    // "sparse" deixa o indice ignorar registros antigos que ainda nao tenham
    // numero - o servidor numera todos ao iniciar (backfillPersonCodes).
    // (Aqui "sparse" basta, diferente do login mais abaixo: nada no sistema
    // grava code: null, e este indice ja existe assim no banco.)
    code: { type: Number, unique: true, sparse: true },
    fullName: { type: String, required: true, trim: true },
    nameSort: { type: String, index: true },
    phone: { type: String, default: '', index: true },
    loansCount: { type: Number, default: 0 },

    photo: { type: String, default: '' },
    photoPublicId: { type: String, default: '' },

    // ACESSO AO PAINEL. Os dois andam juntos: ou a pessoa tem login e senha
    // (e administradora), ou os dois sao null (e so usuaria da biblioteca).
    // Quem mexe nisso e so a tela de manutencao (routes/dev.js).
    username: { type: String, default: null, trim: true, lowercase: true },
    // Nunca guardamos a senha em texto puro, apenas o hash dela.
    passwordHash: { type: String, default: null },

    // Sininho do painel (ver routes/notifications.js): ate quando ESTE
    // administrador ja viu os livros sugeridos (a data de cadastro da
    // sugestao mais nova que estava na tela dele). As mais novas que isso
    // contam na bolinha vermelha. null = nunca abriu a tela: todas contam.
    suggestionsSeenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Dois logins iguais nao podem existir - mas "null" pode repetir a vontade
// (e o normal: quase todo mundo e so usuario). Um indice "sparse" nao
// resolveria: ele ignora o campo AUSENTE, e null para ele e um valor como
// outro qualquer. Por isso o indice parcial, que so olha os logins de texto.
personSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string' } } }
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

// Gera o hash a partir da senha em texto puro.
personSchema.statics.hashPassword = async function hashPassword(plainPassword) {
  const saltRounds = 12;
  return bcrypt.hash(plainPassword, saltRounds);
};

// Compara a senha digitada com o hash salvo no banco. Pessoa sem senha
// (usuaria comum) nunca entra: nao ha hash com que comparar.
personSchema.methods.checkPassword = function checkPassword(plainPassword) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plainPassword, this.passwordHash);
};

export default mongoose.model('Person', personSchema);
