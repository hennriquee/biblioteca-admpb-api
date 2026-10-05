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

// Acrescenta a cada livro a situação dos exemplares:
// - copies: total de exemplares
// - loanedCount / loanedNames: quantos estão emprestados agora e com quem
// - available: quantos estão na estante
async function withLoanInfo(books) {
  const activeLoans = await Loan.find({
    status: "ativo",
    book: { $in: books.map((book) => book._id) },
  })
    .select("book personName")
    .sort({ startDate: 1 })
    .lean();

  const namesByBook = new Map();
  activeLoans.forEach((loan) => {
    const key = String(loan.book);
    namesByBook.set(key, [...(namesByBook.get(key) || []), loan.personName]);
  });

  return books.map((book) => {
    const loanedNames = namesByBook.get(String(book._id)) || [];
    const copies = book.copies || 1;
    return {
      ...book,
      copies,
      loanedCount: loanedNames.length,
      loanedNames,
      available: Math.max(0, copies - loanedNames.length),
    };
  });
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
      copies,
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

    const previous = await Book.findById(req.params.id).lean();
    if (!previous) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    // Exemplares: inteiro de 1 a 999 e nunca menos do que os que estao
    // emprestados agora (senao haveria mais emprestimos que exemplares).
    if ("copies" in payload) {
      const copies = parseCopies(payload.copies);
      if (copies === null) {
        return res.status(400).json({ error: COPIES_ERROR });
      }
      const loanedNow = await Loan.countDocuments({
        book: previous._id,
        status: "ativo",
      });
      if (copies < loanedNow) {
        return res.status(409).json({
          error:
            loanedNow === 1
              ? "Há 1 emprestado agora, então a quantidade não pode ser menor que 1."
              : "Há " +
                loanedNow +
                " emprestados agora, então a quantidade não pode ser menor que " +
                loanedNow +
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
    if (
      previous.coverPublicId &&
      previous.coverPublicId !== book.coverPublicId
    ) {
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
