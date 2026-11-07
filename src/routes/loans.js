import { Router } from "express";
import mongoose from "mongoose";
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
import { allWordsRegex, escapeRegex } from "../services/search.js";

const router = Router();
router.use(requireAdmin);

// Endereco com id que nem e id do banco: "nao encontrado", em vez do erro
// cru do Mongoose (500).
router.param("id", (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ error: "Empréstimo não encontrado." });
  }
  return next();
});

// GET /api/loans?status=ativo&book=texto&person=texto
router.get("/", async (req, res, next) => {
  try {
    const status = req.query.status || "ativo";
    const filter = {};
    if (status !== "todos") filter.status = status;

    const bookQuery = normalizeText(req.query.book || "");
    if (bookQuery) {
      filter.$or = [
        { bookTitleSort: allWordsRegex(bookQuery) },
        { bookIsbn: new RegExp(escapeRegex(bookQuery), "i") },
      ];
    }

    const personQuery = normalizeText(req.query.person || "");
    if (personQuery) {
      filter.personNameSort = allWordsRegex(personQuery);
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

// ---------- Datas (dia de Brasilia) ----------

// Cobranca de atraso pelo WhatsApp: no maximo uma a cada 30 dias por
// emprestimo, seja qual for o administrador.
const CHARGE_INTERVAL_DAYS = 30;
// Prazo estendido: no maximo um ano a frente de hoje (barra data digitada
// errada, como 2062 no lugar de 2026).
const MAX_EXTENSION_DAYS = 365;

function todayInBrazil() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

// O dia ("AAAA-MM-DD") de uma data salva, do mesmo jeito que o app mostra
// (utils/dates.js no front): meia-noite UTC e "so a data" (e assim que as
// datas dos campos chegam aqui); o resto vale pelo dia de Brasilia.
function dayOf(date) {
  if (!date) return "";
  const value = new Date(date);
  if (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  ) {
    return value.toISOString().slice(0, 10);
  }
  return value.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// O dia de Brasilia de um MOMENTO (ex.: quando cobrou).
function brazilDay(date) {
  return new Date(date).toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

// O dia em que a proxima cobranca fica liberada.
function nextChargeDay(sentAt) {
  return addDays(brazilDay(sentAt), CHARGE_INTERVAL_DAYS);
}

function addDays(day, days) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function brDate(day) {
  const [year, month, date] = day.split("-");
  return date + "/" + month + "/" + year;
}

// Atrasado = em andamento e o dia combinado ja passou (o proprio dia ainda
// esta no prazo), igual a barra dos cards.
function isOverdue(loan) {
  return (
    loan.status === "ativo" &&
    Boolean(loan.dueDate) &&
    todayInBrazil() > dayOf(loan.dueDate)
  );
}

// PATCH /api/loans/:id/notified
// Registra a COBRANCA do atraso pelo WhatsApp, em nome do administrador da
// sessao. O app registra ANTES de abrir o WhatsApp: com a regra de uma a cada
// 30 dias, quem decide se a cobranca pode sair e o servidor (dois
// administradores com a tela aberta nao cobram a mesma pessoa duas vezes).
router.patch("/:id/notified", async (req, res, next) => {
  try {
    const loan = await Loan.findById(req.params.id);
    if (!loan)
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    const current = async () => withAdminFlag(loan.toObject());
    if (loan.status !== "ativo") {
      return res.status(409).json({
        error: "Esse empréstimo já foi devolvido.",
        loan: await current(),
      });
    }
    if (!loan.personPhone) {
      return res.status(409).json({
        error: "Esse empréstimo não tem WhatsApp cadastrado.",
        loan: await current(),
      });
    }
    if (!isOverdue(loan)) {
      return res.status(409).json({
        error: "O prazo desse empréstimo ainda não venceu: a cobrança só vale para livro atrasado.",
        loan: await current(),
      });
    }

    // A conta e por DIA de Brasilia: cobrado no dia 7, libera no dia 7 do mes
    // seguinte (30 dias depois), a qualquer hora. Vale quem cobrou antes do
    // inicio (03:00 UTC) do dia "hoje - 29".
    const limit = new Date(
      addDays(todayInBrazil(), -(CHARGE_INTERVAL_DAYS - 1)) + "T03:00:00Z",
    );
    // Confere e grava de uma vez so: entre ler e gravar, outro administrador
    // pode ter cobrado, estendido o prazo ou confirmado a devolucao.
    const updated = await Loan.findOneAndUpdate(
      {
        _id: loan._id,
        status: "ativo",
        dueDate: loan.dueDate,
        $or: [{ overdueSentAt: null }, { overdueSentAt: { $lt: limit } }],
      },
      {
        overdueSentAt: new Date(),
        overdueSentBy: req.account._id,
        overdueSentByName: req.account.fullName,
      },
      { new: true },
    );
    if (!updated) {
      const fresh = await Loan.findById(loan._id);
      if (!fresh) {
        return res.status(404).json({ error: "Empréstimo não encontrado." });
      }
      const freshLoan = await withAdminFlag(fresh.toObject());
      let error =
        "Esse empréstimo acabou de mudar. Confira os detalhes e tente de novo.";
      if (fresh.status !== "ativo") {
        error = "Esse empréstimo acabou de ser devolvido.";
      } else if (!isOverdue(fresh)) {
        error =
          "O prazo desse empréstimo acabou de ser estendido: ele não está mais atrasado.";
      } else if (fresh.overdueSentAt && fresh.overdueSentAt >= limit) {
        error =
          (fresh.overdueSentByName || "Alguém") +
          " já cobrou essa pessoa em " +
          brDate(brazilDay(fresh.overdueSentAt)) +
          ". A próxima cobrança fica liberada em " +
          brDate(nextChargeDay(fresh.overdueSentAt)) +
          ".";
      }
      return res.status(409).json({ error, loan: freshLoan });
    }
    return res.json(await withAdminFlag(updated.toObject()));
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/loans/:id/due  { dueDate: "AAAA-MM-DD" }
// Estende o prazo de um emprestimo em andamento (em dia ou atrasado). A data
// nova vem depois da combinada e nao antes de hoje; o card passa a mostrar
// que o prazo foi estendido, por quem e qual era o anterior.
router.patch("/:id/due", async (req, res, next) => {
  try {
    const raw = String(req.body.dueDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return res.status(400).json({ error: "Escolha a nova data de devolução." });
    }
    const due = new Date(raw + "T00:00:00Z");
    if (Number.isNaN(due.getTime()) || dayOf(due) !== raw) {
      return res.status(400).json({ error: "A nova data de devolução não é válida." });
    }

    const loan = await Loan.findById(req.params.id);
    if (!loan)
      return res.status(404).json({ error: "Empréstimo não encontrado." });
    if (loan.status !== "ativo") {
      return res.status(409).json({
        error: "Esse empréstimo já foi devolvido; o prazo não pode mais mudar.",
        loan: await withAdminFlag(loan.toObject()),
      });
    }

    const today = todayInBrazil();
    const currentDay = dayOf(loan.dueDate);
    if (currentDay && raw <= currentDay) {
      return res.status(400).json({
        error:
          "Para estender, a nova data precisa ser depois de " +
          brDate(currentDay) +
          ", a devolução combinada agora.",
      });
    }
    if (raw < today) {
      return res.status(400).json({
        error: "A nova data de devolução não pode ser antes de hoje.",
      });
    }
    if (raw < dayOf(loan.startDate)) {
      return res.status(400).json({
        error: "A nova data de devolução não pode ser anterior à da retirada.",
      });
    }
    if (raw > addDays(today, MAX_EXTENSION_DAYS)) {
      return res.status(400).json({
        error: "O prazo pode ser estendido por até um ano a partir de hoje.",
      });
    }

    // So grava se o prazo ainda for o que foi conferido acima (outro
    // administrador pode ter acabado de estender).
    const updated = await Loan.findOneAndUpdate(
      { _id: loan._id, status: "ativo", dueDate: loan.dueDate },
      {
        $set: { dueDate: due, reminderSentAt: null },
        $push: {
          dueExtensions: {
            from: loan.dueDate,
            to: due,
            at: new Date(),
            by: req.account._id,
            byName: req.account.fullName,
          },
        },
      },
      { new: true },
    );
    if (!updated) {
      // Manda o emprestimo de agora: a janela passa a mostrar o prazo novo.
      const fresh = await Loan.findById(loan._id);
      return res.status(409).json({
        error:
          fresh && fresh.status !== "ativo"
            ? "Esse empréstimo acabou de ser devolvido; o prazo não pode mais mudar."
            : "Outro administrador acabou de mudar o prazo desse empréstimo. Confira a data combinada agora e escolha de novo.",
        loan: fresh ? await withAdminFlag(fresh.toObject()) : null,
      });
    }
    return res.json(await withAdminFlag(updated.toObject()));
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
