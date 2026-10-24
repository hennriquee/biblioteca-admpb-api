import mongoose from 'mongoose';

const bookSchema = new mongoose.Schema(
  {
    isbn: { type: String, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    // Campo auxiliar em minusculas, usado para ordenar e pesquisar sem acento.
    titleSort: { type: String, index: true },
    // Chave só para ORDENAR a lista (ver buildTitleOrder). Fica separada do
    // titleSort porque a busca usa o titleSort com o texto normal do título.
    titleOrder: { type: String, index: true },
    authors: { type: [String], default: [] },
    publisher: { type: String, trim: true, default: '' },
    year: { type: String, trim: true, default: '' },
    pages: { type: Number, default: null },
    cover: { type: String, default: '' },
    // Identificador da foto no Cloudinary. So existe quando a capa foi enviada
    // pelo app (camera/galeria); capas vindas de link externo ficam vazias aqui.
    // E por ele que apagamos a foto la quando o livro e excluido ou trocado.
    coverPublicId: { type: String, default: '' },
    // Copia da capa feita no Cloudinary SO para a previa do link de
    // solicitacao no WhatsApp (ver services/requestPreview.js), quando a capa
    // e um link de outro site. ogImageSource diz de qual capa ela foi feita:
    // trocou a capa, a copia e refeita.
    ogImagePublicId: { type: String, default: '' },
    ogImageSource: { type: String, default: '' },
    synopsis: { type: String, default: '' },
    categories: { type: [String], default: [] },
    copies: { type: Number, default: 1, min: 1 },
    // Quantas vezes o livro ja saiu emprestado, desde sempre. E um contador
    // proprio porque o emprestimo devolvido some do banco depois de alguns
    // dias (ver o TTL em models/Loan.js): contar os emprestimos existentes
    // daria um numero que diminui com o tempo. Sobe quando um emprestimo e
    // registrado e desce se o registro for apagado por engano.
    loansTotal: { type: Number, default: 0, index: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

// Aceita qualquer coisa e devolve texto: na query string, "?search[$ne]=x"
// chega como objeto, e sem o String() aqui a rota quebraria com erro 500.
// Virando texto, a busca simplesmente nao encontra nada.
export function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Chave de ordenação do título, para a lista ficar na ordem que uma pessoa espera:
// - ignora pontuação: "Corajosas: Os contos" e "Corajosas 2: Os contos" têm o
//   mesmo texto-base. (Sem isso, o espaço vem antes do ":" e o "2" passava na frente.)
// - os números ficam de lado e só desempatam: o livro sem número vem antes
//   (volume 1), depois o 2, o 3... e 2 vem antes de 10 (compara como número).
// - título que começa com número (ex.: "1984") é ordenado como número, no início.
export function buildTitleOrder(title = '') {
  const tokens = normalizeText(title)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const pad = (n) => n.padStart(10, '0');
  const isNumber = (token) => /^\d+$/.test(token);

  // Título que COMEÇA com número ("1984", "2001: Uma odisseia"): o número
  // faz parte do nome, então fica no lugar e é comparado como número.
  if (!tokens.length || isNumber(tokens[0])) {
    return tokens.map((token) => (isNumber(token) ? pad(token) : token)).join(' ');
  }

  const words = tokens.filter((token) => !isNumber(token));
  const numbers = tokens.filter(isNumber).map(pad);
  // O \u0001 separa o texto dos números e não existe em título nenhum.
  return numbers.length
    ? words.join(' ') + ' \u0001 ' + numbers.join(' ')
    : words.join(' ');
}

bookSchema.pre('save', function setTitleSort(next) {
  this.titleSort = normalizeText(this.title);
  this.titleOrder = buildTitleOrder(this.title);
  next();
});

bookSchema.pre('findOneAndUpdate', function setTitleSortOnUpdate(next) {
  const update = this.getUpdate() || {};
  const title = update.title ?? update.$set?.title;
  if (title) {
    this.set('titleSort', normalizeText(title));
    this.set('titleOrder', buildTitleOrder(title));
  }
  next();
});

const Book = mongoose.model('Book', bookSchema);

// Livros cadastrados antes da chave de ordenação existir ainda não têm
// titleOrder. Roda uma vez a cada início do servidor e só mexe nos que faltam
// (nos demais não faz nada).
export async function backfillTitleOrder() {
  const missing = await Book.find({ titleOrder: { $exists: false } })
    .select('title')
    .lean();
  if (!missing.length) return 0;
  await Book.bulkWrite(
    missing.map((book) => ({
      updateOne: {
        filter: { _id: book._id },
        update: { $set: { titleOrder: buildTitleOrder(book.title) } },
      },
    }))
  );
  return missing.length;
}

/**
 * O livro mais emprestado do acervo - o que ganha a coroinha no card.
 *
 * SO HA CAMPEAO QUANDO ELE ESTA SOZINHO NA FRENTE: com empate no primeiro
 * lugar devolve null e ninguem recebe a coroa (coroar dois seria dizer que
 * cada um e "o mais emprestado"). Acervo sem nenhum emprestimo tambem da null.
 *
 * Olha o acervo INTEIRO, nao a pagina que esta na tela: a coroa pertence ao
 * mesmo livro em qualquer busca ou filtro - ela so nao aparece quando esse
 * livro nao esta entre os que a tela mostra.
 */
export async function mostLoanedBookId() {
  const top = await Book.find({ loansTotal: { $gt: 0 } })
    .sort({ loansTotal: -1 })
    .limit(2)
    .select('loansTotal')
    .lean();
  if (!top.length) return null;
  if (top.length > 1 && top[1].loansTotal === top[0].loansTotal) return null;
  return String(top[0]._id);
}

/**
 * Preenche o contador de emprestimos dos livros cadastrados antes de ele
 * existir. Roda uma vez por livro (o filtro pega so quem ainda nao tem o
 * campo), no inicio do servidor.
 *
 * O numero sai dos emprestimos que estao no banco agora. Os que foram
 * devolvidos e ja sairam do sistema (ver o TTL em models/Loan.js) nao entram
 * na conta - nao ha de onde tira-los. Dai para frente o contador e exato.
 */
export async function backfillBookLoanTotals() {
  const pending = await Book.find({ loansTotal: { $exists: false } })
    .select('_id')
    .lean();
  if (!pending.length) return 0;

  const rows = await mongoose.model('Loan').aggregate([
    { $match: { book: { $in: pending.map((book) => book._id) } } },
    { $group: { _id: '$book', count: { $sum: 1 } } },
  ]);
  const countByBook = new Map(rows.map((row) => [String(row._id), row.count]));

  for (const book of pending) {
    await Book.updateOne(
      { _id: book._id },
      { loansTotal: countByBook.get(String(book._id)) || 0 }
    );
  }
  return pending.length;
}

export default Book;
