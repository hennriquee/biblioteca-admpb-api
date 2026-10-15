import { Router } from "express";
import rateLimit from "express-rate-limit";
import { PROFILE_PHOTO, assertValidImage } from "../services/images.js";
import { removePhotoBackground } from "../services/background.js";

/**
 * Preparo da foto de perfil ANTES do Cloudinary: recorta o fundo.
 *
 * POST /api/photo/remove-background      (sessao de administrador)
 * POST /api/dev/photo/remove-background  (sessao de manutencao)
 *   { photo: data URI }  ->  { photo: data URI do PNG sem fundo }
 *
 * O MESMO router responde nos dois enderecos (ver server.js): a tela de
 * manutencao tambem cadastra gente com foto, e a sessao dela nao passa pelo
 * requireAdmin. Nada e salvo aqui - quem envia ao Cloudinary continua sendo
 * a rota que grava a pessoa (/api/people, /api/admins/me, /api/dev/people),
 * com a foto que o app devolver depois da escolha do fundo.
 *
 * A cota gratuita do recorte e pequena (50 fotos por mes no tamanho que o
 * app usa, ver services/background.js) e cada chamada daqui gasta uma. O
 * limite por IP abaixo segura uma RAJADA acidental (um cliquesinho nervoso,
 * uma aba repetindo o envio, um script) - nao e, e nem poderia ser, uma
 * garantia de que a cota do mes dura: 12 fotos por hora ja sao um dia cheio
 * de cadastro, e quem cadastrar gente a tarde inteira vai mesmo gastar a
 * cota. Quem precisar de mais que isso por mes assina um plano na remove.bg.
 */
const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Muitas fotos recortadas em pouco tempo. Aguarde um pouco e tente de novo.",
  },
});

// Mesma conferencia do upload (formato e tamanho): nao faz sentido gastar
// uma chamada da cota com um arquivo que nem foto e. Vem ANTES do limite por
// IP para que um envio invalido nao consuma uma das tentativas da hora.
function checkPhoto(req, res, next) {
  try {
    assertValidImage(req.body?.photo, PROFILE_PHOTO);
    return next();
  } catch (error) {
    return next(error);
  }
}

router.post(
  "/remove-background",
  checkPhoto,
  limiter,
  async (req, res, next) => {
    try {
      const photo = await removePhotoBackground(req.body.photo);
      return res.json({ photo });
    } catch (error) {
      // O codigo ajuda o app a decidir o que dizer; a mensagem ja vem pronta.
      if (error.code && error.status) {
        return res
          .status(error.status)
          .json({ error: error.message, code: error.code });
      }
      return next(error);
    }
  },
);

export default router;
