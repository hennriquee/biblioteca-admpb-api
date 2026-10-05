import jwt from 'jsonwebtoken';

// Le o cabecalho "Authorization: Bearer <token>" e valida a assinatura.
// Se o token for valido, deixa a requisicao passar; se nao, devolve 401.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Faça login para continuar.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, username: payload.username };
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
}
