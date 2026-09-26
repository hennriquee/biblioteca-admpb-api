import mongoose from 'mongoose';

const bookSchema = new mongoose.Schema(
  {
    isbn: { type: String, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    // Campo auxiliar em minusculas, usado para ordenar e pesquisar sem acento.
    titleSort: { type: String, index: true },
    authors: { type: [String], default: [] },
    publisher: { type: String, trim: true, default: '' },
    year: { type: String, trim: true, default: '' },
    pages: { type: Number, default: null },
    cover: { type: String, default: '' },
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

bookSchema.pre('save', function setTitleSort(next) {
  this.titleSort = normalizeText(this.title);
  next();
});

bookSchema.pre('findOneAndUpdate', function setTitleSortOnUpdate(next) {
  const update = this.getUpdate() || {};
  const title = update.title ?? update.$set?.title;
  if (title) {
    this.set('titleSort', normalizeText(title));
  }
  next();
});

export default mongoose.model('Book', bookSchema);
