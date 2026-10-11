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
    synopsis: { type: String, default: '' },
    categories: { type: [String], default: [] },
    copies: { type: Number, default: 1, min: 1 },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

export function normalizeText(value = '') {
  return value
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

export default Book;
