import { Router } from "express";
import Book, {
  mostLoanedBookId,
  normalizeText,
} from "../models/Book.js";
import Loan from "../models/Loan.js";
import LoanRequest from "../models/LoanRequest.js";
import { requireAdmin } from "../middleware/auth.js";
import { lookupIsbn, searchCoverImages } from "../services/isbn.js";
import { cleanCategoryList } from "../services/categories.js";
import {
  assertValidImage,
  BOOK_COVER,
  deleteImage,
  uploadImage,
} from "../services/images.js";
import { fetchRemoteImage } from "../services/remoteImage.js";
import { announceAvailability } from "../services/returnAlerts.js";
import { allWordsRegex, escapeRegex } from "../services/search.js";
import {
  availableOf,
  NOTHING_OUT,
  OCCUPYING_REQUEST,
  occupancyByBook,
} from "../services/occupancy.js";
import { forgetPreviewImage } from "../services/requestPreview.js";

const router = Router();
router.use(requireAdmin);

const DEFAULT_PAGE_SIZE = 10;
// O app baixa o acervo inteiro (ate 300 livros) num pedido so e filtra no
// navegador; por isso o teto por pedido e 300.
const MAX_PAGE_SIZE = 300;
const MAX_COPIES = 999;
const COPIES_ERROR =
  "A quantidade precisa ser um número inteiro de 1 a " +
  MAX_COPIES +
  ".";

// Campos que o app pode gravar ao editar um livro. Qualquer outro campo
// enviado na requisição é ignorado.
const EDITABLE_FIELDS = [
  "isbn",
  "title",
  "authors",
  "publisher",
  "year",
  "pages",
  "cover",
  "synopsis",
  "categories",
  "copies",
  "notes",
];

// Converte o valor recebido em número de exemplares. Vazio = 1 (padrão).
// Devolve null quando o valor não é um inteiro válido.
function parseCopies(value) {
  if (value === undefined || value === null || value === "") return 1;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_COPIES) {
    return null;
  }
  return number;
}

// Limpa as categorias recebidas e reaproveita a grafia que já existe no
// acervo: "ficcao" e "Ficção" viram a mesma categoria, sem duplicar no filtro.
async function prepareCategories(value) {
  const list = cleanCategoryList(value);
  if (!list.length) return [];
  const existing = await Book.distinct("categories");
  const byKey = new Map(existing.map((name) => [normalizeText(name), name]));
  return list.map((name) => byKey.get(normalizeText(name)) || name);
}

// Acrescenta a cada livro a situação dos exemplares:
// - copies: total de exemplares
// - loanedCount / loanedNames: quantos estão emprestados agora e com quem
// - requestedCount / requestedNames: quantos estão SOLICITADOS (retirada já
//   combinada) e por quem - ver services/occupancy.js
// - available: quantos estão na estante (livres para emprestar ou solicitar)
async function withLoanInfo(books) {
  const outByBook = await occupancyByBook(books.map((book) => book._id));
  return books.map((book) => {
    const out = outByBook.get(String(book._id)) || NOTHING_OUT;
    return {
      ...book,
      copies: book.copies || 1,
      loanedCount: out.loaned,
      loanedNames: out.loanedNames,
      requestedCount: out.requested,
      requestedNames: out.requestedNames,
      available: availableOf(book, out),
    };
  });
}

// Filtro por situacao do painel (?status=):
// - disponivel: tem exemplar livre na estante;
// - emprestado: tem PELO MENOS UM exemplar emprestado;
// - solicitado: tem PELO MENOS UMA solicitacao registrada.
// (O acervo publico conta diferente: la "emprestado" e "solicitado" sao os
// livros sem nenhum exemplar livre - ver routes/public.js.)
async function statusClause(status) {
  if (!["disponivel", "emprestado", "solicitado"].includes(status)) return null;
  const out = await occupancyByBook();
  const ids = [...out.keys()];
  if (status === "emprestado") {
    return { $in: ids.filter((id) => out.get(id).loaned > 0) };
  }
  if (status === "solicitado") {
    return { $in: ids.filter((id) => out.get(id).requested > 0) };
  }
  // Disponivel: fora da lista os livros com TODOS os exemplares ocupados.
  const books = await Book.find({ _id: { $in: ids } }).select("copies").lean();
  const full = books
    .filter((book) => availableOf(book, out.get(String(book._id))) === 0)
    .map((book) => book._id);
  return { $nin: full };
}

