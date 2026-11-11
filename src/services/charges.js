import Loan from '../models/Loan.js';
import { withAdminFlag } from './people.js';
import {
  addDays,
  brDate,
  brazilDay,
  dayOf,
  todayInBrazil,
} from './brDates.js';

/**
 * COBRANCA de atraso pelo WhatsApp: no maximo uma a cada 30 dias por
 * emprestimo, seja qual for o administrador. Quem decide se ela pode sair e o
 * servidor (dois administradores com a tela aberta nao cobram a mesma pessoa
 * duas vezes). Usada por PATCH /api/loans/:id/notified (abrir o WhatsApp do
 * celular) e pelo envio de dentro do painel (routes/whatsapp.js).
 */

export const CHARGE_INTERVAL_DAYS = 30;

// O dia em que a proxima cobranca fica liberada.
function nextChargeDay(sentAt) {
  return addDays(brazilDay(sentAt), CHARGE_INTERVAL_DAYS);
}

// Atrasado = em andamento e o dia combinado ja passou (o proprio dia ainda
// esta no prazo), igual a barra dos cards.
export function isOverdue(loan) {
  return (
    loan.status === 'ativo' &&
    Boolean(loan.dueDate) &&
    todayInBrazil() > dayOf(loan.dueDate)
  );
}

/**
 * Registra a cobranca em nome do administrador.
 * @returns {Promise<
 *   | { ok: true, loan: object, previous: object, stamp: Date }
 *   | { ok: false, status: number, body: object }
 * >} body e exatamente o que a rota devolve.
 */
export async function registerCharge(loanId, account) {
  const loan = await Loan.findById(loanId);
  if (!loan) {
    return { ok: false, status: 404, body: { error: 'Empréstimo não encontrado.' } };
  }
  const refuse = async (status, error) => ({
    ok: false,
    status,
    body: { error, loan: await withAdminFlag(loan.toObject()) },
  });
  if (loan.status !== 'ativo') {
    return refuse(409, 'Esse empréstimo já foi devolvido.');
  }
  if (!loan.personPhone) {
    return refuse(409, 'Esse empréstimo não tem WhatsApp cadastrado.');
  }
  if (!isOverdue(loan)) {
    return refuse(
      409,
      'O prazo desse empréstimo ainda não venceu: a cobrança só vale para livro atrasado.'
    );
  }

  // A conta e por DIA de Brasilia: cobrado no dia 7, libera no dia 7 do mes
  // seguinte (30 dias depois), a qualquer hora. Vale quem cobrou antes do
  // inicio (03:00 UTC) do dia "hoje - 29".
  const limit = new Date(
    addDays(todayInBrazil(), -(CHARGE_INTERVAL_DAYS - 1)) + 'T03:00:00Z'
  );
  const previous = {
    overdueSentAt: loan.overdueSentAt || null,
    overdueSentBy: loan.overdueSentBy || null,
    overdueSentByName: loan.overdueSentByName || '',
  };
  const stamp = new Date();
  // Confere e grava de uma vez so: entre ler e gravar, outro administrador
  // pode ter cobrado, estendido o prazo ou confirmado a devolucao.
  const updated = await Loan.findOneAndUpdate(
    {
      _id: loan._id,
      status: 'ativo',
      dueDate: loan.dueDate,
      $or: [{ overdueSentAt: null }, { overdueSentAt: { $lt: limit } }],
    },
    {
      overdueSentAt: stamp,
      overdueSentBy: account._id,
      overdueSentByName: account.fullName,
    },
    { new: true }
  );
  if (!updated) {
    const fresh = await Loan.findById(loan._id);
    if (!fresh) {
      return { ok: false, status: 404, body: { error: 'Empréstimo não encontrado.' } };
    }
    const freshLoan = await withAdminFlag(fresh.toObject());
    let error =
      'Esse empréstimo acabou de mudar. Confira os detalhes e tente de novo.';
    if (fresh.status !== 'ativo') {
      error = 'Esse empréstimo acabou de ser devolvido.';
    } else if (!isOverdue(fresh)) {
      error =
        'O prazo desse empréstimo acabou de ser estendido: ele não está mais atrasado.';
    } else if (fresh.overdueSentAt && fresh.overdueSentAt >= limit) {
      error =
        (fresh.overdueSentByName || 'Alguém') +
        ' já cobrou essa pessoa em ' +
        brDate(brazilDay(fresh.overdueSentAt)) +
        '. A próxima cobrança fica liberada em ' +
        brDate(nextChargeDay(fresh.overdueSentAt)) +
        '.';
    }
    return { ok: false, status: 409, body: { error, loan: freshLoan } };
  }
  return {
    ok: true,
    loan: await withAdminFlag(updated.toObject()),
    previous,
    stamp,
  };
}

/**
 * Desfaz a cobranca que acabou de ser registrada (a mensagem nao saiu). So
 * desfaz se o registro ainda for o desta cobranca: se outra pessoa mexeu
 * depois, nao pisa em cima.
 */
export async function undoCharge(loanId, { previous, stamp }) {
  await Loan.updateOne(
    { _id: loanId, overdueSentAt: stamp },
    {
      $set: {
        overdueSentAt: previous.overdueSentAt,
        overdueSentBy: previous.overdueSentBy,
        overdueSentByName: previous.overdueSentByName,
      },
    }
  );
  return Loan.findById(loanId);
}
