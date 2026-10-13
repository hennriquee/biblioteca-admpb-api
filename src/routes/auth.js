import { Router } from "express";
import jwt from "jsonwebtoken";
import Person from "../models/Person.js";
import { requireAuth } from "../middleware/auth.js";
import { cleanUsername } from "../services/credentials.js";
import { devUsername, isDevLogin } from "../services/devAccess.js";

const router = Router();

/**
 * Entrada no painel. Sao duas sessoes possiveis (ver middleware/auth.js):
 *
 * - a de ADMINISTRADOR, de quem tem login e senha na propria ficha de pessoa;
 * - a de MANUTENCAO, do login reservado (ver services/devAccess.js), que so
 *   abre a tela de login e senha dos outros.
 */

// O que o app precisa saber sobre quem entrou.
function toSession(person) {
  return {
    id: person._id,
    username: person.username,
    name: person.fullName,
    photo: person.photo || "",
    role: "admin",
  };
}

// A sessao de manutencao nao e ninguem no cadastro: nao tem ficha, nem foto,
// nem historico. E so a chave que abre a tela de manutencao.
function devSession() {
  return {
    id: "dev",
    username: devUsername(),
    name: "Manutenção",
    photo: "",
    role: "dev",
  };
}

function signToken(session) {
  return jwt.sign(
    {
      sub: String(session.id),
      username: session.username,
      role: session.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" },
  );
}

// POST /api/auth/login  { username, password }
router.post("/login", async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "Informe usuário e senha." });
    }

    // O login reservado e checado ANTES do banco: ele nao e uma conta de
    // ninguem e nao pode esbarrar em nenhuma.
    if (isDevLogin(username, password)) {
      const session = devSession();
      return res.json({ token: signToken(session), user: session });
    }

    // So quem tem login entra: quem e apenas usuario da biblioteca tem
    // username null, e null nunca e igual ao texto digitado.
    const person = await Person.findOne({ username });

    // Mensagem generica de proposito: nao revela se o erro foi no usuario ou na senha.
    if (!person) {
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    const passwordMatches = await person.checkPassword(password);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    const session = toSession(person);
    return res.json({ token: signToken(session), user: session });
  } catch (error) {
    return next(error);
  }
});

// GET /api/auth/me  -> usado pelo front para saber se o token ainda vale
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === "dev") {
      return res.json({ user: devSession() });
    }

    const person = await Person.findById(req.user.id).select(
      "username fullName photo",
    );
    // Conta que deixou de ser administradora (ou saiu do cadastro) nao volta
    // para o painel, mesmo com o token ainda no prazo.
    if (!person || !person.username) {
      return res
        .status(401)
        .json({ error: "Esta conta não tem mais acesso ao painel." });
    }
    return res.json({ user: toSession(person) });
  } catch (error) {
    return next(error);
  }
});

export default router;
