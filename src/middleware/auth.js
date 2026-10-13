import jwt from "jsonwebtoken";
import Person from "../models/Person.js";

/**
 * Quem esta falando com a API. Sao dois tipos de sessao, e a diferenca entre
 * elas e o que o painel deixa fazer:
 *
 * - "admin": uma pessoa com login e senha (ver models/Person.js). Cuida do
 *   acervo, dos emprestimos e do cadastro de quem pega livros.
 * - "dev": a sessao de manutencao, que entra com o login reservado (ver
 *   routes/dev.js). SO mexe em login e senha: cria administrador, desfaz
 *   administrador e troca senha. Nao mexe em livro nem em emprestimo.
 *
 * Nenhuma das duas faz o trabalho da outra: requireAdmin recusa a sessao de
 * manutencao e requireDev recusa a de administrador.
 */

// Le o cabecalho "Authorization: Bearer <token>" e valida a assinatura.
// Se o token for valido, deixa a requisicao passar; se nao, devolve 401.
export function requireAuth(req, res, next) {
  // Algumas rotas passam por aqui duas vezes (ver o limite de tamanho do
  // corpo em server.js). Na segunda nao ha nada a fazer.
  if (req.user) return next();

  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Faça login para continuar." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.sub,
      username: payload.username,
      // Token emitido antes de existir a sessao de manutencao nao tem papel
      // nenhum escrito: era de administrador.
      role: payload.role === "dev" ? "dev" : "admin",
    };
    return next();
  } catch (error) {
    return res
      .status(401)
      .json({ error: "Sessão expirada. Faça login novamente." });
  }
}

/**
 * Sessao de administrador. Confere no banco se a pessoa AINDA tem login: quem
 * deixou de ser administrador (ou saiu do cadastro) perde o acesso na hora,
 * sem esperar o token vencer. Deixa a ficha dela em req.account, que e de onde
 * sai o nome de quem aprovou um emprestimo.
 */
export async function requireAdmin(req, res, next) {
  return requireAuth(req, res, async () => {
    if (req.account) return next();
    if (req.user.role !== "admin") {
      return res.status(403).json({
        error:
          "A sessão de manutenção não administra o acervo. Entre com a sua conta de administrador.",
      });
    }
    try {
      const person = await Person.findById(req.user.id)
        .select("username fullName code photo phone")
        .lean();
      if (!person || !person.username) {
        return res.status(401).json({
          error: "Esta conta não tem mais acesso ao painel. Faça login novamente.",
        });
      }
      req.account = person;
      return next();
    } catch (error) {
      return next(error);
    }
  });
}

/** Sessao de manutencao (o login reservado). */
export function requireDev(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.user.role !== "dev") {
      return res
        .status(403)
        .json({ error: "Essa tela é só da sessão de manutenção." });
    }
    return next();
  });
}
