import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import BookSuggestion from "../models/BookSuggestion.js";
import SuggestionThrottle from "../models/SuggestionThrottle.js";
import SuggestionQuota from "../models/SuggestionQuota.js";
import { normalizeText } from "../models/Book.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  SUGGESTION_PHOTO,
  assertValidImage,
  deleteImage,
  uploadImage,
} from "../services/images.js";

/**
 * "Sugerir um livro": quem visita o acervo publico (/catalogo) conta qual
 * livro gostaria de ver na biblioteca, e os administradores veem a lista em
 * Configuracoes > Livros sugeridos.
 *
 * Dois routers aqui:
 * - publicSuggestions (/api/public/suggestions): SEM login, so recebe;
 * - o padrao (/api/suggestions): so administrador, lista e exclui.
 *
 * A rota publica grava no banco e pode mandar foto ao Cloudinary, entao tem
 * varias travas contra quem quiser encher o banco ou gastar a cota de fotos:
 * - limite por rede em memoria (rajadas) e outro no banco (o dia todo),
 *   alem do limite geral da area publica (server.js). Folgados de proposito:
 *   o Wi-Fi da igreja (e a internet do celular, no Brasil) junta muita gente
 *   num IP so, e quem segura um ataque de verdade sao os tetos gerais;
 * - tetos gerais por dia (sugestoes e fotos), com a vaga reservada de forma
 *   atomica antes de gravar (ver models/SuggestionQuota.js), e de tamanho da
 *   lista;
 * - campo-isca escondido (honeypot): robo que preenche tudo e ignorado;
 * - textos curtos, sem links, sem caracteres de controle nem invisiveis; a
 *   mesma sugestao repetida nao vira outra linha (indice unico no banco);
 * - foto conferida (tipo, tamanho e os primeiros bytes de imagem de verdade)
 *   antes de qualquer envio, e corpo do pedido de no maximo 1 MB (server.js).
 */

const MAX_TITLE_LENGTH = 150;
const MAX_AUTHOR_LENGTH = 100;
const MIN_TEXT_LENGTH = 2;

// Por rede (IP), no banco: quantas sugestoes em 24 horas.
export const MAX_PER_DEVICE_PER_DAY = 25;
// Por rede, sugestoes ACEITAS em 10 minutos: segura quem tenta encher a lista
// rapido (e esgotar o teto do dia de todo mundo) sem barrar, de uma vez so, a
// igreja inteira no mesmo Wi-Fi.
export const MAX_PER_DEVICE_PER_10_MIN = 8;
// Do acervo inteiro, por dia (de Brasilia): um ataque vindo de muitos IPs para aqui.
export const MAX_PER_DAY = 100;
// Fotos novas no Cloudinary por dia (o plano gratis tem cota).
export const MAX_PHOTOS_PER_DAY = 40;
// Tamanho maximo da lista esperando um administrador olhar.
export const MAX_STORED = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
// Endereco de site no texto (spam). So o inequivoco: "Revista .NET" e
// "Box.com: historia" sao titulos de verdade.
const LINK = /(https?:\/\/|www\.)/i;

// Quem e "a mesma rede": o IPv4 inteiro, ou a faixa /64 do IPv6 - cada casa
// ganha uma faixa inteira e pode trocar de endereco dentro dela a vontade.
export function networkOf(ip) {
  const address = String(ip || "").replace(/^::ffff:(?=\d+\.)/i, "");
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, "0")).join(":") + "::/64";
}

// Rajada: 20 tentativas a cada 10 minutos por rede (conta tambem as recusadas,
// para quem esta testando o formulario a forca nao ter tentativa de graca).
const burstLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => networkOf(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Muitas sugestões em pouco tempo. Aguarde alguns minutos e tente de novo.",
  },
});

