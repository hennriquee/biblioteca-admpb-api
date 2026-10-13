/**
 * Regras de "quem e quem" compartilhadas pelas rotas de pessoas, contas de
 * administrador e emprestimos. Ver o comentario grande em models/Person.js.
 */
import Person from "../models/Person.js";
import User from "../models/User.js";
import Loan from "../models/Loan.js";
import Counter from "../models/Counter.js";
import { normalizeText } from "../models/Book.js";

export const MAX_NAME_LENGTH = 80;

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
export async function createPerson({ fullName, phone = "" }) {
  return Person.create({
    code: await nextPersonCode(),
    fullName,
    phone: phone || "",
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
  const found = await Person.find(filter).select("code fullName phone").lean();

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
        "Já existe " +
        describePerson(other) +
        " no cadastro. É a mesma pessoa?",
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

// Pessoas que tem conta de administrador: Map(id da pessoa -> conta). Sao
// poucas, entao vem todas de uma vez e quem chamou so consulta o mapa (tem
// .has() como um Set, e .get() para quem quer a foto ou o usuario).
export async function adminPersonIds() {
  const users = await User.find({ person: { $ne: null } })
    .select("person username photo")
    .lean();
  return new Map(
    users.map((user) => [
      String(user.person),
      { username: user.username, photo: user.photo || "" },
    ]),
  );
}

// Acrescenta a cada emprestimo se quem pegou o livro e administrador (o app
// mostra um selo "admin" do lado do nome).
export async function withAdminFlag(loans) {
  const list = Array.isArray(loans) ? loans : [loans];
  const admins = await adminPersonIds();
  const marked = list.map((loan) => ({
    ...loan,
    personIsAdmin: admins.has(String(loan.person)),
  }));
  return Array.isArray(loans) ? marked : marked[0];
}

// Nome/telefone mudaram: os emprestimos EM ANDAMENTO passam a mostrar o dado
// novo (e o aviso de devolucao vai para o numero novo). Os ja devolvidos
// guardam o que valia na epoca - e historico.
export async function syncActiveLoans(person) {
  await Loan.updateMany(
    { person: person._id, status: "ativo" },
    {
      personName: person.fullName,
      personNameSort: normalizeText(person.fullName),
      personPhone: person.phone || "",
    },
  );
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
    await Person.updateOne({ _id: person._id }, { code: await nextPersonCode() });
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
 * Conta de administrador antiga (de antes de existir a tela de
 * administradores) nao tinha pessoa ligada: o nome ficava no proprio usuario.
 * Roda uma vez, no inicio do servidor, e liga cada conta a uma pessoa - a que
 * ja existir com aquele nome ou uma nova. Devolve quantas contas foram ligadas.
 */
export async function backfillAdminPersons() {
  const users = await User.find({
    $or: [{ person: null }, { person: { $exists: false } }],
  }).lean();
  if (!users.length) return 0;

  let linked = 0;
  for (const user of users) {
    // "name" era o campo antigo da conta; hoje o nome vive na pessoa.
    const fullName = cleanPersonName(user.name) || "Administrador";
    const nameSort = normalizeText(fullName);
    let person = await Person.findOne({ nameSort });
    if (!person) person = await createPerson({ fullName });
    await User.updateOne({ _id: user._id }, { person: person._id });
    linked += 1;
  }
  return linked;
}
