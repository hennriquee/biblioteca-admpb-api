/**
 * EXEMPLARES OCUPADOS. Um exemplar sai da estante de dois jeitos:
 *
 * - emprestado (Loan com status "ativo");
 * - solicitado (LoanRequest com status "solicitado" ou "convertendo"): a
 *   retirada ja foi combinada com uma pessoa, entao ninguem mais pode
 *   solicitar nem levar esse exemplar.
 *
 * Disponivel = exemplares - emprestados - solicitados. E a mesma conta em
 * todo lugar (acervo do painel, acervo publico, novo emprestimo, nova
 * solicitacao, "Avise-me quando voltar", quantidade minima ao editar o
 * livro): por isso ela mora aqui.
 *
 * A solicitacao "pendente" (so o link do WhatsApp, ainda nao combinada) NAO
 * ocupa exemplar - ver models/LoanRequest.js.
 */
import mongoose from "mongoose";
import Loan from "../models/Loan.js";
import LoanRequest from "../models/LoanRequest.js";

export const OCCUPYING_REQUEST = ["solicitado", "convertendo"];

function toObjectIds(ids) {
  return ids.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)),
  );
}

/**
 * O que cada livro tem fora da estante: Map(id -> { loaned, loanedNames,
 * nextDue, requested, requestedNames }). Sem bookIds, olha o acervo todo
 * (so os livros com algo fora aparecem no Map).
 *
 * Os NOMES sao do painel. As rotas publicas usam so as contagens e a data
 * (ver routes/public.js) - nome nunca sai de la.
 */
export async function occupancyByBook(bookIds = null) {
  const bookMatch = bookIds ? { book: { $in: toObjectIds(bookIds) } } : {};
  const [loans, requests] = await Promise.all([
    Loan.aggregate([
      { $match: { status: "ativo", ...bookMatch } },
      { $sort: { startDate: 1, _id: 1 } },
      {
        $group: {
          _id: "$book",
          count: { $sum: 1 },
          names: { $push: "$personName" },
          // O $min ignora emprestimo sem prazo: com dois exemplares fora, um
          // com data combinada e outro sem, vale a data que existe.
          nextDue: { $min: "$dueDate" },
        },
      },
    ]),
    LoanRequest.aggregate([
      { $match: { status: { $in: OCCUPYING_REQUEST }, ...bookMatch } },
      { $sort: { pickupDate: 1, _id: 1 } },
      { $group: { _id: "$book", count: { $sum: 1 }, names: { $push: "$personName" } } },
    ]),
  ]);

  const map = new Map();
  const entry = (id) => {
    const key = String(id);
    if (!map.has(key)) {
      map.set(key, {
        loaned: 0,
        loanedNames: [],
        nextDue: null,
        requested: 0,
        requestedNames: [],
      });
    }
    return map.get(key);
  };
  loans.forEach((row) => {
    const item = entry(row._id);
    item.loaned = row.count;
    item.loanedNames = row.names;
    item.nextDue = row.nextDue || null;
  });
  requests.forEach((row) => {
    const item = entry(row._id);
    item.requested = row.count;
    item.requestedNames = row.names;
  });
  return map;
}

export const NOTHING_OUT = Object.freeze({
  loaned: 0,
  loanedNames: [],
  nextDue: null,
  requested: 0,
  requestedNames: [],
});

/** Disponiveis de um livro, dado o que esta fora (nunca negativo). */
export function availableOf(book, out = NOTHING_OUT) {
  return Math.max(0, (book.copies || 1) - out.loaned - out.requested);
}

/**
 * Quantos exemplares do livro estao fora agora. exceptRequestId: a
 * solicitacao que esta virando emprestimo nao conta duas vezes (ela e o
 * proprio emprestimo que acabou de nascer).
 */
export async function occupiedCount(bookId, { exceptRequestId = null } = {}) {
  const requestFilter = { book: bookId, status: { $in: OCCUPYING_REQUEST } };
  if (exceptRequestId) requestFilter._id = { $ne: exceptRequestId };
  const [loans, requests] = await Promise.all([
    Loan.countDocuments({ book: bookId, status: "ativo" }),
    LoanRequest.countDocuments(requestFilter),
  ]);
  return loans + requests;
}

/**
 * Mensagem de "nao sobrou exemplar" (ou null quando sobrou). Fala com o
 * painel, entao pode dizer com quem o livro esta.
 */
export async function noFreeCopyMessage(book) {
  const out = (await occupancyByBook([book._id])).get(String(book._id)) || NOTHING_OUT;
  const copies = book.copies || 1;
  if (availableOf(book, out) > 0) return null;
  if (copies === 1) {
    if (out.requested) {
      return (
        "Esse livro já está solicitado por " +
        (out.requestedNames[0] || "outra pessoa") +
        ". Ele só pode sair por essa solicitação (em Empréstimos > Solicitados)."
      );
    }
    return "Esse livro já está com " + (out.loanedNames[0] || "outra pessoa") + ".";
  }
  if (!out.requested) {
    return "Todas as " + copies + " unidades desse livro já estão emprestadas.";
  }
  return (
    "Todas as " +
    copies +
    " unidades desse livro já estão emprestadas ou solicitadas."
  );
}

/**
 * Conferencia DEPOIS de gravar: dois administradores registrando o ultimo
 * exemplar no mesmo instante passariam os dois pela conferencia de antes
 * (cada um ve um exemplar livre). Quem grava confere de novo e, se passou do
 * numero de exemplares, desfaz o que acabou de gravar. No pior caso os dois
 * desfazem e um tenta de novo - nunca saem dois com o mesmo exemplar.
 */
export async function overbooked(book, options = {}) {
  return (await occupiedCount(book._id, options)) > (book.copies || 1);
}

export function conflict(message, extra = {}) {
  const error = new Error(message);
  error.status = 409;
  Object.assign(error, extra);
  return error;
}
