import { Router } from "express";
import Book, { normalizeText } from "../models/Book.js";
import Loan from "../models/Loan.js";
import { MAX_CATEGORY_LENGTH } from "../services/categories.js";

/**
 * Rotas PUBLICAS (sem login) do acervo. Alimentam a pagina /catalogo, que e
 * a unica tela aberta a quem nao administra a biblioteca.
 *
 * Regras que nao podem ser quebradas aqui:
 * - So leitura (GET). Nenhuma rota que crie, edite ou exclua.
 * - Nunca devolver o documento do banco como veio: o que sai esta listado em
 *   PUBLIC_BOOK_FIELDS (o que o banco entrega) e em toPublicBook (o que vai
 *   para a resposta). Ficam de fora: observacoes do livro, id da foto no
 *   Cloudinary e qualquer dado de quem pegou o livro.
 * - Dos emprestimos so sai a CONTAGEM de unidades emprestadas. Nome, telefone,
 *   datas e prazos nunca entram em nenhuma resposta deste arquivo.
 */
const router = Router();

const DEFAULT_PAGE_SIZE = 10;
// O catalogo baixa o acervo inteiro (ate 300 livros) num pedido so e filtra
// no navegador; por isso o teto por pedido e 300.
const MAX_PAGE_SIZE = 300;
const MAX_PAGE = 1000;
const MAX_SEARCH_LENGTH = 80;

// Unicos campos do livro que o banco entrega para estas rotas.
const PUBLIC_BOOK_FIELDS =
  "isbn title authors publisher year pages cover synopsis categories copies";

// Na query string, "?category[$ne]=x" chega como objeto. Se isso fosse direto
// para o filtro do Mongo, viraria um operador. Aqui so texto simples passa.
// Tambem tira caracteres de controle: um byte nulo (%00) faz o driver do Mongo
// lancar erro (viraria 500 e uma pilha de erro no log a cada chamada).
function textParam(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "")
    : "";
}

