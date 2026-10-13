import { Router } from "express";
import Person from "../models/Person.js";
import Loan from "../models/Loan.js";
import { normalizeText } from "../models/Book.js";
import { requireAuth } from "../middleware/auth.js";
import { normalizePhone, PHONE_ERROR } from "../services/phone.js";
import {
  adminPersonIds,
  cleanPersonName,
  createPerson,
  findSimilarPeople,
  isFullName,
  similarPeopleWarning,
  syncActiveLoans,
} from "../services/people.js";

const router = Router();
router.use(requireAuth);

// Sugestao enquanto digita: 10. A tela "Usuarios" pede a lista toda (ela
// filtra no proprio navegador, como o acervo).
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 500;

const NAME_ERROR = "Digite o nome completo (nome e sobrenome).";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Livros que a pessoa tem em maos agora, por pessoa: Map(id -> [titulos]).
async function activeLoansByPerson(people) {
  const loans = await Loan.find({
    status: "ativo",
    person: { $in: people.map((person) => person._id) },
  })
    .select("person bookTitle")
    .lean();

  const byPerson = new Map();
  loans.forEach((loan) => {
    const key = String(loan.person);
    byPerson.set(key, [...(byPerson.get(key) || []), loan.bookTitle]);
  });
  return byPerson;
}

// Le nome e telefone do corpo da requisicao e devolve { fullName, phone } ou
// uma mensagem de erro em "error".
function readPersonFields(body) {
  const fullName = cleanPersonName(body.fullName ?? body.name);
  if (!fullName) return { error: "Informe o nome da pessoa." };
  if (!isFullName(fullName)) return { error: NAME_ERROR };

  const phone = normalizePhone(body.phone);
  if (phone === null) return { error: PHONE_ERROR };

  return { fullName, phone };
}

// GET /api/people?search=texto&limit=10
router.get("/", async (req, res, next) => {
  try {
    const search = normalizeText(req.query.search || "");
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT),
    );

    const filter = {};
    if (search) filter.nameSort = new RegExp(escapeRegex(search), "i");

    const people = await Person.find(filter)
      .sort({ nameSort: 1 })
      .limit(limit)
      .lean();

    const [loansByPerson, admins] = await Promise.all([
      activeLoansByPerson(people),
      adminPersonIds(),
    ]);

    return res.json(
      people.map((person) => {
        const account = admins.get(String(person._id));
        return {
          ...person,
          activeLoans: loansByPerson.get(String(person._id)) || [],
          isAdmin: Boolean(account),
          // Foto so existe para quem e administrador (quem pega livro
          // emprestado nao tem foto no sistema).
          photo: account?.photo || "",
        };
      }),
    );
  } catch (error) {
    return next(error);
  }
});

// GET /api/people/check?name=Nome Completo
// Diz se a pessoa ja existe e se ja esta com algum livro.
// (Fica antes das rotas com :id para nao ser confundida com um id.)
router.get("/check", async (req, res, next) => {
  try {
    const nameSort = normalizeText(req.query.name || "");
    if (!nameSort) return res.json({ exists: false, activeLoans: [] });

    const person = await Person.findOne({ nameSort });
    if (!person) return res.json({ exists: false, activeLoans: [] });

    const loans = await Loan.find({ person: person._id, status: "ativo" })
      .select("bookTitle startDate dueDate")
      .lean();

    return res.json({ exists: true, person, activeLoans: loans });
  } catch (error) {
    return next(error);
  }
});

// POST /api/people  { fullName, phone, force }
// force = true: a pessoa confirmou que e alguem diferente de quem ja tem esse
// nome (ou que o WhatsApp e compartilhado) e quer cadastrar mesmo assim.
router.post("/", async (req, res, next) => {
  try {
    const fields = readPersonFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });

    if (!req.body.force) {
      const similar = await findSimilarPeople(fields);
      const warning = similarPeopleWarning(similar, fields.fullName);
      if (warning) return res.status(409).json(warning);
    }

    const person = await createPerson(fields);
    return res.status(201).json(person);
  } catch (error) {
    return next(error);
  }
});

// PUT /api/people/:id  { fullName, phone, force }
// E aqui que se resolve "a pessoa trocou de numero": o novo numero passa a
// valer tambem nos emprestimos que ela tem em andamento.
router.put("/:id", async (req, res, next) => {
  try {
    const fields = readPersonFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });

    const person = await Person.findById(req.params.id);
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }

    if (!req.body.force) {
      const similar = await findSimilarPeople({
        ...fields,
        exceptId: person._id,
      });
      const warning = similarPeopleWarning(similar, fields.fullName);
      if (warning) return res.status(409).json(warning);
    }

    person.fullName = fields.fullName;
    person.phone = fields.phone;
    await person.save();
    await syncActiveLoans(person);

    return res.json(person);
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/people/:id
// Nao apaga nada de historico: os emprestimos ja devolvidos guardam uma copia
// do nome e continuam na lista pelos dias em que ficam no sistema.
router.delete("/:id", async (req, res, next) => {
  try {
    const person = await Person.findById(req.params.id).lean();
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }

    const openLoans = await Loan.find({ person: person._id, status: "ativo" })
      .select("bookTitle")
      .lean();
    if (openLoans.length) {
      return res.status(409).json({
        error:
          person.fullName +
          " está com " +
          openLoans.map((loan) => loan.bookTitle).join(", ") +
          ". Confirme a devolução antes de excluir.",
      });
    }

    const admins = await adminPersonIds();
    if (admins.has(String(person._id))) {
      return res.status(409).json({
        error:
          person.fullName +
          " tem conta de administrador. Exclua a conta em Configurações › Administradores antes de remover a pessoa.",
      });
    }

    await Person.findByIdAndDelete(person._id);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
