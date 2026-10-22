import { Router } from "express";
import Loan from "../models/Loan.js";
import Book, { normalizeText } from "../models/Book.js";
import Person from "../models/Person.js";
import { requireAdmin } from "../middleware/auth.js";
import { normalizePhone, PHONE_ERROR } from "../services/phone.js";
import { syncActiveLoans, withAdminFlag } from "../services/people.js";
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
    if (!startDate)
      return res.status(400).json({ error: "Informe a data de retirada." });

    // As datas sao conferidas AQUI, nao so na tela: a tela e uma das formas de
    // chamar a API, e um prazo antes da retirada faria a barra de progresso
    // contar um tempo negativo.
    const start = new Date(startDate);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "A data de retirada não é válida." });
    }
    let due = null;
    if (dueDate) {
      due = new Date(dueDate);
      if (Number.isNaN(due.getTime())) {
        return res
          .status(400)
          .json({ error: "A data de devolução não é válida." });
      }
      if (due < start) {
        return res.status(400).json({
          error: "A data de devolução não pode ser anterior à da retirada.",
        });
      }
    }

    const book = await Book.findById(bookId);
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });

    // Emprestimo so e permitido enquanto sobrar algum exemplar na estante.
    const copies = book.copies || 1;
    const bookLoans = await Loan.find({ book: book._id, status: "ativo" })
      .select("personName")
      .lean();
    if (bookLoans.length >= copies) {
      return res.status(409).json({
        error:
          copies === 1
            ? "Esse livro já está com " + bookLoans[0].personName + "."
            : "Todas as " +
              copies +
              " unidades desse livro já estão emprestadas.",
      });
    }

    // QUEM esta levando o livro: sempre a pessoa escolhida na lista de
    // sugestoes (personId) - o cadastro dela e a identidade, nunca um nome
    // digitado na hora (ver models/Person.js).
    const person = await Person.findById(req.body.personId);
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }

    const openLoans = await Loan.find({ person: person._id, status: "ativo" })
      .select("bookTitle")
      .lean();
    // O front pergunta "tem certeza?" e reenvia com force = true.
    if (openLoans.length > 0 && !force) {
      return res.status(409).json({
        code: "PERSON_HAS_ACTIVE_LOAN",
        error:
          person.fullName +
          " já está com " +
          openLoans.map((l) => l.bookTitle).join(", ") +
          ".",
        activeLoans: openLoans,
      });
    }

    // Trocou de numero: o cadastro da pessoa passa a valer com o novo, e os
    // emprestimos que ela ja tem em andamento tambem (o aviso de devolucao
    // precisa ir para o numero certo).
    const phoneChanged = Boolean(phone) && person.phone !== phone;
    if (phoneChanged) person.phone = phone;

    const loan = await Loan.create({
      book: book._id,
      person: person._id,
      bookTitle: book.title,
      bookCover: book.cover,
      bookIsbn: book.isbn,
      bookTitleSort: normalizeText(book.title),
      personName: person.fullName,
      personNameSort: normalizeText(person.fullName),
      personCode: person.code || null,
      personPhone: person.phone || "",
      // QUEM APROVOU: o administrador que esta registrando o emprestimo. Sai
      // da sessao (req.account), nunca do que o app mandou - ninguem assina
      // um emprestimo no lugar de outra pessoa.
      approvedBy: req.account._id,
      approvedByName: req.account.fullName,
      startDate: start,
      dueDate: due,
      notes: notes || "",
      status: "ativo",
    });

    // Os dois contadores sobem com $inc, que soma no proprio banco: dois
    // emprestimos ao mesmo tempo nao se atropelam, como aconteceria lendo o
    // numero e gravando de volta. O numero novo de WhatsApp, quando ha, e
    // gravado na mesma ida ao banco.
    await Promise.all([
      Person.updateOne(
        { _id: person._id },
        {
          $inc: { loansCount: 1 },
          ...(phoneChanged ? { $set: { phone: person.phone } } : {}),
        },
      ),
      Book.updateOne({ _id: book._id }, { $inc: { loansTotal: 1 } }),
    ]);
    if (phoneChanged) await syncActiveLoans(person);

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
