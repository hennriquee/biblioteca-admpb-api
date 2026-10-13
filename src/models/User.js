import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * Conta de administrador: quem entra no painel com usuario e senha.
 *
 * O NOME E O TELEFONE NAO FICAM AQUI. Eles ficam no registro de Pessoa
 * apontado por "person": o administrador tambem e alguem que pode pegar um
 * livro emprestado, e seria confusao ter o nome dele escrito em dois lugares
 * (um poderia ser editado e o outro nao). Por isso:
 *
 * - editar o nome/telefone de um administrador edita a Pessoa dele;
 * - um emprestimo recebe o selo "admin" quando a pessoa que pegou o livro tem
 *   uma conta ligada a ela;
 * - excluir a conta de administrador NAO apaga a Pessoa: o historico de
 *   emprestimos dela continua de pe, so perde o acesso ao painel.
 *
 * A foto de perfil (redonda no app) fica no Cloudinary; "photoPublicId" e o
 * que permite apagar a antiga quando ela e trocada ou removida.
 */
const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    // Nunca guardamos a senha em texto puro, apenas o hash dela.
    passwordHash: {
      type: String,
      required: true,
    },
    person: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
      index: true,
    },
    photo: { type: String, default: '' },
    photoPublicId: { type: String, default: '' },
  },
  { timestamps: true }
);

// Gera o hash a partir da senha em texto puro.
userSchema.statics.hashPassword = async function hashPassword(plainPassword) {
  const saltRounds = 12;
  return bcrypt.hash(plainPassword, saltRounds);
};

// Compara a senha digitada com o hash salvo no banco.
userSchema.methods.checkPassword = function checkPassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

export default mongoose.model('User', userSchema);
