import mongoose from 'mongoose';

/**
 * "Sugerir um livro" do acervo publico (/catalogo): um livro que alguem
 * gostaria de ver na biblioteca. Os administradores veem a lista em
 * Configuracoes > Livros sugeridos, na ordem em que chegaram, e excluem
 * quando quiserem (ver routes/suggestions.js).
 *
 * Nao ha nome, telefone nem login de quem sugeriu: so o livro.
 */
const bookSuggestionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    author: { type: String, required: true, trim: true },
    // Titulo e autor sem acento, sem pontuacao e em minusculas: e por eles
    // que a mesma sugestao mandada de novo e reconhecida (e nao vira outra
    // linha).
    titleSort: { type: String, index: true },
    authorSort: { type: String },
    // Foto opcional do livro, no Cloudinary (pasta biblioteca-admpb/sugestoes).
    photo: { type: String, default: '' },
    photoPublicId: { type: String, default: '' },
  },
  { timestamps: true }
);

bookSuggestionSchema.index({ createdAt: 1 });
// O mesmo livro (titulo + autor, sem acento nem pontuacao) uma vez so: dois
// envios iguais ao mesmo tempo nao viram duas linhas.
bookSuggestionSchema.index({ titleSort: 1, authorSort: 1 }, { unique: true });

export default mongoose.model('BookSuggestion', bookSuggestionSchema);
