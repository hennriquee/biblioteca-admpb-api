/**
 * Regras de "quem e quem" compartilhadas pelas rotas de pessoas, de
 * administradores e de emprestimos. Ver o comentario grande em
 * models/Person.js.
 */
import Person from "../models/Person.js";
import LegacyUser from "../models/User.js";
import Loan from "../models/Loan.js";
import LoanRequest from "../models/LoanRequest.js";
import Counter from "../models/Counter.js";
import { normalizeText } from "../models/Book.js";
import { normalizePhone, PHONE_ERROR } from "./phone.js";

export const MAX_NAME_LENGTH = 80;

export const NAME_ERROR = "Digite o nome completo (nome e sobrenome).";

// Pessoa que entra no painel = pessoa com login. Usado nos filtros do Mongo.
export const IS_ADMIN_FILTER = { username: { $type: "string" } };

// Tira espacos sobrando. Nome de pessoa precisa de nome e sobrenome: com so
// uma palavra, duas pessoas diferentes viram "a Maria" e ninguem se acha.
export function cleanPersonName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_NAME_LENGTH);
}

export function isFullName(name) {
  return cleanPersonName(name).split(" ").filter(Boolean).length >= 2;
}

// Le nome e telefone do corpo da requisicao e devolve { fullName, phone } ou
// uma mensagem de erro em "error". Fica aqui porque as duas telas que
// cadastram gente usam as MESMAS regras: a tela "Usuarios" do painel
// (routes/people.js) e a de manutencao (routes/dev.js).
export function readPersonFields(body) {
  const fullName = cleanPersonName(body.fullName ?? body.name);
  if (!fullName) return { error: "Informe o nome da pessoa." };
  if (!isFullName(fullName)) return { error: NAME_ERROR };

  const phone = normalizePhone(body.phone);
  if (phone === null) return { error: PHONE_ERROR };

  return { fullName, phone };
}

