import { Router } from "express";
import Book, {
  mostLoanedBookId,
  normalizeText,
} from "../models/Book.js";
import Loan from "../models/Loan.js";
import Person from "../models/Person.js";
import { MAX_CATEGORY_LENGTH } from "../services/categories.js";
import { IS_ADMIN_FILTER } from "../services/people.js";

/**
 * Rotas PUBLICAS (sem login) do acervo. Alimentam a pagina /catalogo, que e
 * a unica tela aberta a quem nao administra a biblioteca.
 *
 * Regras que nao podem ser quebradas aqui:
 * - So leitura (GET). Nenhuma rota que crie, edite ou exclua. (O pedido de
 *   "Avise-me quando voltar", que grava, fica a parte em routes/alerts.js.)
 * - Nunca devolver o documento do banco como veio: o que sai esta listado em
 *   PUBLIC_BOOK_FIELDS (o que o banco entrega) e em toPublicBook (o que vai
 *   para a resposta). Ficam de fora: observacoes do livro, id da foto no
 *   Cloudinary e qualquer dado de quem pegou o livro.
 * - Dos emprestimos sai a CONTAGEM de unidades emprestadas e a DATA COMBINADA
 *   de entrega (a previsao de devolucao que o acervo mostra). Nome, telefone,
 *   data de retirada e observacoes nunca entram em nenhuma resposta deste
 *   arquivo: a data diz QUANDO o livro volta para a estante, nunca com quem
 *   ele esta.
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

// O que cada livro tem emprestado agora: Map(id -> { count, nextDue }).
//  - count: quantas unidades estao fora da estante;
//  - nextDue: a data combinada de entrega mais proxima entre elas.
// So isso: nenhum dado de quem pegou o livro passa por aqui.
async function activeLoanInfo() {
  const rows = await Loan.aggregate([
    { $match: { status: "ativo" } },
    {
      $group: {
        _id: "$book",
        count: { $sum: 1 },
        // O $min ignora emprestimo sem prazo: com dois exemplares fora, um com
        // data combinada e outro sem, vale a data que existe.
        nextDue: { $min: "$dueDate" },
      },
    },
  ]);
  return new Map(
    rows.map((row) => [
      String(row._id),
      { count: row.count, nextDue: row.nextDue || null },
    ]),
  );
}

// Ids dos livros sem nenhuma unidade na estante (todas emprestadas). So olha
// livros que tem emprestimo ativo, entao a lista e pequena mesmo com acervo
// grande.
async function fullyLoanedIds(loans) {
  if (!loans.size) return [];
  const books = await Book.find({ _id: { $in: [...loans.keys()] } })
    .select("copies")
    .lean();
  return books
    .filter(
      (book) => loans.get(String(book._id)).count >= (book.copies || 1),
    )
    .map((book) => book._id);
}

// Monta a resposta publica de um livro. Campo novo no livro so aparece aqui se
// for acrescentado de proposito, aos dois lugares (PUBLIC_BOOK_FIELDS e aqui).
function toPublicBook(book, loans = null) {
  const copies = book.copies || 1;
  const loaned = Math.min(loans?.count || 0, copies);
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
    // PREVISAO DE ENTREGA: a data combinada para o exemplar emprestado voltar
    // para a estante. Com mais de um exemplar fora, e a mais proxima entre as
    // datas combinadas. null quando nada esta emprestado ou quando o
    // emprestimo foi feito sem prazo combinado.
    dueDate: loans?.nextDue ? new Date(loans.nextDue).toISOString() : null,
  };
}

// Equipe da biblioteca para o "Com quem falar?" do acervo publico.
//
// DAQUI SO SAI o que ajuda a encontrar a pessoa na igreja: os DOIS PRIMEIROS
// NOMES e a foto. Telefone, nome de usuario e nome completo nao entram nesta
// resposta - quem quer um livro procura a pessoa pessoalmente.
async function libraryStaff() {
  // A equipe sao as pessoas do cadastro que tem login no painel (ver
  // models/Person.js). Quem e so usuario da biblioteca nunca aparece aqui.
  const admins = await Person.find(IS_ADMIN_FILTER)
    .select("fullName photo")
    .lean();

  return admins
    .filter((person) => person.fullName)
    .map((person) => ({
      id: String(person._id),
      name: person.fullName.split(/\s+/).slice(0, 2).join(" "),
      photo: person.photo || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

// GET /api/public/overview
// Totais do acervo e categorias (alimenta o filtro e o resumo da tela).
//  - available: livros com pelo menos uma unidade na estante
//  - unavailable: livros com TODAS as unidades emprestadas
router.get("/overview", async (req, res, next) => {
  try {
    const loans = await activeLoanInfo();
    const [titles, outIds, categoryRows, staff] =
      await Promise.all([
        Book.countDocuments(),
        fullyLoanedIds(loans),
        Book.aggregate([
          { $unwind: "$categories" },
          { $match: { categories: { $ne: "" } } },
          { $group: { _id: "$categories", count: { $sum: 1 } } },
        ]),
        libraryStaff(),
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
      staff,
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
// - since: so livros cadastrados DEPOIS desta data/hora (ISO). Alimenta a
//   tela de novidades (/catalogo/novidades) - "desde a ultima visita" quem
//   decide e o front, comparando com o que guardou no localStorage.
// - sort=newest: mais novo primeiro (por data de cadastro), em vez da ordem
//   alfabetica padrao. So usado junto com "since".
// Sempre paginado; em ordem alfabetica, exceto com sort=newest.
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
    const newest = textParam(req.query.sort) === "newest";

    const filter = {};
    if (category) filter.categories = category;
    const clause = searchClause(search);
    if (clause) Object.assign(filter, clause);
    // Data invalida (ou ausente) e ignorada em silencio, como os demais
    // parametros desta rota - nunca vira erro 500 por causa de um link velho
    // ou de alguem adulterando a query string.
    const since = new Date(textParam(req.query.since));
    if (!Number.isNaN(since.getTime())) {
      filter.createdAt = { $gt: since };
    }

    // So o filtro por situacao precisa da contagem de emprestimos ANTES de
    // consultar os livros. Sem ele, as consultas vao juntas ao banco (cada
    // ida e volta ao banco custa tempo; em fila, a resposta demora o triplo).
    const filtersByStatus = status === "disponivel" || status === "emprestado";
    const loansPromise = activeLoanInfo();
    if (filtersByStatus) {
      const outIds = await fullyLoanedIds(await loansPromise);
      filter._id = status === "emprestado" ? { $in: outIds } : { $nin: outIds };
    }

    // O _id no fim da ordenacao desempata titulos iguais: sem ele, o mesmo
    // livro poderia repetir (ou sumir) entre uma pagina e outra.
    const [loans, books, total, mostLoanedId] = await Promise.all([
      loansPromise,
      Book.find(filter)
        .select(PUBLIC_BOOK_FIELDS)
        .sort(
          newest
            ? { createdAt: -1, _id: -1 }
            : { titleOrder: 1, titleSort: 1, _id: 1 },
        )
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Book.countDocuments(filter),
      mostLoanedBookId(),
    ]);

    res.set("Cache-Control", "no-cache");
    return res.json({
      items: books.map((book) =>
        toPublicBook(book, loans.get(String(book._id))),
      ),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      // Qual livro do ACERVO leva a coroinha de mais emprestado (null quando
      // ha empate no primeiro lugar). A tela so desenha a coroa se ele
      // estiver na lista que esta aparecendo.
      mostLoanedId,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/public/books/:id
// Um livro so, no mesmo formato da lista: { book }. Usado pelo toque na
// notificacao do "Avise-me quando voltar", que abre o catalogo ja com o
// livro aberto (/catalogo?livro=id) - mesmo que ele nao esteja entre os
// primeiros da lista.
router.get("/books/:id", async (req, res, next) => {
  try {
    const id = textParam(req.params.id);
    const book = /^[a-f0-9]{24}$/i.test(id)
      ? await Book.findById(id).select(PUBLIC_BOOK_FIELDS).lean()
      : null;
    if (!book) {
      return res.status(404).json({ error: "Esse livro não está mais no acervo." });
    }
    const loans = await activeLoanInfo();
    res.set("Cache-Control", "no-cache");
    return res.json({ book: toPublicBook(book, loans.get(String(book._id))) });
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
