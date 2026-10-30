/**
 * Registro de um emprestimo. Fica aqui porque dois caminhos chegam nele com
 * as MESMAS regras: o "Novo empréstimo" (POST /api/loans) e o "Realizar
 * empréstimo" de uma solicitacao (POST /api/requests/:id/loan).
 */
import Loan from "../models/Loan.js";
import Book, { normalizeText } from "../models/Book.js";
import Person from "../models/Person.js";
import { conflict, overbooked } from "./occupancy.js";
import { syncActiveLoans } from "./people.js";

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Le e confere as datas do emprestimo. Devolve { start, due } ou lanca 400.
 * As datas sao conferidas no SERVIDOR, nao so na tela: um prazo antes da
 * retirada faria a barra de progresso contar um tempo negativo.
 * A devolucao combinada e obrigatoria: a tela comeca com ela vazia para o
 * administrador combinar a data com a pessoa (emprestimos antigos sem data
 * continuam valendo; isto so vale para os novos).
 */
export function readLoanDates(startDate, dueDate) {
  if (!startDate) throw badRequest("Informe a data de retirada.");
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    throw badRequest("A data de retirada não é válida.");
  }
  if (!dueDate) {
    throw badRequest("Preencha a data de devolução combinada com a pessoa.");
  }
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) {
    throw badRequest("A data de devolução não é válida.");
  }
  if (due < start) {
    throw badRequest("A data de devolução não pode ser anterior à da retirada.");
  }
  return { start, due };
}

/**
 * Livros que a pessoa ja tem em maos. O front pergunta "tem certeza?" e
 * reenvia com force = true (resposta 409 com code PERSON_HAS_ACTIVE_LOAN).
 */
export async function activeLoanWarning(person) {
  const openLoans = await Loan.find({ person: person._id, status: "ativo" })
    .select("bookTitle")
    .lean();
  if (!openLoans.length) return null;
  return {
    code: "PERSON_HAS_ACTIVE_LOAN",
    error:
      person.fullName +
      " já está com " +
      openLoans.map((l) => l.bookTitle).join(", ") +
      ".",
    activeLoans: openLoans,
  };
}

/**
 * Grava o emprestimo e sobe os contadores. Quem chama ja conferiu que sobra
 * exemplar (a conferencia de DEPOIS de gravar e feita aqui).
 *
 * - account: o administrador da sessao (req.account) - QUEM APROVOU sai
 *   sempre dela, nunca do que o app mandou.
 * - phone: numero novo de WhatsApp digitado na hora ("" = manter o da ficha).
 * - exceptRequestId: a solicitacao que esta virando este emprestimo.
 */
export async function recordLoan({
  book,
  person,
  account,
  start,
  due,
  notes = "",
  phone = "",
  exceptRequestId = null,
}) {
  // Trocou de numero: o cadastro da pessoa passa a valer com o novo, e os
  // emprestimos que ela ja tem em andamento tambem (o aviso de devolucao
  // precisa ir para o numero certo).
  const phoneChanged = Boolean(phone) && person.phone !== phone;
  const personPhone = phoneChanged ? phone : person.phone || "";

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
    personPhone,
    approvedBy: account._id,
    approvedByName: account.fullName,
    startDate: start,
    dueDate: due,
    notes: String(notes || ""),
    status: "ativo",
  });

  if (await overbooked(book, { exceptRequestId })) {
    await Loan.deleteOne({ _id: loan._id });
    throw conflict(
      "Outro administrador acabou de registrar o último exemplar desse livro. Atualize a tela e confira.",
    );
  }

  // Os dois contadores sobem com $inc, que soma no proprio banco: dois
  // emprestimos ao mesmo tempo nao se atropelam, como aconteceria lendo o
  // numero e gravando de volta. O numero novo de WhatsApp, quando ha, e
  // gravado na mesma ida ao banco.
  await Promise.all([
    Person.updateOne(
      { _id: person._id },
      {
        $inc: { loansCount: 1 },
        ...(phoneChanged ? { $set: { phone: personPhone } } : {}),
      },
    ),
    Book.updateOne({ _id: book._id }, { $inc: { loansTotal: 1 } }),
  ]);
  if (phoneChanged) {
    person.phone = personPhone;
    await syncActiveLoans(person);
  }

  return loan;
}