// Proximo numero visivel de pessoa (#1, #2, #3...). O $inc e atomico: dois
// cadastros ao mesmo tempo recebem numeros diferentes. Numero nunca e
// reaproveitado - se a pessoa #3 for excluida, ninguem mais sera #3.
export async function nextPersonCode() {
  const counter = await Counter.findByIdAndUpdate(
    "person",
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return counter.seq;
}

// UNICO lugar que cria pessoa. Garante que toda pessoa nasca com numero.
// Nasce sempre SEM login: virar administrador e um segundo passo, feito so
// pela tela de manutencao (routes/dev.js).
export async function createPerson({
  fullName,
  phone = "",
  photo = "",
  photoPublicId = "",
}) {
  return Person.create({
    code: await nextPersonCode(),
    fullName,
    phone: phone || "",
    photo: photo || "",
    photoPublicId: photoPublicId || "",
    username: null,
    passwordHash: null,
  });
}

// Pessoas (menos a propria, ao editar) que ja usam este nome ou este telefone.
// E so um AVISO: o front pergunta se e a mesma pessoa e, se for outra, manda
// de novo com force = true. Duas pessoas podem ter o mesmo nome, e uma familia
// pode compartilhar um WhatsApp.
export async function findSimilarPeople({ fullName, phone, exceptId }) {
  const or = [];
  if (fullName) or.push({ nameSort: normalizeText(fullName) });
  if (phone) or.push({ phone });
  if (!or.length) return { sameName: [], samePhone: [] };

  const filter = { $or: or };
  if (exceptId) filter._id = { $ne: exceptId };
  // A foto vai junto: e ela que faz o app conseguir mostrar o rosto de cada
  // candidata na pergunta "e a mesma pessoa?" (ver SamePersonDialog).
  const found = await Person.find(filter)
    .select("code fullName phone photo")
    .lean();

  const nameKey = fullName ? normalizeText(fullName) : null;
  return {
    sameName: nameKey
      ? found.filter((p) => normalizeText(p.fullName) === nameKey)
      : [],
    samePhone: phone ? found.filter((p) => p.phone === phone) : [],
  };
}

// "#3 Maria Silva (WhatsApp 5534...)": como uma pessoa e citada nos avisos.
export function describePerson(person) {
  return (
    (person.code ? "#" + person.code + " " : "") +
    person.fullName +
    (person.phone ? " (WhatsApp " + person.phone + ")" : " (sem WhatsApp)")
  );
}

// Monta a mensagem do aviso de pessoa parecida (null = nada parecido).
export function similarPeopleWarning({ sameName, samePhone }, fullName) {
  if (sameName.length) {
    const other = sameName[0];
    return {
      code: "PERSON_NAME_EXISTS",
      error:
        "Já existe " + describePerson(other) + " no cadastro. É a mesma pessoa?",
      people: sameName,
    };
  }
  if (samePhone.length) {
    const other = samePhone[0];
    return {
      code: "PERSON_PHONE_EXISTS",
      error:
        "Esse WhatsApp já é de " +
        other.fullName +
        ". Duas pessoas podem usar o mesmo número (família), mas confira se não é a mesma pessoa.",
      people: samePhone,
    };
  }
  return null;
}

// Acrescenta a cada emprestimo se quem pegou o livro e administrador (o app
// mostra um selo "admin" do lado do nome). Uma consulta so, com os ids que
// aparecem na lista.
export async function withAdminFlag(loans) {
  const list = Array.isArray(loans) ? loans : [loans];
  const ids = [...new Set(list.map((loan) => String(loan.person)))];
  const admins = await Person.find({ _id: { $in: ids }, ...IS_ADMIN_FILTER })
    .select("_id")
    .lean();
  const adminIds = new Set(admins.map((person) => String(person._id)));
  const marked = list.map((loan) => ({
    ...loan,
    personIsAdmin: adminIds.has(String(loan.person)),
  }));
  return Array.isArray(loans) ? marked : marked[0];
}

// Nome/telefone mudaram: os emprestimos EM ANDAMENTO passam a mostrar o dado
// novo (e o aviso de devolucao vai para o numero novo). Os ja devolvidos
// guardam o que valia na epoca - e historico.
// As solicitacoes registradas (ainda nao retiradas) acompanham do mesmo jeito.
export async function syncActiveLoans(person) {
  const fields = {
    personName: person.fullName,
    personNameSort: normalizeText(person.fullName),
    personPhone: person.phone || "",
  };
  await Promise.all([
    Loan.updateMany({ person: person._id, status: "ativo" }, fields),
    LoanRequest.updateMany(
      { person: person._id, status: { $in: ["solicitado", "convertendo"] } },
      fields,
    ),
  ]);
}

// O administrador que aprovou emprestimos mudou de nome: os registros dele
// passam a mostrar o nome novo, inclusive no historico - e a mesma pessoa, so
// escrita certo. (Diferente do nome de QUEM PEGOU o livro, que no historico
// fica como estava na epoca: ali o nome e parte do registro do emprestimo.)
export async function syncApprovedByName(person) {
  await Promise.all([
    Loan.updateMany(
      { approvedBy: person._id },
      { approvedByName: person.fullName },
    ),
    // Quem registrou uma solicitacao, pelo mesmo motivo.
    LoanRequest.updateMany(
      { registeredBy: person._id },
      { registeredByName: person.fullName },
    ),
  ]);
}

/**
 * Numera as pessoas que foram cadastradas antes de existir o numero visivel.
 * Roda uma vez, no inicio do servidor: as mais antigas ficam com os numeros
 * menores (ordem de cadastro). Devolve quantas foram numeradas.
 */
export async function backfillPersonCodes() {
  const withoutCode = await Person.find({
    $or: [{ code: null }, { code: { $exists: false } }],
  })
    .sort({ createdAt: 1, _id: 1 })
    .select("_id")
    .lean();
  if (!withoutCode.length) return 0;

  // O contador comeca do maior numero que ja existe, para nao repetir.
  const highest = await Person.findOne({ code: { $ne: null } })
    .sort({ code: -1 })
    .select("code")
    .lean();
  let next = (highest?.code || 0) + 1;
  await Counter.findByIdAndUpdate(
    "person",
    { $max: { seq: next - 1 } },
    { upsert: true },
  );

  for (const person of withoutCode) {
    await Person.updateOne(
      { _id: person._id },
      { code: await nextPersonCode() },
    );
  }
  return withoutCode.length;
}

/**
 * Emprestimo guarda uma copia do numero de quem pegou o livro (como ja guarda
 * o nome), para o historico continuar legivel. Preenche os que vieram de antes.
 */
export async function backfillLoanPersonCodes() {
  const loans = await Loan.find({
    $or: [{ personCode: null }, { personCode: { $exists: false } }],
  })
    .select("person")
    .lean();
  if (!loans.length) return 0;

  const people = await Person.find({
    _id: { $in: loans.map((loan) => loan.person) },
  })
    .select("code")
    .lean();
  const codeById = new Map(people.map((p) => [String(p._id), p.code]));

  let filled = 0;
  for (const loan of loans) {
    const code = codeById.get(String(loan.person));
    if (!code) continue; // pessoa excluida: o historico fica sem numero
    await Loan.updateOne({ _id: loan._id }, { personCode: code });
    filled += 1;
  }
  return filled;
}

/**
 * MUDANCA DE CASA DAS CONTAS DE ADMINISTRADOR.
 *
 * Antes, a conta (login, senha e foto) vivia na colecao "users" e apontava
 * para a Pessoa. Hoje login e senha sao dois campos da propria Pessoa, e e
 * isso que permite transformar um usuario em administrador. Esta funcao roda
 * ao iniciar o servidor e leva cada conta que ficou la para a ficha da pessoa.
 *
 * Roda uma vez por conta: a levada recebe "mergedAt" e nao e olhada de novo -
 * senao, uma senha trocada depois voltaria para a antiga no proximo reinicio.
 * A colecao antiga nao e apagada: fica como copia de seguranca.
 *
 * QUANDO NAO DA PARA LEVAR (a ficha ja tem outro login, o login ja e de
 * outra pessoa, a conta nao aponta para ficha nenhuma): a conta NAO e
 * marcada como levada. Ela recebe "skippedAt" com o motivo e o motivo vai
 * para o log, para a conta nao sumir em silencio. O login dela deixa de
 * existir, e quem resolve e a tela de manutencao, dando um login novo a
 * pessoa certa - nunca este script adivinhando de quem era a conta.
 *
 * Devolve { moved, skipped: [{ username, reason }] }.
 */
export async function mergeLegacyAdminAccounts() {
  const legacy = await LegacyUser.find({
    mergedAt: null,
    skippedAt: null,
    username: { $type: "string" },
    passwordHash: { $type: "string" },
  }).lean();
  if (!legacy.length) return { moved: 0, skipped: [] };

  // As mais antigas primeiro: se duas contas apontarem para a mesma pessoa
  // (nao deveria acontecer), a primeira e a que vale.
  legacy.sort((a, b) => String(a._id).localeCompare(String(b._id)));

  let moved = 0;
  const skipped = [];

  for (const account of legacy) {
    const person = account.person
      ? await Person.findById(account.person)
      : null;

    // Sem ficha ligada, nao ha como saber de QUEM e a conta. Procurar pelo
    // nome seria chute: duas pessoas podem ter o mesmo nome (ver o comentario
    // em models/Person.js), e o chute entregaria login e senha de
    // administrador para a pessoa errada.
    let reason = "";
    if (!person) {
      reason = account.person
        ? "a ficha de pessoa desta conta nao existe mais"
        : "a conta nao aponta para nenhuma ficha de pessoa";
    } else if (person.username) {
      reason =
        person.username === account.username
          ? "a ficha ja tem este login"
          : 'a ficha ja tem o login "' + person.username + '"';
    } else if (
      await Person.exists({
        username: account.username,
        _id: { $ne: person._id },
      })
    ) {
      reason = "este login ja esta com outra pessoa";
    }

    if (reason) {
      skipped.push({ username: account.username, reason });
      await LegacyUser.updateOne(
        { _id: account._id },
        { skippedAt: new Date(), skipReason: reason },
      );
      continue;
    }

    person.username = account.username;
    person.passwordHash = account.passwordHash;
    if (account.photo) person.photo = account.photo;
    if (account.photoPublicId) person.photoPublicId = account.photoPublicId;
    await person.save();
    moved += 1;

    await LegacyUser.updateOne({ _id: account._id }, { mergedAt: new Date() });
  }

  return { moved, skipped };
}
