import { Router } from "express";
import Person from "../models/Person.js";
import { requireDev } from "../middleware/auth.js";
import {
  readPassword,
  readUsername,
  usernameTaken,
} from "../services/credentials.js";
import { IS_ADMIN_FILTER } from "../services/people.js";
import {
  createPersonHandler,
  updatePersonHandler,
} from "./people.js";

/**
 * TELA DE MANUTENCAO. Aberta so pelo login reservado (ver
 * services/devAccess.js); nenhum administrador chega aqui.
 *
 * E o unico lugar do sistema que mexe em QUEM ENTRA NO PAINEL:
 *
 * - tornar administrador: a pessoa que ja esta no cadastro recebe um login e
 *   uma senha. OS DOIS SAO OBRIGATORIOS - sem eles a acao nao acontece, para
 *   nao existir administrador sem forma de entrar;
 * - desfazer administrador: login e senha voltam a ser null. A pessoa continua
 *   no cadastro, com numero, foto e historico de emprestimos intactos; so
 *   perde o acesso ao painel;
 * - trocar a senha (ou o login) de um administrador.
 *
 * E TAMBEM CADASTRA E EDITA GENTE (nome, WhatsApp e foto), de usuario e de
 * administrador: esta tela e a dona do cadastro, entao nao precisa de uma
 * conta de administrador emprestada para corrigir um nome ou um numero. As
 * regras sao exatamente as mesmas da tela "Usuarios" do painel, porque os
 * tratadores sao os MESMOS (importados de routes/people.js); a unica
 * diferenca e que aqui a ficha de um administrador tambem pode ser editada.
 *
 * O que esta tela NAO faz: livro e emprestimo - nao registra, nao confirma
 * devolucao e nao apaga nenhum. Isso e trabalho do painel, com a conta de
 * administrador. (Corrigir o nome ou o WhatsApp de uma pessoa aqui atualiza o
 * que o emprestimo EM ANDAMENTO mostra dela, porque o emprestimo guarda uma
 * copia dos dois - ver syncActiveLoans em services/people.js. O emprestimo em
 * si continua como esta.)
 */
const router = Router();
router.use(requireDev);

function toRow(person) {
  return {
    _id: person._id,
    code: person.code || null,
    fullName: person.fullName,
    phone: person.phone || "",
    photo: person.photo || "",
    username: person.username || null,
    isAdmin: Boolean(person.username),
    loansCount: person.loansCount || 0,
  };
}

// GET /api/dev/people
// Todo mundo do cadastro, em ordem de numero (#1, #2, #3...), com quem e
// administrador marcado. A tela separa as duas listas a partir de "isAdmin".
// (O createdAt so desempata ficha sem numero, que o servidor nao deixa
// existir - ver o mesmo comentario em routes/people.js.)
router.get("/people", async (req, res, next) => {
  try {
    const people = await Person.find()
      .select("code fullName phone photo username loansCount")
      .sort({ code: 1, createdAt: 1 })
      .lean();
    return res.json(people.map(toRow));
  } catch (error) {
    return next(error);
  }
});

// POST /api/dev/people  { fullName, phone, photo?, force }
// Cadastra uma pessoa (sem login: so usuaria da biblioteca). Mesmas regras de
// POST /api/people - inclusive o aviso de nome/WhatsApp repetido, que o front
// confirma reenviando com force = true.
router.post("/people", createPersonHandler);

// PUT /api/dev/people/:id  { fullName, phone, photo?, removePhoto?, force }
// Edita nome, WhatsApp e foto de QUALQUER pessoa do cadastro, administrador
// incluido (o painel so deixa a propria pessoa editar a ficha dela). Login e
// senha nao se mexem aqui: para isso sao as rotas /admin e /credentials.
// O nome e o WhatsApp novos passam a valer tambem nos emprestimos que a pessoa
// tem em andamento (o aviso de devolucao precisa ir para o numero certo).
router.put("/people/:id", updatePersonHandler);

// POST /api/dev/people/:id/admin  { username, password }
// Torna administradora uma pessoa que ja esta no cadastro.
router.post("/people/:id/admin", async (req, res, next) => {
  try {
    // Login e senha SAO A CONDICAO da acao: sao conferidos antes de qualquer
    // coisa e, se faltar um, nada e gravado.
    const login = readUsername(req.body.username);
    if (login.error) return res.status(400).json({ error: login.error });

    const senha = readPassword(req.body.password);
    if (senha.error) return res.status(400).json({ error: senha.error });

    const person = await Person.findById(req.params.id);
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }
    if (person.username) {
      return res.status(409).json({
        error:
          person.fullName +
          " já é administrador(a) (usuário " +
          person.username +
          ").",
      });
    }
    if (await usernameTaken(login.username, person._id)) {
      return res.status(409).json({
        error: "Esse usuário já existe. Escolha outro nome de usuário.",
      });
    }

    person.username = login.username;
    person.passwordHash = await Person.hashPassword(senha.password);
    await person.save();

    return res.json(toRow(person));
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/dev/people/:id/admin
// Desfaz o administrador: login e senha voltam a ser null.
router.delete("/people/:id/admin", async (req, res, next) => {
  try {
    const person = await Person.findById(req.params.id);
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }
    if (!person.username) {
      return res
        .status(409)
        .json({ error: person.fullName + " não é administrador(a)." });
    }

    // Sem nenhum administrador ninguem cuidaria do acervo. Para trocar o
    // ultimo, torne outra pessoa administradora primeiro.
    const total = await Person.countDocuments(IS_ADMIN_FILTER);
    if (total <= 1) {
      return res.status(409).json({
        error:
          "Este é o último administrador: sem ele ninguém cuidaria do acervo. Torne outra pessoa administradora antes de desfazer esta.",
      });
    }

    person.username = null;
    person.passwordHash = null;
    await person.save();

    return res.json(toRow(person));
  } catch (error) {
    return next(error);
  }
});

// PUT /api/dev/people/:id/credentials  { username?, password? }
// Troca o login e/ou a senha de quem ja e administrador. Pelo menos um dos
// dois precisa vir.
router.put("/people/:id/credentials", async (req, res, next) => {
  try {
    const wantsUsername = req.body.username !== undefined;
    const wantsPassword = Boolean(req.body.password);
    if (!wantsUsername && !wantsPassword) {
      return res
        .status(400)
        .json({ error: "Informe o novo usuário ou a nova senha." });
    }

    const login = wantsUsername ? readUsername(req.body.username) : null;
    if (login?.error) return res.status(400).json({ error: login.error });

    const senha = wantsPassword ? readPassword(req.body.password) : null;
    if (senha?.error) return res.status(400).json({ error: senha.error });

    const person = await Person.findById(req.params.id);
    if (!person) {
      return res.status(404).json({ error: "Pessoa não encontrada." });
    }
    if (!person.username) {
      return res.status(409).json({
        error:
          person.fullName +
          " não é administrador(a). Torne a pessoa administradora para dar um login e uma senha.",
      });
    }

    if (login && login.username !== person.username) {
      if (await usernameTaken(login.username, person._id)) {
        return res.status(409).json({
          error: "Esse usuário já existe. Escolha outro nome de usuário.",
        });
      }
      person.username = login.username;
    }
    if (senha) {
      person.passwordHash = await Person.hashPassword(senha.password);
    }
    await person.save();

    return res.json(toRow(person));
  } catch (error) {
    return next(error);
  }
});

export default router;
