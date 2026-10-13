import { Router } from "express";
import Person from "../models/Person.js";
import { requireAdmin } from "../middleware/auth.js";
import { normalizePhone, PHONE_ERROR } from "../services/phone.js";
import {
  PROFILE_PHOTO,
  assertValidImage,
  deleteImage,
  uploadImage,
} from "../services/images.js";
import {
  readPassword,
  readUsername,
  usernameTaken,
} from "../services/credentials.js";
import {
  cleanPersonName,
  findSimilarPeople,
  isFullName,
  similarPeopleWarning,
  syncActiveLoans,
  syncApprovedByName,
} from "../services/people.js";

/**
 * Minha conta (Configuracoes > Minha conta).
 *
 * O QUE UM ADMINISTRADOR PODE FAZER AQUI: ver e editar A PROPRIA conta -
 * nome, WhatsApp, foto, login e senha. Nao ha lista dos outros.
 *
 * O QUE NAO PODE, DE PROPOSITO: criar administrador, desfazer administrador e
 * trocar a senha de outra pessoa. Quem mexe em quem entra no painel e so a
 * tela de manutencao (routes/dev.js), aberta pelo login reservado. Assim,
 * nenhum administrador pode se promover, se blindar ou tirar o acesso de
 * outro - nem por engano, nem de proposito.
 *
 * Administrador e so uma pessoa do cadastro que tem login e senha (ver
 * models/Person.js): o numero que aparece aqui (#1, #2...) e o mesmo da tela
 * Usuarios, e um emprestimo feito para ela ganha o selo "admin".
 *
 * A foto fica no Cloudinary pelo mesmo caminho da capa de livro: ao trocar ou
 * remover, o servidor apaga a antiga de la.
 */
const router = Router();
router.use(requireAdmin);

const NAME_ERROR = "Digite o nome completo (nome e sobrenome).";

function toAdmin(person, currentUserId) {
  return {
    _id: person._id,
    code: person.code || null,
    fullName: person.fullName,
    phone: person.phone || "",
    username: person.username,
    photo: person.photo || "",
    isMe: String(person._id) === String(currentUserId),
  };
}

// GET /api/admins/me -> a PROPRIA conta (a tela "Minha conta"). Nao ha lista
// dos outros administradores: quem quiser ve-los os encontra em /api/people,
// com o selo "admin".
router.get("/me", async (req, res, next) => {
  try {
    const person = await Person.findById(req.user.id)
      .select("code fullName phone username photo")
      .lean();
    if (!person || !person.username) {
      return res.status(401).json({ error: "Sua conta não está mais ativa." });
    }
    return res.json(toAdmin(person, req.user.id));
  } catch (error) {
    return next(error);
  }
});

/**
 * PUT /api/admins/me
 * { fullName, phone, username, password?, photo?, removePhoto?, force }
 *
 * A PROPRIA conta, e so ela: o id vem da sessao, nunca da URL ou do corpo.
 * - password vazio/ausente: mantem a senha atual.
 * - photo (data URI): sobe a nova e apaga a antiga do Cloudinary.
 * - removePhoto: fica sem foto (o app volta a mostrar as iniciais).
 * - force: a pessoa confirmou o aviso de nome/WhatsApp repetido.
 */
router.put("/me", async (req, res, next) => {
  let uploaded = null;
  try {
    const fullName = cleanPersonName(req.body.fullName ?? req.body.name);
    if (!fullName) return res.status(400).json({ error: "Informe o seu nome." });
    if (!isFullName(fullName)) {
      return res.status(400).json({ error: NAME_ERROR });
    }

    const phone = normalizePhone(req.body.phone);
    if (phone === null) return res.status(400).json({ error: PHONE_ERROR });

    const login = readUsername(req.body.username);
    if (login.error) return res.status(400).json({ error: login.error });

    // Senha em branco = continua a que ja estava.
    let newPasswordHash = null;
    if (req.body.password) {
      const checked = readPassword(req.body.password);
      if (checked.error) return res.status(400).json({ error: checked.error });
      newPasswordHash = await Person.hashPassword(checked.password);
    }

    const person = await Person.findById(req.user.id);
    if (!person || !person.username) {
      return res.status(401).json({ error: "Sua conta não está mais ativa." });
    }

    if (login.username !== person.username) {
      if (await usernameTaken(login.username, person._id)) {
        return res.status(409).json({
          error: "Esse usuário já existe. Escolha outro nome de usuário.",
        });
      }
    }

    if (!req.body.force) {
      const similar = await findSimilarPeople({
        fullName,
        phone,
        exceptId: person._id,
      });
      const warning = similarPeopleWarning(similar, fullName);
      if (warning) return res.status(409).json(warning);
    }

    if (req.body.photo) {
      assertValidImage(req.body.photo, PROFILE_PHOTO);
      uploaded = await uploadImage(req.body.photo, PROFILE_PHOTO);
    }

    const nameChanged = person.fullName !== fullName;
    const previousPhotoId = person.photoPublicId;

    person.fullName = fullName;
    person.phone = phone;
    person.username = login.username;
    if (newPasswordHash) person.passwordHash = newPasswordHash;
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

    return res.json(toAdmin(person, req.user.id));
  } catch (error) {
    // Se a foto subiu mas a gravacao falhou, nao deixa a foto orfa.
    if (uploaded) await deleteImage(uploaded.publicId);
    return next(error);
  }
});

export default router;
