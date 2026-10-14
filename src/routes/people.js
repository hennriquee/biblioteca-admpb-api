import { Router } from "express";
import Person from "../models/Person.js";
import Loan from "../models/Loan.js";
import { normalizeText } from "../models/Book.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  assertValidImage,
  deleteImage,
  PROFILE_PHOTO,
  uploadImage,
} from "../services/images.js";
import {
  createPerson,
  findSimilarPeople,
  readPersonFields,
  similarPeopleWarning,
  syncActiveLoans,
  syncApprovedByName,
} from "../services/people.js";

/**
 * Pessoas do cadastro (tela "Usuarios").
 *
 * Toda pessoa tem os MESMOS campos de um administrador - numero, nome,
 * WhatsApp, foto - porque administrador e so uma pessoa que tambem tem login e
 * senha (ver models/Person.js). E por isso que a tela de manutencao consegue
 * transformar um usuario em administrador sem pedir nada de novo alem do login
 * e da senha.
 *
 * O QUE ESTA ROTA NAO MEXE: login e senha. Nem para dar, nem para tirar, nem
 * para trocar. Isso e so da tela de manutencao (routes/dev.js). Aqui tambem
 * nao se edita a ficha de OUTRO administrador: cada um cuida da sua
 * (Configuracoes > Administradores).
 *
 * CADASTRAR E EDITAR GENTE ACONTECE EM DUAS TELAS, com as mesmas regras: a
 * "Usuarios" do painel e a de manutencao. Para nao existirem duas versoes da
 * mesma regra (uma delas sempre ficaria para tras), os dois tratadores abaixo
 * sao exportados e a tela de manutencao monta os MESMOS em /api/dev/people
 * (ver routes/dev.js). A unica diferenca entre as duas esta marcada no
 * updatePersonHandler.
 */
const router = Router();
router.use(requireAdmin);

