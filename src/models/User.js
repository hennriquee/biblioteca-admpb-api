import mongoose from 'mongoose';

/**
 * COLECAO ANTIGA ("users"), mantida so para a mudanca de casa.
 *
 * Antes, a conta de administrador vivia aqui e apontava para a Pessoa dela.
 * Hoje nao existe mais essa separacao: login e senha sao dois campos da
 * propria Pessoa (ver models/Person.js), e e isso que permite transformar um
 * usuario em administrador sem copiar nada de lugar nenhum.
 *
 * Este modelo so e usado por mergeLegacyAdminAccounts() (services/people.js),
 * que roda ao iniciar o servidor e leva as contas que ficaram aqui para a
 * ficha da pessoa. Cada conta levada recebe "mergedAt", para a mudanca nao
 * acontecer duas vezes e sobrescrever uma senha trocada depois. A conta que
 * NAO pudesse ser levada recebe "skippedAt" e "skipReason" - e nao
 * "mergedAt", que diria que ela foi - para o motivo ficar registrado aqui e
 * no log do servidor, em vez de o login simplesmente desaparecer.
 *
 * A colecao e deixada no banco de proposito: e a copia de seguranca da
 * mudanca. Nada no sistema le daqui para funcionar.
 */
const userSchema = new mongoose.Schema(
  {
    username: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String },
    // Nome que as contas mais antigas guardavam nelas mesmas, antes de existir
    // o registro de Pessoa.
    name: { type: String },
    person: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
    },
    photo: { type: String, default: '' },
    photoPublicId: { type: String, default: '' },
    mergedAt: { type: Date, default: null },
    skippedAt: { type: Date, default: null },
    skipReason: { type: String, default: '' },
  },
  { timestamps: true, strict: false }
);

export default mongoose.model('User', userSchema);