// Tira tambem os caracteres invisiveis (espaco de largura zero, marcas e
// inversao de direcao do texto): sem isso, um titulo "em branco" ou
// embaralhado passaria pela conferencia de tamanho.
function cleanText(value, max) {
  return typeof value === "string"
    ? value
        .replace(/\p{Cf}/gu, "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
}

// Chave de comparacao: sem acento, sem pontuacao, minusculas ("O
// Peregrino." e "o peregrino" sao o mesmo livro).
function sortKey(text) {
  return normalizeText(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// O "dia" dos tetos e o de Brasilia (as mensagens dizem "amanha").
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// Reserva uma vaga no teto do dia. Devolve o _id reservado (para devolver a
// vaga no MESMO dia, mesmo que a meia-noite passe no meio do envio) ou null
// quando o teto esta cheio.
//
// Atomico: o filtro "n < max" e o $inc andam juntos, entao pedidos
// simultaneos nunca passam do teto. O documento do dia e criado antes, a
// parte: criar e contar no mesmo upsert dava "cheio" falso quando dois
// pedidos chegavam juntos no comeco do dia (os dois tentavam criar).
async function reserve(kind, max) {
  const id = kind + ":" + today();
  try {
    await SuggestionQuota.updateOne(
      { _id: id },
      { $setOnInsert: { n: 0 } },
      { upsert: true },
    );
  } catch (error) {
    // Outro pedido criou no mesmo instante: o documento existe, e o que importa.
    if (error.code !== 11000) throw error;
  }
  const taken = await SuggestionQuota.findOneAndUpdate(
    { _id: id, n: { $lt: max } },
    { $inc: { n: 1 } },
    { new: true },
  );
  return taken ? id : null;
}

// Devolve a vaga de quem reservou e nao chegou a gravar.
function release(id) {
  return SuggestionQuota.updateOne({ _id: id, n: { $gt: 0 } }, { $inc: { n: -1 } });
}

// Devolve todas as vagas reservadas, uma vez so (esvazia a lista antes, para
// um erro no meio nao fazer o catch de fora devolver de novo).
function releaseAll(reserved) {
  return Promise.all(reserved.splice(0).map(release));
}

// Resumo da rede (nao da para voltar ao IP) com o segredo do servidor.
function whoIs(req) {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET || "biblioteca-admpb")
    .update(networkOf(req.ip))
    .digest("hex")
    .slice(0, 32);
}

// O data URI diz "image/jpeg", mas o que importa e o conteudo: os primeiros
// bytes de um JPEG, PNG ou WebP de verdade.
function looksLikeImage(dataUri) {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1, dataUri.indexOf(",") + 1 + 24);
  const head = Buffer.from(base64, "base64");
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = head.subarray(0, 4).toString("latin1") === "\x89PNG";
  const webp =
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP";
  return jpeg || png || webp;
}

function publicItem(suggestion) {
  return {
    id: String(suggestion._id),
    title: suggestion.title,
    author: suggestion.author,
    photo: suggestion.photo || "",
    createdAt: suggestion.createdAt,
  };
}

// ---------- Publico: receber uma sugestao ----------

export const publicSuggestions = Router();

// POST /api/public/suggestions  { title, author, photo?, website? }
// photo: data URI da foto ja recortada pelo app (opcional).
// website: campo-isca, invisivel para gente; tem de vir vazio.
publicSuggestions.post("/", burstLimiter, async (req, res, next) => {
  let uploaded = null;
  // Vagas reservadas nos tetos do dia, devolvidas se a sugestao nao entrar.
  const reserved = [];
  try {
    const body = req.body || {};

    // Robo preencheu o campo escondido: responde como se tivesse dado certo
    // (para ele nao aprender a desviar) e nao grava nada.
    // (Qualquer coisa que nao seja texto vazio: o app sempre manda "".)
    if (
      body.website !== undefined &&
      body.website !== null &&
      !(typeof body.website === "string" && !body.website.trim())
    ) {
      return res.status(201).json({ ok: true });
    }

    const title = cleanText(body.title, MAX_TITLE_LENGTH);
    const author = cleanText(body.author, MAX_AUTHOR_LENGTH);
    if (title.length < MIN_TEXT_LENGTH) {
      return res.status(400).json({ error: "Informe o título do livro." });
    }
    if (author.length < MIN_TEXT_LENGTH) {
      return res.status(400).json({ error: "Informe o autor do livro." });
    }
    if (LINK.test(title) || LINK.test(author)) {
      return res
        .status(400)
        .json({ error: "Escreva só o título e o autor, sem links." });
    }

    const photo = body.photo;
    if (photo !== undefined && photo !== null && photo !== "") {
      assertValidImage(photo, SUGGESTION_PHOTO);
      if (!looksLikeImage(photo)) {
        return res
          .status(400)
          .json({ error: "A foto do livro precisa ser uma imagem JPG, PNG ou WebP." });
      }
    }
    const withPhoto = typeof photo === "string" && photo !== "";

    const who = whoIs(req);
    const since = new Date(Date.now() - DAY_MS);
    const [mine, mineNow, stored] = await Promise.all([
      SuggestionThrottle.countDocuments({ who, createdAt: { $gt: since } }),
      SuggestionThrottle.countDocuments({
        who,
        createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) },
      }),
      BookSuggestion.estimatedDocumentCount(),
    ]);
    // A mensagem fala da REDE, nao da pessoa: no Wi-Fi da igreja, quem bate
    // no limite pode nunca ter mandado nada.
    if (mineNow >= MAX_PER_DEVICE_PER_10_MIN) {
      return res.status(429).json({
        error: "Recebemos muitas sugestões desta rede agora. Aguarde alguns minutos e tente de novo.",
      });
    }
    if (mine >= MAX_PER_DEVICE_PER_DAY) {
      return res.status(429).json({
        error: "Recebemos muitas sugestões desta rede hoje. Tente de novo amanhã.",
      });
    }
    if (stored >= MAX_STORED) {
      return res.status(503).json({
        error: "Recebemos muitas sugestões por hoje. Tente de novo amanhã.",
      });
    }

    await SuggestionThrottle.create({ who });

    // A mesma sugestao de novo (de quem for): agradece e nao repete a linha.
    // (Dois envios iguais ao mesmo tempo sao barrados la embaixo, pelo
    // indice unico.)
    const titleSort = sortKey(title);
    const authorSort = sortKey(author);
    // So pontuacao ou emoji ("!!", "📖"): nao e titulo nem autor, e a chave
    // vazia faria todo o resto desse tipo parecer "repetida".
    if (!titleSort || !authorSort) {
      return res
        .status(400)
        .json({ error: "Escreva o título e o autor com letras ou números." });
    }
    if (await BookSuggestion.exists({ titleSort, authorSort })) {
      return res.json({ ok: true, duplicate: true });
    }

    const suggestionSlot = await reserve("sugestoes", MAX_PER_DAY);
    if (!suggestionSlot) {
      return res.status(503).json({
        error: "Recebemos muitas sugestões por hoje. Tente de novo amanhã.",
      });
    }
    reserved.push(suggestionSlot);
    if (withPhoto) {
      const photoSlot = await reserve("fotos", MAX_PHOTOS_PER_DAY);
      if (!photoSlot) {
        await releaseAll(reserved);
        return res.status(503).json({
          error: "Não dá para receber fotos agora. Envie a sugestão sem a foto.",
        });
      }
      reserved.push(photoSlot);
    }

    if (withPhoto) {
      try {
        uploaded = await uploadImage(photo, SUGGESTION_PHOTO);
      } catch (error) {
        console.error("[sugestoes] Foto nao enviada:", error.message);
        await releaseAll(reserved);
        return res.status(503).json({
          error: "Não foi possível enviar a foto agora. Tente de novo ou envie sem a foto.",
        });
      }
    }

    try {
      await BookSuggestion.create({
        title,
        author,
        titleSort,
        authorSort,
        photo: uploaded ? uploaded.url : "",
        photoPublicId: uploaded ? uploaded.publicId : "",
      });
    } catch (error) {
      // Outro envio igual chegou primeiro (indice unico): e repetida.
      if (error.code !== 11000) throw error;
      if (uploaded) await deleteImage(uploaded.publicId);
      uploaded = null;
      await releaseAll(reserved);
      return res.json({ ok: true, duplicate: true });
    }
    return res.status(201).json({ ok: true });
  } catch (error) {
    // A foto subiu mas a sugestao nao foi gravada: nao deixa a foto orfa.
    if (uploaded) await deleteImage(uploaded.publicId);
    await releaseAll(reserved).catch(() => {});
    return next(error);
  }
});

