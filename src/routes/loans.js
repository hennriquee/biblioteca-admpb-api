import { Router } from "express";
import Loan from "../models/Loan.js";
import Book, { normalizeText } from "../models/Book.js";
import Person from "../models/Person.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/loans?status=ativo&book=texto&person=texto
router.get("/", async (req, res, next) => {
  try {
    const status = req.query.status || "ativo";
    const filter = {};
    if (status !== "todos") filter.status = status;

    const bookQuery = normalizeText(req.query.book || "");
    if (bookQuery) {
      const regex = new RegExp(escapeRegex(bookQuery), "i");
      filter.$or = [{ bookTitleSort: regex }, { bookIsbn: regex }];
    }

    const personQuery = normalizeText(req.query.person || "");
    if (personQuery) {
      filter.personNameSort = new RegExp(escapeRegex(personQuery), "i");
    }

    const loans = await Loan.find(filter).sort({ startDate: -1 }).lean();
    return res.json(loans);
  } catch (error) {
    return next(error);
  }
});

// GET /api/loans/:id
router.get("/:id", async (req, res, next) => {
  try {
    const loan = await Loan.findById(req.params.id).populate("book").lean();
    if (!loan)
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    return res.json(loan);
  } catch (error) {
    return next(error);
  }
});

// POST /api/loans  { bookId, personName, startDate, dueDate, notes, force }
router.post("/", async (req, res, next) => {
  try {
    const { bookId, startDate, dueDate, notes } = req.body;
    const personName = String(req.body.personName || "")
      .trim()
      .replace(/\s+/g, " ");
    const force = Boolean(req.body.force);

    if (!bookId) return res.status(400).json({ error: "Escolha um livro." });
    if (!personName)
      return res
        .status(400)
        .json({ error: "Informe o nome de quem está levando o livro." });
    if (personName.split(" ").length < 2) {
      return res
        .status(400)
        .json({ error: "Digite o nome completo (nome e sobrenome)." });
    }
    if (!startDate)
      return res.status(400).json({ error: "Informe a data de retirada." });

    const book = await Book.findById(bookId);
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });

    const bookIsOut = await Loan.findOne({ book: book._id, status: "ativo" });
    if (bookIsOut) {
      return res.status(409).json({
        error: "Esse livro ja está com " + bookIsOut.personName + ".",
      });
    }

    const nameSort = normalizeText(personName);
    let person = await Person.findOne({ nameSort });

    if (person) {
      const openLoans = await Loan.find({ person: person._id, status: "ativo" })
        .select("bookTitle")
        .lean();
      // O front pergunta "tem certeza?" e reenvia com force = true.
      if (openLoans.length > 0 && !force) {
        return res.status(409).json({
          code: "PERSON_HAS_ACTIVE_LOAN",
          error:
            personName +
            " já está com " +
            openLoans.map((l) => l.bookTitle).join(", ") +
            ".",
          activeLoans: openLoans,
        });
      }
    } else {
      person = await Person.create({ fullName: personName });
    }

    const loan = await Loan.create({
      book: book._id,
      person: person._id,
      bookTitle: book.title,
      bookCover: book.cover,
      bookIsbn: book.isbn,
      bookTitleSort: normalizeText(book.title),
      personName,
      personNameSort: nameSort,
      startDate: new Date(startDate),
      dueDate: dueDate ? new Date(dueDate) : null,
      notes: notes || "",
      status: "ativo",
    });

    person.loansCount += 1;
    await person.save();

    return res.status(201).json(loan);
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/loans/:id/return -> confirma a devolucao
router.patch("/:id/return", async (req, res, next) => {
  try {
    const loan = await Loan.findById(req.params.id);
    if (!loan)
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    if (loan.status === "devolvido") {
      return res
        .status(409)
        .json({ error: "Esse emprestimo ja foi devolvido." });
    }

    loan.status = "devolvido";
    loan.returnedAt = new Date();
    await loan.save();

    return res.json(loan);
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/loans/:id -> apaga um registro (caso tenha sido criado por engano)
router.delete("/:id", async (req, res, next) => {
  try {
    const loan = await Loan.findByIdAndDelete(req.params.id);
    if (!loan)
      return res.status(404).json({ error: "Emprestimo não encontrado." });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
