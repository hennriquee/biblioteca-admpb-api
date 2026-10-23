import { Router } from "express";
import rateLimit from "express-rate-limit";
import { captchaConfig, captchaEnabled, issuePass, verifyCaptcha } from "../services/captcha.js";

/**
 * /api/public/captcha - a porta de entrada do site (ver services/captcha.js).
 * Unicas rotas de /api, alem do health check, que NAO pedem o passe.
 *
 * GET  /         -> { enabled, siteKey }: se a caixa esta ligada e a chave do site.
 * POST /         { token } -> { pass, expiresIn }: confere com o Google e
 *                  entrega o passe. Desligado: { enabled: false }, sem passe.
 */
const router = Router();

// Cada conferencia e uma ida ao Google. Limite por IP folgado (o Wi-Fi da
// igreja junta a congregacao num IP so, e todo mundo entra mais ou menos na
// mesma hora - e um 429 aqui faz a pessoa marcar a caixa de novo), mas que
// impede usar o servidor para martelar o Google.
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.",
  },
});

router.get("/", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(captchaConfig());
});

router.post("/", verifyLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  // Desligado: sem passe. (Entregar um aqui deixaria alguem juntar passes
  // que passariam a valer quando a caixa fosse ligada.) O app nem chega a
  // fazer este pedido nesse caso.
  if (!captchaEnabled()) return res.json({ enabled: false });
  try {
    await verifyCaptcha(req.body?.token, req.ip);
    return res.json(issuePass());
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({ error: error.message, code: error.code || undefined });
  }
});

export default router;
