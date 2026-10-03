import { Router } from "express";
import Book, { normalizeText } from "../models/Book.js";
import Loan from "../models/Loan.js";
import { requireAuth } from "../middleware/auth.js";
import { lookupIsbn, searchCoverImages } from "../services/isbn.js";
import {
  assertValidCoverImage,
  deleteCover,
  uploadCover,
} from "../services/covers.js";

const router = Router();
router.use(requireAuth);

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

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

    if (search) {
      const regex = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      filter.$or = [{ titleSort: regex }, { isbn: regex }, { authors: regex }];
    }

    const paginate =
      req.query.page !== undefined || req.query.limit !== undefined;

    const query = Book.find(filter).sort({ titleSort: 1 });

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

    const books = await query.lean();
    const total = paginate ? await Book.countDocuments(filter) : books.length;

    // Marca quais livros (dessa pagina) estao emprestados no momento.
    const bookIds = books.map((book) => book._id);
    const activeLoans = await Loan.find({
      status: "ativo",
      book: { $in: bookIds },
    })
      .select("book personName")
      .lean();
    const loanByBook = new Map(
      activeLoans.map((loan) => [String(loan.book), loan.personName]),
    );

    const result = books.map((book) => ({
      ...book,
      loanedTo: loanByBook.get(String(book._id)) || null,
    }));

    if (!paginate) {
      return res.json(result);
    }

    return res.json({
      items: result,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
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
        .json({ error: "O ISBN precisa ter 10 ou 13 digitos." });
    }

    const existing = await Book.findOne({ isbn });
    const data = await lookupIsbn(isbn);

    if (!data) {
      return res.status(404).json({
        error:
          "Nenhum livro encontrado para esse ISBN. Voce pode cadastrar manualmente.",
      });
    }

    return res.json({ ...data, alreadyRegistered: Boolean(existing) });
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

// GET /api/books/:id
router.get("/:id", async (req, res, next) => {
  try {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });
    return res.json(book);
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
        .json({ error: "O titulo do livro e obrigatorio." });
    }

    if (req.body.isbn) {
      const duplicated = await Book.findOne({
        isbn: String(req.body.isbn).trim(),
      });
      if (duplicated) {
        return res
          .status(409)
          .json({ error: "Ja existe um livro cadastrado com esse ISBN." });
      }
    }

    if (req.body.coverImage) {
      assertValidCoverImage(req.body.coverImage);
      uploaded = await uploadCover(req.body.coverImage);
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
      categories: req.body.categories || [],
      copies: req.body.copies || 1,
      notes: req.body.notes || "",
    });

    return res.status(201).json(book);
  } catch (error) {
    // Se a foto subiu mas o livro nao foi salvo, nao deixa a foto orfa.
    if (uploaded) await deleteCover(uploaded.publicId);
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
    const payload = { ...req.body };
    delete payload._id;
    delete payload.coverPublicId;
    const coverImage = payload.coverImage;
    delete payload.coverImage;

    if (typeof payload.authors === "string") {
      payload.authors = payload.authors
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
    }
    if (payload.title) {
      payload.titleSort = normalizeText(payload.title);
    }

    const previous = await Book.findById(req.params.id).lean();
    if (!previous) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    if (coverImage) {
      assertValidCoverImage(coverImage);
      uploaded = await uploadCover(coverImage);
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
      if (uploaded) await deleteCover(uploaded.publicId);
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    // Mantem os cards de emprestimo ativos com o titulo/capa atualizados.
    await Loan.updateMany(
      { book: book._id, status: "ativo" },
      {
        bookTitle: book.title,
        bookTitleSort: normalizeText(book.title),
        bookCover: book.cover,
        bookIsbn: book.isbn,
      },
    );

    // A foto antiga ficou sem uso: apaga no Cloudinary e, nos emprestimos ja
    // devolvidos (que ainda ficam alguns dias no historico), troca a capa
    // para nao apontar para uma imagem que deixou de existir.
    if (previous.coverPublicId && previous.coverPublicId !== book.coverPublicId) {
      await deleteCover(previous.coverPublicId);
      await Loan.updateMany(
        { book: book._id, status: { $ne: "ativo" } },
        { bookCover: book.cover },
      );
    }

    return res.json(book);
  } catch (error) {
    if (uploaded) await deleteCover(uploaded.publicId);
    return next(error);
  }
});

// DELETE /api/books/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const activeLoan = await Loan.findOne({
      book: req.params.id,
      status: "ativo",
    });
    if (activeLoan) {
      return res.status(409).json({
        error:
          "Esse livro esta emprestado para " +
          activeLoan.personName +
          ". Confirme a devolucao antes de excluir.",
      });
    }

    const book = await Book.findByIdAndDelete(req.params.id);
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });

    // Libera espaco no Cloudinary. Se falhar, o livro continua excluido (o
    // banco manda) e o erro fica registrado no log do servidor.
    const coverDeleted = book.coverPublicId
      ? await deleteCover(book.coverPublicId)
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
