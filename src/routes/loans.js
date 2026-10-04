import { Router } from "express";
import Loan from "../models/Loan.js";
import Book, { normalizeText } from "../models/Book.js";
import Person from "../models/Person.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// Aceita "(83) 99999-8888", "83999998888" ou "+55 83 99999-8888" e devolve
// so os digitos com DDI (5583999998888). Vazio e permitido (campo opcional).
// Devolve null quando o numero e invalido.
export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  if (!/^55\d{10,11}$/.test(digits)) return null;
  return digits;
}

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
    const phone = normalizePhone(req.body.phone);

    if (phone === null) {
      return res.status(400).json({
        error: "WhatsApp inválido. Use o DDD e o número, ex.: (83) 99999-8888.",
      });
    }
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
      person = await Person.create({ fullName: personName, phone });
    }

    // Guarda o ultimo WhatsApp informado para sugerir no proximo emprestimo.
    if (phone && person.phone !== phone) person.phone = phone;

    const loan = await Loan.create({
      book: book._id,
      person: person._id,
      bookTitle: book.title,
      bookCover: book.cover,
      bookIsbn: book.isbn,
      bookTitleSort: normalizeText(book.title),
      personName,
      personNameSort: nameSort,
      personPhone: phone,
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

// PATCH /api/loans/:id/notified  { kind: "reminder" | "overdue" }
// Registra que o administrador abriu o WhatsApp para avisar a pessoa.
router.patch("/:id/notified", async (req, res, next) => {
  try {
    const field =
      req.body.kind === "overdue" ? "overdueSentAt" : "reminderSentAt";
    const loan = await Loan.findByIdAndUpdate(
      req.params.id,
      { [field]: new Date() },
      { new: true },
    );
    if (!loan)
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    return res.json(loan);
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
