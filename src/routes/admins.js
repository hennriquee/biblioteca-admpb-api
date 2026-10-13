import { Router } from "express";
import User from "../models/User.js";
import Person from "../models/Person.js";
import { requireAuth } from "../middleware/auth.js";
import { normalizePhone, PHONE_ERROR } from "../services/phone.js";
import {
  ADMIN_PHOTO,
  assertValidImage,
  deleteImage,
  uploadImage,
} from "../services/images.js";
import {
  cleanPersonName,
  createPerson,
  findSimilarPeople,
  isFullName,
  similarPeopleWarning,
  syncActiveLoans,
} from "../services/people.js";

/**
 * Contas de administrador (Configuracoes > Administradores).
 *
 * Todo administrador pode cadastrar, editar e excluir administradores: numa
 * biblioteca de igreja sao poucas pessoas e todas de confianca, e alguem
 * precisa poder socorrer quem esqueceu a senha. As travas sao duas: ninguem
 * exclui a propria conta (evita se trancar fora) e a ultima conta nao pode ser
 * excluida (senao ninguem mais entraria no painel).
 *
 * O nome e o telefone ficam no registro de Pessoa (ver models/User.js).
 */
const router = Router();
router.use(requireAuth);

const USERNAME_PATTERN = /^[a-z0-9._-]{3,20}$/;
const MIN_PASSWORD = 6;
const USERNAME_ERROR =
  "O usuário deve ter de 3 a 20 caracteres, só letras, números, ponto, hífen ou _.";
const PASSWORD_ERROR =
  "A senha precisa ter pelo menos " + MIN_PASSWORD + " caracteres.";
const NAME_ERROR = "Digite o nome completo (nome e sobrenome).";

function toAdmin(user, person, currentUserId) {
  return {
    _id: user._id,
    username: user.username,
    photo: user.photo || "",
    isMe: String(user._id) === String(currentUserId),
    person: person
      ? {
          _id: person._id,
          code: person.code || null,
          fullName: person.fullName,
          phone: person.phone || "",
        }
      : null,
  };
}

// Le nome, telefone e usuario do corpo. Devolve { error } quando algo nao
// serve. A senha e lida separado (na edicao ela e opcional).
function readFields(body) {
  const fullName = cleanPersonName(body.fullName ?? body.name);
  if (!fullName) return { error: "Informe o nome do administrador." };
  if (!isFullName(fullName)) return { error: NAME_ERROR };

  const phone = normalizePhone(body.phone);
  if (phone === null) return { error: PHONE_ERROR };

  const username = String(body.username || "")
    .trim()
    .toLowerCase();
  if (!USERNAME_PATTERN.test(username)) return { error: USERNAME_ERROR };

  return { fullName, phone, username };
}

// GET /api/admins
router.get("/", async (req, res, next) => {
  try {
    const users = await User.find().populate("person").lean();
    const admins = users
      .map((user) => toAdmin(user, user.person, req.user.id))
      .sort((a, b) =>
        (a.person?.fullName || a.username).localeCompare(
          b.person?.fullName || b.username,
          "pt-BR",
        ),
      );
    return res.json(admins);
  } catch (error) {
    return next(error);
  }
});

// POST /api/admins  { username, password, fullName, phone, photo, personId, force }
// - personId: liga a conta a uma pessoa que JA existe no cadastro (o caminho
//   normal quando o administrador ja pegou livros emprestados antes).
// - force: a pessoa confirmou que e alguem diferente de quem ja tem o mesmo
//   nome/WhatsApp e quer cadastrar uma pessoa nova mesmo assim.
router.post("/", async (req, res, next) => {
  let uploaded = null;
  try {
    const fields = readFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });

    const password = String(req.body.password || "");
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    const taken = await User.findOne({ username: fields.username });
    if (taken) {
      return res.status(409).json({
        error: "Esse usuário já existe. Escolha outro nome de usuário.",
      });
    }

    // A pessoa: uma que ja existe (personId) ou uma nova.
    let person;
    if (req.body.personId) {
      person = await Person.findById(req.body.personId);
      if (!person) {
        return res.status(404).json({ error: "Pessoa não encontrada." });
      }
      const already = await User.findOne({ person: person._id });
      if (already) {
        return res.status(409).json({
          error:
            person.fullName +
            " já tem conta de administrador (usuário " +
            already.username +
            ").",
        });
      }
    } else if (!req.body.force) {
      const similar = await findSimilarPeople(fields);
      const warning = similarPeopleWarning(similar, fields.fullName);
      if (warning) return res.status(409).json(warning);
    }

    if (req.body.photo) {
      assertValidImage(req.body.photo, ADMIN_PHOTO);
      uploaded = await uploadImage(req.body.photo, ADMIN_PHOTO);
    }

    if (person) {
      person.fullName = fields.fullName;
      person.phone = fields.phone;
      await person.save();
      await syncActiveLoans(person);
    } else {
      person = await createPerson(fields);
    }

    const user = await User.create({
      username: fields.username,
      passwordHash: await User.hashPassword(password),
      person: person._id,
      photo: uploaded ? uploaded.url : "",
      photoPublicId: uploaded ? uploaded.publicId : "",
    });

    return res.status(201).json(toAdmin(user, person, req.user.id));
  } catch (error) {
    // Se a foto subiu mas a conta nao foi criada, nao deixa a foto orfa.
    if (uploaded) await deleteImage(uploaded.publicId);
    return next(error);
  }
});

