import { Router } from "express";
import Loan from "../models/Loan.js";
import Book, { normalizeText } from "../models/Book.js";
import Person from "../models/Person.js";
import { requireAdmin } from "../middleware/auth.js";
import { normalizePhone, PHONE_ERROR } from "../services/phone.js";
import { withAdminFlag } from "../services/people.js";
import { noFreeCopyMessage } from "../services/occupancy.js";
import {
  activeLoanWarning,
  readLoanDates,
  recordLoan,
} from "../services/loans.js";
import { announceAvailability } from "../services/returnAlerts.js";

const router = Router();
router.use(requireAdmin);

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
    // Selo "admin" do lado do nome de quem pegou o livro.
    return res.json(await withAdminFlag(loans));
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
    return res.json(await withAdminFlag(loan));
  } catch (error) {
    return next(error);
  }
});

// POST /api/loans  { bookId, personId, startDate, dueDate, notes, force }
router.post("/", async (req, res, next) => {
  try {
    const { bookId, startDate, dueDate, notes } = req.body;
    const force = Boolean(req.body.force);
    const phone = normalizePhone(req.body.phone);

    if (phone === null) {
      return res.status(400).json({ error: PHONE_ERROR });
    }
    if (!bookId) return res.status(400).json({ error: "Escolha um livro." });
    // A pessoa precisa estar cadastrada ANTES do emprestimo: sem personId nao
    // ha ficha para cobrar a devolucao depois. O cadastro e feito na tela de
    // Usuarios (ou pelo "Cadastrar nova pessoa" do proprio Novo emprestimo) -
    // esta rota nunca cria gente a partir so de um nome digitado.
    if (!req.body.personId) {
      return res.status(400).json({
        error: "Selecione a pessoa cadastrada antes de registrar o empréstimo.",
      });
    }
    const { start, due } = readLoanDates(startDate, dueDate);

    const book = await Book.findById(bookId);
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });

    // Emprestimo so e permitido enquanto sobrar algum exemplar na estante.
    // Exemplar SOLICITADO nao esta na estante: ele so sai pela propria
    // solicitacao, para a pessoa que pediu (ver routes/requests.js).
    const busy = await noFreeCopyMessage(book);
    if (busy) return res.status(409).json({ error: busy });

    // QUEM esta levando o livro: sempre a pessoa escolhida na lista de
    // sugestoes (personId) - o cadastro dela e a identidade, nunca um nome
    // digitado na hora (ver models/Person.js).
    const person = await Person.findById(req.body.personId);
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }

    // O front pergunta "tem certeza?" e reenvia com force = true.
    const warning = force ? null : await activeLoanWarning(person);
    if (warning) return res.status(409).json(warning);

    const loan = await recordLoan({
      book,
      person,
      account: req.account,
      start,
      due,
      notes,
      phone,
    });

    return res.status(201).json(await withAdminFlag(loan.toObject()));
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
    return res.json(await withAdminFlag(loan.toObject()));
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/loans/:id/notes  { notes }
// So pode anotar enquanto o emprestimo esta em andamento: depois de
// devolvido, o registro fica congelado (ver /return).
router.patch("/:id/notes", async (req, res, next) => {
  try {
    const loan = await Loan.findById(req.params.id);
    if (!loan)
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    if (loan.status === "devolvido") {
      return res.status(409).json({
        error: "Esse empréstimo já foi devolvido; a observação não pode mais ser alterada.",
      });
    }

    loan.notes = String(req.body.notes || "");
    await loan.save();

    return res.json(await withAdminFlag(loan.toObject()));
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
        .json({ error: "Esse empréstimo já foi devolvido." });
    }

    loan.status = "devolvido";
    loan.returnedAt = new Date();
    await loan.save();

    // Quem pediu "Avise-me quando voltar" no acervo publico recebe a
    // notificacao agora. Nao atrasa esta resposta (ver services/returnAlerts.js).
    announceAvailability(loan.book);

    return res.json(await withAdminFlag(loan.toObject()));
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/loans/:id -> apaga um registro (caso tenha sido criado por engano)
router.delete("/:id", async (req, res, next) => {
  try {
    const loan = await Loan.findByIdAndDelete(req.params.id);
    if (!loan)
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    // Registro apagado = emprestimo que nao aconteceu: os dois contadores
    // voltam atras, os mesmos que o registro fez subir. O "$gt: 0" no filtro
    // impede numero negativo.
    await Promise.all([
      Book.updateOne(
        { _id: loan.book, loansTotal: { $gt: 0 } },
        { $inc: { loansTotal: -1 } },
      ),
      Person.updateOne(
        { _id: loan.person, loansCount: { $gt: 0 } },
        { $inc: { loansCount: -1 } },
      ),
    ]);
    // Apagar um emprestimo em andamento devolve o exemplar a estante: quem
    // pediu aviso do livro tambem fica sabendo.
    if (loan.status === "ativo") announceAvailability(loan.book);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