// Sugestao enquanto digita: 10. A tela "Usuarios" pede a lista toda (ela
// filtra no proprio navegador, como o acervo).
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 1000;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// O que sai daqui sobre uma pessoa. A senha (nem o hash dela) nunca entra.
function toPerson(person, extra = {}) {
  return {
    _id: person._id,
    code: person.code || null,
    fullName: person.fullName,
    phone: person.phone || "",
    photo: person.photo || "",
    loansCount: person.loansCount || 0,
    isAdmin: Boolean(person.username),
    username: person.username || null,
    ...extra,
  };
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

// GET /api/people?search=texto&limit=10&sort=code
// - sort=code: a ordem da tela "Usuarios" (#1, #2, #3...).
// - sem sort: ordem alfabetica, que e a util nas sugestoes de quem digita um
//   nome ao registrar um emprestimo.
router.get("/", async (req, res, next) => {
  try {
    const search = normalizeText(req.query.search || "");
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT),
    );

    const filter = {};
    if (search) filter.nameSort = new RegExp(escapeRegex(search), "i");

    // O createdAt desempata as fichas que (por algum motivo) ficaram sem
    // numero - elas aparecem no INICIO da lista, na ordem de cadastro, porque
    // para o Mongo "sem valor" vem antes de qualquer numero. Na pratica isso
    // nao acontece: o servidor numera todas ao iniciar (backfillPersonCodes).
    const order =
      req.query.sort === "code" ? { code: 1, createdAt: 1 } : { nameSort: 1 };

    const people = await Person.find(filter).sort(order).limit(limit).lean();
    const loansByPerson = await activeLoansByPerson(people);

    return res.json(
      people.map((person) =>
        toPerson(person, {
          activeLoans: loansByPerson.get(String(person._id)) || [],
        }),
      ),
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

    const person = await Person.findOne({ nameSort }).lean();
    if (!person) return res.json({ exists: false, activeLoans: [] });

    const loans = await Loan.find({ person: person._id, status: "ativo" })
      .select("bookTitle startDate dueDate")
      .lean();

    return res.json({
      exists: true,
      person: toPerson(person),
      activeLoans: loans,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/people  (e POST /api/dev/people)  { fullName, phone, photo, force }
// force = true: a pessoa confirmou que e alguem diferente de quem ja tem esse
// nome (ou que o WhatsApp e compartilhado) e quer cadastrar mesmo assim.
//
// Quem nasce aqui nasce SEM login (ver createPerson): nem esta rota nem a de
// manutencao criam alguem que ja entre no painel - dar login e senha e um
// segundo passo, so da tela de manutencao.
export async function createPersonHandler(req, res, next) {
  let uploaded = null;
  try {
    const fields = readPersonFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });

    if (!req.body.force) {
      const similar = await findSimilarPeople(fields);
      const warning = similarPeopleWarning(similar, fields.fullName);
      if (warning) return res.status(409).json(warning);
    }

    if (req.body.photo) {
      assertValidImage(req.body.photo, PROFILE_PHOTO);
      uploaded = await uploadImage(req.body.photo, PROFILE_PHOTO);
    }

    const person = await createPerson({
      ...fields,
      photo: uploaded ? uploaded.url : "",
      photoPublicId: uploaded ? uploaded.publicId : "",
    });
    return res.status(201).json(toPerson(person));
  } catch (error) {
    // Se a foto subiu mas o cadastro nao foi criado, nao deixa a foto orfa.
    if (uploaded) await deleteImage(uploaded.publicId);
    return next(error);
  }
}

// PUT /api/people/:id  (e PUT /api/dev/people/:id)
// { fullName, phone, photo?, removePhoto?, force }
// E aqui que se resolve "a pessoa trocou de numero": o novo numero passa a
// valer tambem nos emprestimos que ela tem em andamento.
export async function updatePersonHandler(req, res, next) {
  let uploaded = null;
  try {
    const fields = readPersonFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });

    const person = await Person.findById(req.params.id);
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }

    // Ficha de OUTRO administrador nao se edita pelo painel: cada um cuida da
    // sua em Configuracoes > Minha conta. A sessao de manutencao passa por
    // esta trava de proposito - ela e a dona de quem entra no painel e e a
    // unica que edita a ficha de um administrador sem ser a propria pessoa.
    const isDevSession = req.user.role === "dev";
    if (
      !isDevSession &&
      person.username &&
      String(person._id) !== String(req.user.id)
    ) {
      return res.status(403).json({
        error:
          person.fullName +
          " é administrador(a): só a própria pessoa edita esse cadastro.",
      });
    }

    if (!req.body.force) {
      const similar = await findSimilarPeople({
        ...fields,
        exceptId: person._id,
      });
      const warning = similarPeopleWarning(similar, fields.fullName);
      if (warning) return res.status(409).json(warning);
    }

    if (req.body.photo) {
      assertValidImage(req.body.photo, PROFILE_PHOTO);
      uploaded = await uploadImage(req.body.photo, PROFILE_PHOTO);
    }

    const nameChanged = person.fullName !== fields.fullName;
    const previousPhotoId = person.photoPublicId;

    person.fullName = fields.fullName;
    person.phone = fields.phone;
    if (uploaded) {
      person.photo = uploaded.url;
      person.photoPublicId = uploaded.publicId;
    } else if (req.body.removePhoto) {
      person.photo = "";
      person.photoPublicId = "";
    }
    await person.save();

    await syncActiveLoans(person);
    if (nameChanged) await syncApprovedByName(person);

    // A foto antiga ficou sem uso: apaga para nao lotar o Cloudinary.
    if (previousPhotoId && previousPhotoId !== person.photoPublicId) {
      await deleteImage(previousPhotoId);
    }

    return res.json(toPerson(person));
  } catch (error) {
    if (uploaded) await deleteImage(uploaded.publicId);
    return next(error);
  }
}

router.post("/", createPersonHandler);
router.put("/:id", updatePersonHandler);

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

    if (person.username) {
      return res.status(409).json({
        error:
          person.fullName +
          " é administrador(a). Desfaça o administrador na tela de manutenção antes de remover a pessoa do cadastro.",
      });
    }

    await Person.findByIdAndDelete(person._id);
    const photoDeleted = person.photoPublicId
      ? await deleteImage(person.photoPublicId)
      : true;
    return res.json({ ok: true, photoDeleted });
  } catch (error) {
    return next(error);
  }
});

export default router;