function intParam(value, fallback, min, max) {
  const number = Number.parseInt(textParam(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Os autores sao guardados com acento ("João"), mas a busca chega sem
// ("joao"). Cada letra com variantes vira uma classe: "j[oòóôõö]..." .
const ACCENT_VARIANTS = {
  a: "aàáâãäå",
  c: "cç",
  e: "eèéêë",
  i: "iìíîï",
  n: "nñ",
  o: "oòóôõö",
  u: "uùúûü",
  y: "yýÿ",
};

function accentInsensitive(term) {
  return [...term]
    .map((char) =>
      ACCENT_VARIANTS[char]
        ? "[" + ACCENT_VARIANTS[char] + "]"
        : escapeRegex(char),
    )
    .join("");
}

// Busca por titulo, ISBN e autor. "term" ja vem normalizado (minusculo, sem
// acento) e com tamanho limitado.
function searchClause(term) {
  if (!term) return null;
  const plain = new RegExp(escapeRegex(term), "i");
  const clauses = [
    { titleSort: plain },
    { isbn: plain },
    { authors: new RegExp(accentInsensitive(term), "i") },
  ];
  // ISBN digitado com hifens ("978-85-...") tambem acha o cadastro sem hifens.
  const digits = term.replace(/[\s-]/g, "");
  if (digits !== term && /^[0-9x]+$/.test(digits)) {
    clauses.push({ isbn: new RegExp(escapeRegex(digits), "i") });
  }
  return { $or: clauses };
}

// Quantas unidades de cada livro estao emprestadas agora: Map(id -> numero).
// So numeros; nenhum dado de pessoa passa por aqui.
async function activeLoanCounts() {
  const rows = await Loan.aggregate([
    { $match: { status: "ativo" } },
    { $group: { _id: "$book", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

// Ids dos livros sem nenhuma unidade na estante (todas emprestadas). So olha
// livros que tem emprestimo ativo, entao a lista e pequena mesmo com acervo
// grande.
async function fullyLoanedIds(counts) {
  if (!counts.size) return [];
  const books = await Book.find({ _id: { $in: [...counts.keys()] } })
    .select("copies")
    .lean();
  return books
    .filter((book) => counts.get(String(book._id)) >= (book.copies || 1))
    .map((book) => book._id);
}

// Monta a resposta publica de um livro. Campo novo no livro so aparece aqui se
// for acrescentado de proposito, aos dois lugares (PUBLIC_BOOK_FIELDS e aqui).
function toPublicBook(book, loanedCount = 0) {
  const copies = book.copies || 1;
  const loaned = Math.min(loanedCount, copies);
  return {
    id: String(book._id),
    title: book.title,
    authors: book.authors || [],
    publisher: book.publisher || "",
    year: book.year || "",
    pages: book.pages || null,
    isbn: book.isbn || "",
    cover: book.cover || "",
    synopsis: book.synopsis || "",
    categories: book.categories || [],
    copies,
    loaned,
    available: copies - loaned,
  };
}

// GET /api/public/overview
// Totais do acervo e categorias (alimenta o filtro e o resumo da tela).
//  - available: livros com pelo menos uma unidade na estante
//  - unavailable: livros com TODAS as unidades emprestadas
router.get("/overview", async (req, res, next) => {
  try {
    const counts = await activeLoanCounts();
    const [titles, outIds, categoryRows] = await Promise.all([
      Book.countDocuments(),
      fullyLoanedIds(counts),
      Book.aggregate([
        { $unwind: "$categories" },
        { $match: { categories: { $ne: "" } } },
        { $group: { _id: "$categories", count: { $sum: 1 } } },
      ]),
    ]);

    const categories = categoryRows
      .map((row) => ({ name: row._id, count: row.count }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    res.set("Cache-Control", "no-cache");
    return res.json({
      titles,
      available: titles - outIds.length,
      unavailable: outIds.length,
      categories,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/public/books?search=texto&category=Oração&status=disponivel&page=1&limit=10
// - search: titulo, autor ou ISBN
// - category: nome exato da categoria (como listado em /overview)
// - status: "disponivel" (tem unidade na estante) ou "emprestado" (todas as
//   unidades emprestadas). Qualquer outro valor = todos.
// Sempre paginado e em ordem alfabetica.
router.get("/books", async (req, res, next) => {
  try {
    const search = normalizeText(
      textParam(req.query.search).slice(0, MAX_SEARCH_LENGTH),
    );
    const category = textParam(req.query.category)
      .trim()
      .slice(0, MAX_CATEGORY_LENGTH);
    const status = textParam(req.query.status);
    const page = intParam(req.query.page, 1, 1, MAX_PAGE);
    const limit = intParam(
      req.query.limit,
      DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
    );

    const filter = {};
    if (category) filter.categories = category;
    const clause = searchClause(search);
    if (clause) Object.assign(filter, clause);

    // So o filtro por situacao precisa da contagem de emprestimos ANTES de
    // consultar os livros. Sem ele, as consultas vao juntas ao banco (cada
    // ida e volta ao banco custa tempo; em fila, a resposta demora o triplo).
    const filtersByStatus = status === "disponivel" || status === "emprestado";
    const countsPromise = activeLoanCounts();
    if (filtersByStatus) {
      const outIds = await fullyLoanedIds(await countsPromise);
      filter._id = status === "emprestado" ? { $in: outIds } : { $nin: outIds };
    }

    // O _id no fim da ordenacao desempata titulos iguais: sem ele, o mesmo
    // livro poderia repetir (ou sumir) entre uma pagina e outra.
    const [counts, books, total] = await Promise.all([
      countsPromise,
      Book.find(filter)
        .select(PUBLIC_BOOK_FIELDS)
        .sort({ titleOrder: 1, titleSort: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Book.countDocuments(filter),
    ]);

    res.set("Cache-Control", "no-cache");
    return res.json({
      items: books.map((book) =>
        toPublicBook(book, counts.get(String(book._id))),
      ),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (error) {
    return next(error);
  }
});

// Erro nesta area nunca mostra a mensagem interna (pode citar banco/consulta).
// O detalhe fica so no log do servidor.
router.use((err, req, res, next) => {
  console.error("[public]", err);
  res.status(500).json({
    error: "Não foi possível carregar o acervo agora. Tente de novo em instantes.",
  });
});

export default router;