// GET /api/books?search=texto&page=1&limit=10
// Lista os livros em ordem alfabetica, com filtro opcional de busca.
//
// A paginacao e opt-in: so entra em vigor quando "page" ou "limit" vem na
// query string. Sem esses parametros, devolve o array completo, do jeito
// que sempre devolveu (a Home, por exemplo, so quer o total de livros e
// continua chamando sem paginar).
//
// A busca ("search") roda sempre no banco inteiro, nunca so na pagina
// carregada: por isso e possivel encontrar qualquer livro do acervo mesmo
// exibindo so 10 por vez na tela.
router.get("/", async (req, res, next) => {
  try {
    const search = normalizeText(req.query.search || "");
    const filter = {};

    // Filtro por categoria (nome exato, como listado em /categories).
    const category = String(req.query.category || "").trim();
    if (category) filter.categories = category;

    const byStatus = await statusClause(String(req.query.status || ""));
    if (byStatus) filter._id = byStatus;

    // Titulo e autor por palavras (ver services/search.js); o autor e
    // guardado com acento, a busca chega sem.
    if (search) {
      filter.$or = [
        { titleSort: allWordsRegex(search) },
        { isbn: new RegExp(escapeRegex(search), "i") },
        { authors: allWordsRegex(search, { accents: true }) },
      ];
      // ISBN digitado com hifens tambem acha o cadastro sem hifens (como no
      // acervo publico, routes/public.js).
      const digits = search.replace(/[\s-]/g, "");
      if (digits !== search && /^[0-9x]+$/.test(digits)) {
        filter.$or.push({ isbn: new RegExp(escapeRegex(digits), "i") });
      }
    }

    const paginate =
      req.query.page !== undefined || req.query.limit !== undefined;

    // O _id no fim desempata titulos iguais: sem ele, o mesmo livro poderia
    // repetir (ou sumir) entre uma pagina e outra.
    const query = Book.find(filter).sort({
      titleOrder: 1,
      titleSort: 1,
      _id: 1,
    });

    let page = 1;
    let limit = 0;

    if (paginate) {
      page = Math.max(1, parseInt(req.query.page, 10) || 1);
      limit = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE),
      );
      query.skip((page - 1) * limit).limit(limit);
    }

    // A lista e a contagem vao juntas ao banco (em fila, a resposta demora
    // uma ida e volta a mais).
    const [books, counted, mostLoanedId] = await Promise.all([
      query.lean(),
      paginate ? Book.countDocuments(filter) : null,
      paginate ? mostLoanedBookId() : null,
    ]);
    const total = paginate ? counted : books.length;

    // Marca, para cada livro (dessa pagina), quantos exemplares estao
    // emprestados no momento e quantos estao disponiveis.
    const result = await withLoanInfo(books);

    if (!paginate) {
      return res.json(result);
    }

    return res.json({
      items: result,
      total,
      page,
      limit,
      hasMore: page * limit < total,
      // Qual livro do ACERVO leva a coroinha (null quando ha empate no
      // primeiro lugar). A tela so desenha a coroa se ele estiver na lista.
      mostLoanedId,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/books/categories -> categorias já usadas no acervo, em ordem
// alfabética, com quantos livros há em cada uma. Alimenta a lista do
// cadastro e o filtro do acervo. (Fica antes de /:id para não ser confundida com um id.)
router.get("/categories", async (req, res, next) => {
  try {
    const rows = await Book.aggregate([
      { $unwind: "$categories" },
      { $match: { categories: { $ne: "" } } },
      { $group: { _id: "$categories", count: { $sum: 1 } } },
    ]);
    const categories = rows
      .map((row) => ({ name: row._id, count: row.count }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return res.json(categories);
  } catch (error) {
    return next(error);
  }
});

// GET /api/books/lookup/:isbn -> busca dados do livro em APIs gratuitas
router.get("/lookup/:isbn", async (req, res, next) => {
  try {
    const isbn = String(req.params.isbn || "").replace(/[^0-9Xx]/g, "");
    if (isbn.length !== 10 && isbn.length !== 13) {
      return res
        .status(400)
        .json({ error: "O ISBN precisa ter 10 ou 13 dígitos." });
    }

    const existing = await Book.findOne({ isbn });
    const data = await lookupIsbn(isbn);

    if (!data) {
      return res.status(404).json({
        error:
          "Nenhum livro encontrado para esse ISBN. Você pode cadastrar manualmente.",
      });
    }

    return res.json({
      ...data,
      alreadyRegistered: Boolean(existing),
      existingId: existing ? existing._id : null,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/books/cover-search?q=texto -> busca capas por texto livre
// (usado quando a pessoa cola um link de busca do Google Imagens que nao
// tem nenhuma imagem embutida nele, so o texto pesquisado - ex: link do
// celular no formato google.com/search?q=...&udm=2 - ou quando digita a
// busca direto no modal "Buscar foto na internet").
router.get("/cover-search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ error: "Informe o que buscar." });
    }
    const results = await searchCoverImages(q);
    return res.json({ results });
  } catch (error) {
    return next(error);
  }
});

// GET /api/books/cover-source?url=<endereco da capa> -> { image: data URI }
// Entrega ao app a capa que ja esta no livro quando ela e um link de outro
// site: o navegador nao deixa o app ler os pontos de uma imagem de fora (CORS),
// entao "Editar capa" (recortar, ampliar, girar) pede a imagem ao servidor.
// Ver services/remoteImage.js para as travas contra uso indevido.
router.get("/cover-source", async (req, res, next) => {
  try {
    const image = await fetchRemoteImage(req.query.url);
    return res.json({ image });
  } catch (error) {
    return next(error);
  }
});

// GET /api/books/:id
router.get("/:id", async (req, res, next) => {
  try {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });
    const [withInfo] = await withLoanInfo([book]);
    return res.json(withInfo);
  } catch (error) {
    return next(error);
  }
});

// POST /api/books
// Se vier "coverImage" (foto tirada/escolhida e recortada no app, em data
// URI), ela e enviada ao Cloudinary e o livro guarda a URL + o publicId.
router.post("/", async (req, res, next) => {
  let uploaded = null;
  try {
    const { title } = req.body;
    if (!title || !String(title).trim()) {
      return res
        .status(400)
        .json({ error: "O título do livro é obrigatório." });
    }

    const copies = parseCopies(req.body.copies);
    if (copies === null) {
      return res.status(400).json({ error: COPIES_ERROR });
    }

    if (req.body.isbn) {
      const duplicated = await Book.findOne({
        isbn: String(req.body.isbn).trim(),
      });
      if (duplicated) {
        return res.status(409).json({
          error:
            "Já existe um livro cadastrado com esse ISBN. Para ter mais unidades, edite o livro e aumente a quantidade.",
        });
      }
    }

    if (req.body.coverImage) {
      assertValidImage(req.body.coverImage);
      uploaded = await uploadImage(req.body.coverImage, BOOK_COVER);
    }

    const book = await Book.create({
      isbn: String(req.body.isbn || "").trim(),
      title: String(title).trim(),
      authors: Array.isArray(req.body.authors)
        ? req.body.authors
        : String(req.body.authors || "")
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
      publisher: req.body.publisher || "",
      year: req.body.year ? String(req.body.year) : "",
      pages: req.body.pages || null,
      cover: uploaded ? uploaded.url : req.body.cover || "",
      coverPublicId: uploaded ? uploaded.publicId : "",
      synopsis: req.body.synopsis || "",
      categories: await prepareCategories(req.body.categories),
      copies,
      notes: req.body.notes || "",
    });

    return res.status(201).json(book);
  } catch (error) {
    // Se a foto subiu mas o livro nao foi salvo, nao deixa a foto orfa.
    if (uploaded) await deleteImage(uploaded.publicId);
    return next(error);
  }
});

// PUT /api/books/:id
// Regras da capa:
// - "coverImage" (data URI): sobe a foto nova para o Cloudinary e apaga a antiga.
// - "cover" diferente do atual (link colado, busca na internet ou capa
//   removida): a foto antiga do Cloudinary, se existia, e apagada.
// - "coverPublicId" nunca e aceito do cliente; so o servidor define.
router.put("/:id", async (req, res, next) => {
  let uploaded = null;
  try {
    // So os campos permitidos entram (nada de _id, coverPublicId etc.).
    const payload = {};
    EDITABLE_FIELDS.forEach((field) => {
      if (field in req.body) payload[field] = req.body[field];
    });
    const coverImage = req.body.coverImage;

    if (typeof payload.authors === "string") {
      payload.authors = payload.authors
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
    }
    if (payload.title) {
      payload.titleSort = normalizeText(payload.title);
    }
    if ("categories" in payload) {
      payload.categories = await prepareCategories(payload.categories);
    }

    const previous = await Book.findById(req.params.id).lean();
    if (!previous) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    // Exemplares: inteiro de 1 a 999 e nunca menos do que os que estao
    // fora agora - emprestados ou solicitados (senao haveria mais gente com o
    // livro do que exemplares).
    if ("copies" in payload) {
      const copies = parseCopies(payload.copies);
      if (copies === null) {
        return res.status(400).json({ error: COPIES_ERROR });
      }
      const out =
        (await occupancyByBook([previous._id])).get(String(previous._id)) ||
        NOTHING_OUT;
      const outNow = out.loaned + out.requested;
      if (copies < outNow) {
        const what = !out.requested
          ? outNow === 1
            ? "emprestado"
            : "emprestados"
          : !out.loaned
            ? outNow === 1
              ? "solicitado"
              : "solicitados"
            : "fora (emprestados ou solicitados)";
        return res.status(409).json({
          error:
            "Há " +
            outNow +
            " " +
            what +
            " agora, então a quantidade não pode ser menor que " +
            outNow +
            ".",
        });
      }
      payload.copies = copies;
    }

    // Mesmo ISBN de outro livro nao pode (o cadastro ja barra, a edicao tambem).
    if (payload.isbn !== undefined) {
      payload.isbn = String(payload.isbn || "").trim();
      if (payload.isbn && payload.isbn !== previous.isbn) {
        const duplicated = await Book.findOne({
          isbn: payload.isbn,
          _id: { $ne: previous._id },
        });
        if (duplicated) {
          return res.status(409).json({
            error: "Já existe outro livro cadastrado com esse ISBN.",
          });
        }
      }
    }

    if (coverImage) {
      assertValidImage(coverImage);
      uploaded = await uploadImage(coverImage, BOOK_COVER);
      payload.cover = uploaded.url;
      payload.coverPublicId = uploaded.publicId;
    } else if ("cover" in payload && (payload.cover || "") !== previous.cover) {
      // Passou a usar um link externo (ou ficou sem capa).
      payload.coverPublicId = "";
    }

    const book = await Book.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    if (!book) {
      if (uploaded) await deleteImage(uploaded.publicId);
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    // Exemplar novo na estante: avisa quem pediu "Avise-me quando voltar" no
    // acervo publico (ver services/returnAlerts.js; nao atrasa a resposta).
    if ((book.copies || 1) > (previous.copies || 1)) {
      announceAvailability(book._id);
    }

    // Mantem os cards de emprestimo ativos (e as solicitacoes) com o
    // titulo/capa atualizados.
    const bookCopy = {
      bookTitle: book.title,
      bookTitleSort: normalizeText(book.title),
      bookCover: book.cover,
      bookIsbn: book.isbn,
    };
    await Promise.all([
      Loan.updateMany({ book: book._id, status: "ativo" }, bookCopy),
      LoanRequest.updateMany({ book: book._id }, bookCopy),
    ]);

    // A capa mudou: a copia dela feita para a previa do link do WhatsApp
    // (ver services/requestPreview.js) ficou velha.
    if ((previous.cover || "") !== (book.cover || "")) {
      await forgetPreviewImage(previous);
    }

    // A foto antiga ficou sem uso: apaga no Cloudinary e, nos emprestimos ja
    // devolvidos (que ainda ficam alguns dias no historico), troca a capa
    // para nao apontar para uma imagem que deixou de existir.
    if (
      previous.coverPublicId &&
      previous.coverPublicId !== book.coverPublicId
    ) {
      await deleteImage(previous.coverPublicId);
      await Loan.updateMany(
        { book: book._id, status: { $ne: "ativo" } },
        { bookCover: book.cover },
      );
    }

    return res.json(book);
  } catch (error) {
    if (uploaded) await deleteImage(uploaded.publicId);
    return next(error);
  }
});

// DELETE /api/books/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const activeLoans = await Loan.find({
      book: req.params.id,
      status: "ativo",
    })
      .select("personName")
      .lean();
    if (activeLoans.length === 1) {
      return res.status(409).json({
        error:
          "Esse livro está emprestado para " +
          activeLoans[0].personName +
          ". Confirme a devolução antes de excluir.",
      });
    }
    if (activeLoans.length > 1) {
      return res.status(409).json({
        error:
          "Esse livro tem " +
          activeLoans.length +
          " unidades emprestadas (" +
          activeLoans.map((loan) => loan.personName).join(", ") +
          "). Confirme as devoluções antes de excluir.",
      });
    }

    // Solicitacao registrada segura um exemplar para alguem: primeiro ela
    // vira emprestimo ou e excluida (em Emprestimos > Solicitados).
    const requests = await LoanRequest.find({
      book: req.params.id,
      status: { $in: OCCUPYING_REQUEST },
    })
      .select("personName")
      .lean();
    if (requests.length) {
      return res.status(409).json({
        error:
          (requests.length === 1
            ? "Esse livro está solicitado por " + requests[0].personName
            : "Esse livro tem " +
              requests.length +
              " solicitações (" +
              requests.map((item) => item.personName).join(", ") +
              ")") +
          ". Exclua a solicitação (em Empréstimos > Solicitados) antes de excluir o livro.",
      });
    }

    const book = await Book.findByIdAndDelete(req.params.id);
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });

    // Links de WhatsApp ainda nao usados deste livro nao tem mais o que abrir,
    // e a copia da capa feita para a previa deles tambem nao serve mais.
    await LoanRequest.deleteMany({ book: book._id, status: "pendente" });
    await forgetPreviewImage(book);

    // Libera espaco no Cloudinary. Se falhar, o livro continua excluido (o
    // banco manda) e o erro fica registrado no log do servidor.
    const coverDeleted = book.coverPublicId
      ? await deleteImage(book.coverPublicId)
      : true;

    // Emprestimos ja devolvidos guardam uma copia do link da capa por alguns
    // dias; limpa para eles nao exibirem uma imagem que nao existe mais.
    if (book.coverPublicId) {
      await Loan.updateMany({ book: book._id }, { bookCover: "" });
    }

    return res.json({ ok: true, coverDeleted });
  } catch (error) {
    return next(error);
  }
});

export default router;