// Endereco que nao existe aqui: responde ja (sem cair nas rotas do acervo,
// que contariam o pedido de novo no limite por IP).
publicSuggestions.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

// Erro de validacao (4xx) mostra a mensagem, que ja e para a pessoa ler; o
// resto nunca mostra a mensagem interna - o detalhe fica so no log.
publicSuggestions.use((err, req, res, next) => {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("[sugestoes]", err);
  return res.status(503).json({
    error: "Não foi possível enviar a sugestão agora. Tente de novo em instantes.",
  });
});

// ---------- Painel: lista e exclusao (so administrador) ----------

const router = Router();
router.use(requireAdmin);

// GET /api/suggestions
// Todas as sugestoes, na ordem em que chegaram (a mais antiga primeiro).
router.get("/", async (req, res, next) => {
  try {
    const items = await BookSuggestion.find()
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAX_STORED)
      .lean();
    return res.json(items.map(publicItem));
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/suggestions  { ids: [...] }
// Exclui de uma vez as sugestoes da lista (ex.: depois de uma enxurrada de
// sugestoes falsas), com as fotos. So as que o administrador estava vendo
// (ids): uma que chegou depois de a tela carregar nao sai sem ser vista.
// Devolve quantas sairam.
router.delete("/", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (
      !ids ||
      ids.length === 0 ||
      ids.length > MAX_STORED ||
      !ids.every((id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id))
    ) {
      return res.status(400).json({ error: "Nenhuma sugestão para excluir." });
    }
    const found = await BookSuggestion.find({ _id: { $in: ids } })
      .select("photoPublicId")
      .lean();
    await BookSuggestion.deleteMany({ _id: { $in: found.map((s) => s._id) } });
    // Fotos de 10 em 10: centenas de chamadas juntas ao Cloudinary seriam
    // recusadas. (deleteImage nunca lanca erro; falhas ficam no log.)
    const photos = found.filter((s) => s.photoPublicId).map((s) => s.photoPublicId);
    for (let i = 0; i < photos.length; i += 10) {
      await Promise.all(photos.slice(i, i + 10).map(deleteImage));
    }
    return res.json({ ok: true, deleted: found.length });
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/suggestions/:id
// Tira a sugestao da lista e apaga a foto dela no Cloudinary.
router.delete("/:id", async (req, res, next) => {
  try {
    const suggestion = await BookSuggestion.findByIdAndDelete(req.params.id);
    if (!suggestion) {
      return res.status(404).json({ error: "Essa sugestão já foi excluída." });
    }
    if (suggestion.photoPublicId) await deleteImage(suggestion.photoPublicId);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