// PUT /api/admins/:id
// { username, fullName, phone, password?, photo?, removePhoto?, force }
// - photo (data URI): sobe a nova e apaga a antiga do Cloudinary.
// - removePhoto: fica sem foto e apaga a antiga.
// - password vazio/ausente: mantem a senha atual.
router.put("/:id", async (req, res, next) => {
  let uploaded = null;
  try {
    const fields = readFields(req.body);
    if (fields.error) return res.status(400).json({ error: fields.error });

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "Administrador não encontrado." });
    }

    const password = String(req.body.password || "");
    if (password && password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: PASSWORD_ERROR });
    }

    if (fields.username !== user.username) {
      const taken = await User.findOne({
        username: fields.username,
        _id: { $ne: user._id },
      });
      if (taken) {
        return res.status(409).json({
          error: "Esse usuário já existe. Escolha outro nome de usuário.",
        });
      }
    }

    // A conta antiga pode nao ter pessoa ligada (ver backfillAdminPersons).
    let person = user.person ? await Person.findById(user.person) : null;
    if (!person) {
      person = await createPerson(fields);
      user.person = person._id;
    } else if (!req.body.force) {
      const similar = await findSimilarPeople({
        ...fields,
        exceptId: person._id,
      });
      const warning = similarPeopleWarning(similar, fields.fullName);
      if (warning) return res.status(409).json(warning);
    }

    if (req.body.photo) {
      assertValidImage(req.body.photo, ADMIN_PHOTO);
      uploaded = await uploadImage(req.body.photo, ADMIN_PHOTO);
    }

    person.fullName = fields.fullName;
    person.phone = fields.phone;
    await person.save();
    await syncActiveLoans(person);

    const previousPhotoId = user.photoPublicId;
    user.username = fields.username;
    if (password) user.passwordHash = await User.hashPassword(password);
    if (uploaded) {
      user.photo = uploaded.url;
      user.photoPublicId = uploaded.publicId;
    } else if (req.body.removePhoto) {
      user.photo = "";
      user.photoPublicId = "";
    }
    await user.save();

    // A foto antiga ficou sem uso: apaga para nao lotar o Cloudinary.
    if (previousPhotoId && previousPhotoId !== user.photoPublicId) {
      await deleteImage(previousPhotoId);
    }

    return res.json(toAdmin(user, person, req.user.id));
  } catch (error) {
    if (uploaded) await deleteImage(uploaded.publicId);
    return next(error);
  }
});

// DELETE /api/admins/:id
// A pessoa continua no cadastro (com o historico de emprestimos); so a conta
// de acesso ao painel deixa de existir.
router.delete("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "Administrador não encontrado." });
    }
    if (String(user._id) === String(req.user.id)) {
      return res.status(409).json({
        error:
          "Você não pode excluir a sua própria conta. Peça para outro administrador fazer isso.",
      });
    }
    const total = await User.countDocuments();
    if (total <= 1) {
      return res.status(409).json({
        error:
          "Esta é a última conta de administrador: sem ela ninguém conseguiria entrar no painel.",
      });
    }

    await User.findByIdAndDelete(user._id);
    const photoDeleted = user.photoPublicId
      ? await deleteImage(user.photoPublicId)
      : true;

    return res.json({ ok: true, photoDeleted });
  } catch (error) {
    return next(error);
  }
});

export default router;
