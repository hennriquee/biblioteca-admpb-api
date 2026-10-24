import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import LoanRequest from "../models/LoanRequest.js";
import Loan from "../models/Loan.js";
import Book, { normalizeText } from "../models/Book.js";
import Person from "../models/Person.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  cleanPersonName,
  isFullName,
  NAME_ERROR,
  withAdminFlag,
} from "../services/people.js";
import {
  availableOf,
  noFreeCopyMessage,
  NOTHING_OUT,
  OCCUPYING_REQUEST,
  occupancyByBook,
  overbooked,
} from "../services/occupancy.js";
import {
  activeLoanWarning,
  readLoanDates,
  recordLoan,
} from "../services/loans.js";
import { announceAvailability } from "../services/returnAlerts.js";
import { preparePreview, previewFor } from "../services/requestPreview.js";
import { networkOf } from "./suggestions.js";

/**
 * SOLICITACOES DE EMPRESTIMO (ver models/LoanRequest.js).
 *
 * Tres partes aqui:
 * - publicRequests (/api/public/requests): SEM login. O acervo publico cria o
 *   link que vai no fim da mensagem do WhatsApp (solicitacao "pendente", que
 *   nao segura exemplar nenhum).
 * - o router padrao (/api/requests): so administrador. Lista, abre o link,
 *   registra (pelo link ou na mao), transforma em emprestimo e exclui.
 * - ogPreviewHandler (/og/requests/:token): o que a previa do link no
 *   WhatsApp mostra (titulo, autor e capa). Fora de /api: quem pergunta e a
 *   funcao da Vercel, que nao tem o passe do reCAPTCHA.
 */

// O link da mensagem vale 30 dias se ninguem usar.
const LINK_DAYS = 30;
// No acervo publico, o dia de preferencia vai de hoje ate 60 dias.
export const MAX_PICKUP_DAYS_AHEAD = 60;
// Teto do dia inteiro de links novos (um ataque de muitos IPs para aqui).
const MAX_PENDING_PER_DAY = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const LINK = /(https?:\/\/|www\.)/i;

const LINK_GONE =
  "Esse link de solicitação não vale mais: ela já virou empréstimo, foi excluída ou o prazo do link acabou. Se precisar, registre a solicitação na mão, em Empréstimos > Solicitados.";

// ---------- Datas ----------

// O "hoje" e o de Brasilia (o dia que a pessoa ve no calendario).
function todayInBrazil() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function addDays(day, days) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function brDate(day) {
  const [year, month, date] = day.split("-");
  return date + "/" + month + "/" + year;
}

// "2026-10-30" (o que o campo de data manda) -> { text, date } ou null. A data
// e gravada a meia-noite UTC, como as do emprestimo: o app le como "so o dia".
function readDay(value) {
  const text = typeof value === "string" ? value.trim().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(text + "T00:00:00Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    return null;
  }
  return { text, date };
}

// ---------- Ajudantes ----------

// Tira caracteres invisiveis e de controle (como nas sugestoes): um nome "em
// branco" ou embaralhado nao passa pela conferencia de tamanho.
function cleanText(value) {
  return typeof value === "string"
    ? value
        .replace(/\p{Cf}/gu, "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
    : "";
}

function newToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function readId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[a-f0-9]{24}$/i.test(id) ? id : null;
}

function bookCopy(book) {
  return {
    bookTitle: book.title,
    bookTitleSort: normalizeText(book.title),
    bookCover: book.cover || "",
    bookIsbn: book.isbn || "",
  };
}

// O livro como o painel o ve (mesmo formato de GET /api/books/:id).
async function withSituation(book) {
  const out = (await occupancyByBook([book._id])).get(String(book._id)) || NOTHING_OUT;
  return {
    ...book,
    copies: book.copies || 1,
    loanedCount: out.loaned,
    loanedNames: out.loanedNames,
    requestedCount: out.requested,
    requestedNames: out.requestedNames,
    available: availableOf(book, out),
  };
}

// A ficha de uma pessoa como o painel a mostra nas listas de escolha
// (mesmo formato de GET /api/people), ou null.
async function personCard(personId) {
  if (!personId) return null;
  const person = await Person.findById(personId).lean();
  if (!person) return null;
  const loans = await Loan.find({ person: person._id, status: "ativo" })
    .select("bookTitle")
    .lean();
  return {
    _id: person._id,
    code: person.code || null,
    fullName: person.fullName,
    phone: person.phone || "",
    photo: person.photo || "",
    loansCount: person.loansCount || 0,
    isAdmin: Boolean(person.username),
    activeLoans: loans.map((loan) => loan.bookTitle),
  };
}

// O que sai sobre uma solicitacao: o token do link nunca sai do servidor
// depois de criado (quem tem o link ja o conhece).
function toRequest(request) {
  const { token, ...rest } = request;
  return { ...rest, fromLink: Boolean(token) };
}

// =====================================================================
// Acervo publico: cria o link da mensagem do WhatsApp
// =====================================================================

export const publicRequests = Router();

// Rajada por rede: 15 a cada 10 minutos. Folgado (o Wi-Fi da igreja junta a
// congregacao num IP so) - quem segura abuso de verdade e o teto do dia.
const burstLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => "solicitacao:" + networkOf(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Muitas solicitações desta rede em pouco tempo. Aguarde alguns minutos e tente de novo.",
  },
});
// Por passe do reCAPTCHA (cada aparelho que marcou a caixa): 6 em 10 minutos.
const passLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  keyGenerator: (req) => "solicitacao-passe:" + (req.sitePassId || "nenhum"),
  skip: (req) => !req.sitePassId,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Você já fez várias solicitações agora. Aguarde alguns minutos e tente de novo.",
  },
});

// Busca de nomes do "Solicitar empréstimo": folgada para quem digita (cada
// letra pode virar uma busca), mas sem deixar varrer o cadastro.
// (Por rede o teto e alto: no domingo a igreja inteira digita nome no mesmo
// Wi-Fi, e cada nome vira umas 3 a 6 buscas. Quem segura varredura e o
// limite por passe e as regras da busca.)
const searchLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 1000,
  keyGenerator: (req) => "busca-nome:" + networkOf(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas buscas em pouco tempo. Aguarde alguns minutos." },
});
const searchPassLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 80,
  keyGenerator: (req) => "busca-nome-passe:" + (req.sitePassId || "nenhum"),
  skip: (req) => !req.sitePassId,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas buscas em pouco tempo. Aguarde alguns minutos." },
});

const MAX_NAME_RESULTS = 5;
// A escolha "sou eu" vai ao servidor como uma referencia CIFRADA (ref), e
// nao como o id do banco: o id nao sai da API publica (ele revela a data do
// cadastro) e a ref nao pode ser forjada nem lida - e AES-256-GCM, com chave
// derivada do JWT_SECRET, e vale 2 horas.
const PERSON_REF_MS = 2 * 60 * 60 * 1000;

function personRefKey() {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update("ficha-da-busca-de-nomes")
    .digest();
}

function personRef(personId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", personRefKey(), iv);
  const plain = Buffer.from(String(personId) + "." + (Date.now() + PERSON_REF_MS));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
}

// O id da ficha dentro da ref, ou null (ref falsa, adulterada ou vencida).
function readPersonRef(ref) {
  if (typeof ref !== "string" || ref.length > 200) return null;
  try {
    const raw = Buffer.from(ref, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", personRefKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
    const [id, until] = plain.split(".");
    if (!(Number(until) > Date.now())) return null;
    return readId(id);
  } catch {
    return null;
  }
}

// Palavras do nome digitado, sem acento e sem pontuacao. (O nome no cadastro
// guarda hifen e apostrofo - "ana-maria", "d'avila" -; por isso a busca aceita
// essas marcas como comeco de palavra, abaixo.)
function nameWords(value) {
  return normalizeText(cleanText(value).slice(0, 80))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
}

/**
 * GET /api/public/requests/people?name=Maria Nog -> { people: [{ id, name,
 * hint }] }
 *
 * "E voce?": quem esta pedindo um livro toca no proprio nome. O cadastro e de
 * gente da igreja, entao a busca e apertada de proposito:
 * - so procura com NOME E COMECO DO SOBRENOME digitados: duas palavras ou
 *   mais, a primeira com 3 letras ou mais e alguma outra com 2 ou mais -
 *   "Jo" ou "Maria S" nao listam ninguem;
 * - o primeiro nome tem de bater com o COMECO do nome cadastrado, e cada
 *   outra palavra com o comeco de alguma palavra do nome;
 * - no maximo 5 resultados;
 * - sai so o nome e, para separar dois nomes iguais, os 2 ultimos digitos do
 *   WhatsApp. Nada de foto, numero (#), telefone inteiro, livros nem o id do
 *   banco (vai uma "ref" cifrada, que vale 2 horas - ver personRef).
 */
publicRequests.get("/people", searchLimiter, searchPassLimiter, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const words = nameWords(typeof req.query.name === "string" ? req.query.name : "");
    if (
      words.length < 2 ||
      words[0].length < 3 ||
      !words.slice(1).some((word) => word.length >= 2)
    ) {
      return res.json({ people: [] });
    }

    const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Comeco de palavra: inicio, espaco, hifen, apostrofo ou ponto.
    const clauses = [
      { nameSort: new RegExp("^" + escape(words[0])) },
      ...words.slice(1).map((word) => ({
        nameSort: new RegExp("(^|[\\s'\u2019.-])" + escape(word)),
      })),
    ];
    const people = await Person.find({ $and: clauses })
      .select("fullName phone")
      .sort({ nameSort: 1, _id: 1 })
      .limit(MAX_NAME_RESULTS)
      .lean();

    return res.json({
      people: people.map((person) => ({
        ref: personRef(person._id),
        name: person.fullName,
        hint:
          person.phone && person.phone.length >= 4
            ? "WhatsApp terminado em " + person.phone.slice(-2)
            : "",
      })),
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/public/requests  { bookId, name, pickupDate, website, personRef?,
// newPerson? } -> 201 { token, pickupDate, name } (200 quando o mesmo pedido
// e repetido). personRef: a pessoa tocou no proprio nome na busca (o nome que
// vale e o do cadastro); newPerson: tocou em "Nao sou nenhuma dessas pessoas".
publicRequests.post("/", burstLimiter, passLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    // Campo-isca escondido: so robo preenche.
    if (body.website) return res.status(400).json({ error: "Pedido inválido." });

    const bookId = readId(body.bookId);
    if (!bookId) return res.status(400).json({ error: "Esse livro não existe." });

    // Escolheu o proprio nome na busca: vale o nome do cadastro.
    let chosen = null;
    if (body.personRef !== undefined && body.personRef !== null && body.personRef !== "") {
      const personId = readPersonRef(body.personRef);
      chosen = personId
        ? await Person.findById(personId).select("fullName").lean()
        : null;
      if (!chosen) {
        return res.status(409).json({
          code: "PERSON_GONE",
          error: "Não conseguimos confirmar o seu nome no cadastro. Toque nele de novo na lista.",
        });
      }
    }
    const requesterIsNew = !chosen && body.newPerson === true;

    const name = chosen ? chosen.fullName : cleanPersonName(cleanText(body.name));
    if (!name) return res.status(400).json({ error: "Digite o seu nome completo." });
    if (!chosen && (LINK.test(name) || !/\p{L}/u.test(name))) {
      return res.status(400).json({ error: "Digite só o seu nome completo." });
    }
    if (!chosen && !isFullName(name)) return res.status(400).json({ error: NAME_ERROR });

    const today = todayInBrazil();
    const last = addDays(today, MAX_PICKUP_DAYS_AHEAD);
    const day = readDay(body.pickupDate);
    if (!day) {
      return res.status(400).json({ error: "Escolha o dia em que quer pegar o livro." });
    }
    // Um dia de folga para tras: o relogio do celular pode estar atrasado.
    if (day.text < addDays(today, -1) || day.text > last) {
      return res.status(400).json({
        error: "Escolha um dia entre hoje e " + brDate(last) + ".",
      });
    }

    const book = await Book.findById(bookId)
      .select("title cover isbn copies")
      .lean();
    if (!book) {
      return res.status(404).json({ error: "Esse livro não está mais no acervo." });
    }
    const out = (await occupancyByBook([book._id])).get(String(book._id)) || NOTHING_OUT;
    if (availableOf(book, out) === 0) {
      return res.status(409).json({
        code: "BOOK_UNAVAILABLE",
        error:
          "Esse livro acabou de ser emprestado ou solicitado por outra pessoa. Que tal escolher outro?",
      });
    }

    const nameKey = normalizeText(name);
    const linkExpiresAt = new Date(Date.now() + LINK_DAYS * DAY_MS);

    // A mesma pessoa pedindo o mesmo livro de novo (voltou e confirmou outra
    // vez, trocou o dia): o link e o mesmo, so o dia muda.
    const again = await LoanRequest.findOneAndUpdate(
      {
        book: book._id,
        status: "pendente",
        requesterNameSort: nameKey,
        createdAt: { $gt: new Date(Date.now() - DAY_MS) },
      },
      {
        $set: {
          pickupDate: day.date,
          linkExpiresAt,
          requesterName: name,
          requesterPerson: chosen ? chosen._id : null,
          requesterIsNew,
        },
      },
      { new: true },
    );
    if (again) {
      preparePreview(book._id);
      return res.json({ token: again.token, pickupDate: day.text, name });
    }

    const createdToday = await LoanRequest.countDocuments({
      status: "pendente",
      createdAt: { $gt: new Date(Date.now() - DAY_MS) },
    });
    if (createdToday >= MAX_PENDING_PER_DAY) {
      return res.status(503).json({
        error:
          "Recebemos muitas solicitações hoje. Fale com a equipe da biblioteca pelo WhatsApp ou pessoalmente.",
      });
    }

    const request = await LoanRequest.create({
      book: book._id,
      ...bookCopy(book),
      status: "pendente",
      token: newToken(),
      requesterName: name,
      requesterNameSort: nameKey,
      requesterPerson: chosen ? chosen._id : null,
      requesterIsNew,
      pickupDate: day.date,
      linkExpiresAt,
    });

    // A capa da previa do link fica pronta em segundo plano (ver
    // services/requestPreview.js): a resposta nao espera por ela.
    preparePreview(book._id);

    return res.status(201).json({ token: request.token, pickupDate: day.text, name });
  } catch (error) {
    return next(error);
  }
});

// Erro nesta area nunca mostra a mensagem interna (como no resto do acervo
// publico). Os 4xx montados acima ja sairam antes de chegar aqui.
publicRequests.use((err, req, res, next) => {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("[solicitacoes]", err);
  return res.status(500).json({
    error: "Não foi possível registrar a solicitação agora. Tente de novo em instantes.",
  });
});

// =====================================================================
// Previa do link no WhatsApp (sem passe, fora de /api)
// =====================================================================

// GET /og/requests/:token -> { title, authors, image }
export async function ogPreviewHandler(req, res) {
  res.set("Cache-Control", "no-store");
  try {
    const token = String(req.params.token || "");
    const preview = TOKEN_PATTERN.test(token) ? await previewFor(token) : null;
    if (!preview) return res.status(404).json({ error: "Link não encontrado." });
    return res.json(preview);
  } catch (error) {
    console.error("[previa]", error);
    return res.status(500).json({ error: "Erro ao montar a prévia." });
  }
}

// =====================================================================
// Painel (so administrador)
// =====================================================================

const router = Router();
router.use(requireAdmin);

// GET /api/requests -> as solicitacoes registradas, da retirada prevista mais
// proxima para a mais distante.
router.get("/", async (req, res, next) => {
  try {
    // Solicitacao que ficou no meio do "Realizar emprestimo" (servidor
    // reiniciou) e acertada aqui tambem, nao so ao iniciar o servidor.
    await recoverStuckConversions();
    const requests = await LoanRequest.find({ status: { $in: OCCUPYING_REQUEST } })
      .sort({ pickupDate: 1, createdAt: 1, _id: 1 })
      .lean();
    // A foto de quem vai levar (o painel mostra o rosto para conferir).
    const people = await Person.find({
      _id: { $in: requests.map((item) => item.person).filter(Boolean) },
    })
      .select("photo")
      .lean();
    const photoById = new Map(people.map((person) => [String(person._id), person.photo || ""]));
    return res.json(
      await withAdminFlag(
        requests.map((item) => ({
          ...toRequest(item),
          personPhoto: photoById.get(String(item.person)) || "",
        })),
      ),
    );
  } catch (error) {
    return next(error);
  }
});

// GET /api/requests/link/:token -> o que o link da mensagem do WhatsApp traz:
// { requesterName, pickupDate, book }. 404 (code LINK_GONE) quando o link nao
// vale mais; 409 (code LINK_USED) quando ja foi usado - abrir de novo, ou
// compartilhado, nao registra nada.
router.get("/link/:token", async (req, res, next) => {
  try {
    const token = String(req.params.token || "");
    const request = TOKEN_PATTERN.test(token)
      ? await LoanRequest.findOne({ token }).lean()
      : null;
    if (!request) return res.status(404).json({ code: "LINK_GONE", error: LINK_GONE });
    if (request.status !== "pendente") {
      return res.status(409).json({
        code: "LINK_USED",
        error:
          "Esse link já foi usado: a solicitação de " +
          request.personName +
          " já está registrada.",
        personName: request.personName,
        bookTitle: request.bookTitle,
        requestId: request._id,
      });
    }
    const book = await Book.findById(request.book).lean();
    if (!book) {
      return res.status(404).json({
        code: "LINK_GONE",
        error: "O livro desse link não está mais no acervo.",
      });
    }
    return res.json({
      token,
      requesterName: request.requesterName,
      // A ficha em que a pessoa tocou no acervo publico (ou null) e se ela
      // disse que nao esta no cadastro.
      requesterPerson: await personCard(request.requesterPerson),
      requesterIsNew: Boolean(request.requesterIsNew),
      pickupDate: request.pickupDate,
      book: await withSituation(book),
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/requests  { personId, pickupDate, bookId } ou { personId,
// pickupDate, token } (pelo link: o livro e o do link).
// Registra a solicitacao: a partir daqui o exemplar fica segurado para essa
// pessoa. Responde 201 com a solicitacao.
router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const personId = readId(body.personId);
    if (!personId) {
      return res.status(400).json({
        error: "Selecione a pessoa cadastrada (ou cadastre uma nova) antes de registrar.",
      });
    }
    const day = readDay(body.pickupDate);
    if (!day) return res.status(400).json({ error: "Informe a retirada prevista." });
    const today = todayInBrazil();
    if (day.text < addDays(today, -365) || day.text > addDays(today, 365)) {
      return res.status(400).json({ error: "A retirada prevista não é válida." });
    }

    const token = typeof body.token === "string" ? body.token : "";
    let pending = null;
    let book = null;
    if (token) {
      pending = TOKEN_PATTERN.test(token)
        ? await LoanRequest.findOne({ token }).lean()
        : null;
      if (!pending) return res.status(404).json({ code: "LINK_GONE", error: LINK_GONE });
      if (pending.status !== "pendente") {
        return res.status(409).json({
          code: "LINK_USED",
          error:
            "Esse link já foi usado: a solicitação de " +
            pending.personName +
            " já está registrada.",
        });
      }
      book = await Book.findById(pending.book);
    } else {
      const bookId = readId(body.bookId);
      if (!bookId) return res.status(400).json({ error: "Escolha um livro." });
      book = await Book.findById(bookId);
    }
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });

    const person = await Person.findById(personId);
    if (!person) return res.status(404).json({ error: "Pessoa não encontrada." });

    if (
      await LoanRequest.exists({
        book: book._id,
        person: person._id,
        status: { $in: OCCUPYING_REQUEST },
      })
    ) {
      return res.status(409).json({
        error: person.fullName + " já tem uma solicitação desse livro.",
      });
    }

    const busy = await noFreeCopyMessage(book);
    if (busy) return res.status(409).json({ error: busy });

    const fields = {
      ...bookCopy(book),
      status: "solicitado",
      pickupDate: day.date,
      person: person._id,
      personName: person.fullName,
      personNameSort: normalizeText(person.fullName),
      personCode: person.code || null,
      personPhone: person.phone || "",
      registeredBy: req.account._id,
      registeredByName: req.account.fullName,
      registeredAt: new Date(),
      linkExpiresAt: null,
    };

    let request;
    if (pending) {
      // So um administrador usa o link: dois abrindo ao mesmo tempo, o
      // segundo recebe "ja foi usado".
      request = await LoanRequest.findOneAndUpdate(
        { _id: pending._id, status: "pendente" },
        { $set: fields },
        { new: true },
      );
      if (!request) {
        return res.status(409).json({
          code: "LINK_USED",
          error: "Esse link acabou de ser usado por outro administrador.",
        });
      }
    } else {
      request = await LoanRequest.create({ book: book._id, token: null, ...fields });
    }

    // Conferencia de depois de gravar (ver services/occupancy.js).
    if (await overbooked(book)) {
      if (pending) await LoanRequest.replaceOne({ _id: pending._id }, pending);
      else await LoanRequest.deleteOne({ _id: request._id });
      return res.status(409).json({
        error:
          "Outro administrador acabou de registrar o último exemplar desse livro. Atualize a tela e confira.",
      });
    }

    return res.status(201).json(await withAdminFlag(toRequest(request.toObject())));
  } catch (error) {
    return next(error);
  }
});

// POST /api/requests/:id/loan  { startDate, dueDate, notes, force }
// "Realizar empréstimo": a solicitacao vira emprestimo da MESMA pessoa e do
// MESMO livro (nenhum dos dois muda aqui); so as datas e a observacao vem da
// tela. Responde 201 com o emprestimo, e a solicitacao sai do banco.
router.post("/:id/loan", async (req, res, next) => {
  try {
    await recoverStuckConversions();
    const request = await LoanRequest.findById(req.params.id);
    if (!request || request.status === "pendente") {
      return res.status(404).json({
        error: "Essa solicitação não existe mais (já virou empréstimo ou foi excluída).",
      });
    }
    if (request.status === "convertendo") {
      return res.status(409).json({
        error: "Essa solicitação já está virando empréstimo. Atualize a tela.",
      });
    }

    const body = req.body || {};
    const { start, due } = readLoanDates(body.startDate, body.dueDate);

    const [book, person] = await Promise.all([
      Book.findById(request.book),
      Person.findById(request.person),
    ]);
    if (!book) return res.status(404).json({ error: "Livro não encontrado." });
    if (!person) return res.status(404).json({ error: "Pessoa não encontrada." });

    // A mesma pergunta do Novo emprestimo: "ja esta com outro livro".
    const warning = body.force ? null : await activeLoanWarning(person);
    if (warning) return res.status(409).json(warning);

    // Marca a solicitacao: dois toques (ou dois administradores) nunca fazem
    // dois emprestimos dela.
    const claimed = await LoanRequest.findOneAndUpdate(
      { _id: request._id, status: "solicitado" },
      { $set: { status: "convertendo", convertingAt: new Date() } },
      { new: true },
    );
    if (!claimed) {
      return res.status(409).json({
        error: "Essa solicitação acabou de virar empréstimo ou foi excluída. Atualize a tela.",
      });
    }

    let loan;
    try {
      loan = await recordLoan({
        book,
        person,
        account: req.account,
        start,
        due,
        notes: body.notes,
        exceptRequestId: claimed._id,
      });
    } catch (error) {
      await LoanRequest.updateOne(
        { _id: claimed._id, status: "convertendo" },
        { $set: { status: "solicitado", convertingAt: null } },
      );
      throw error;
    }
    await LoanRequest.deleteOne({ _id: claimed._id });

    return res.status(201).json(await withAdminFlag(loan.toObject()));
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/requests/:id -> exclui a solicitacao; o exemplar volta para a
// estante (e quem pediu "Avise-me quando voltar" fica sabendo).
router.delete("/:id", async (req, res, next) => {
  try {
    await recoverStuckConversions();
    const removed = await LoanRequest.findOneAndDelete({
      _id: req.params.id,
      status: "solicitado",
    });
    if (!removed) {
      const still = await LoanRequest.findById(req.params.id).select("status").lean();
      if (still?.status === "convertendo") {
        return res.status(409).json({
          error: "Essa solicitação está virando empréstimo agora. Atualize a tela.",
        });
      }
      return res.status(404).json({ error: "Essa solicitação não existe mais." });
    }
    announceAvailability(removed.book);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Rede de seguranca: solicitacao que ficou presa em "convertendo" (o servidor
 * caiu no meio do "Realizar emprestimo"). Se o emprestimo chegou a ser
 * gravado, ela sai; senao, volta a ser solicitacao. Roda ao iniciar o
 * servidor e tambem ao listar, excluir e efetivar (um reinicio rapido, de
 * poucos segundos, nao pode deixar o exemplar preso ate o proximo).
 *
 * Uma conversao de verdade leva menos de 1 segundo. Durante o uso, so mexe
 * no que esta parado ha mais de 30 s; ao iniciar o servidor, 10 s bastam
 * (a folga cobre o servidor antigo ainda terminando um pedido durante a
 * troca de versao no Render).
 */
export async function recoverStuckConversions({ olderThanMs = 30 * 1000 } = {}) {
  const stuck = await LoanRequest.find({
    status: "convertendo",
    convertingAt: { $lt: new Date(Date.now() - olderThanMs) },
  }).lean();
  let fixed = 0;
  for (const request of stuck) {
    const loanExists = await Loan.exists({
      book: request.book,
      person: request.person,
      createdAt: { $gte: new Date(request.convertingAt.getTime() - 1000) },
    });
    if (loanExists) {
      await LoanRequest.deleteOne({ _id: request._id, status: "convertendo" });
    } else {
      await LoanRequest.updateOne(
        { _id: request._id, status: "convertendo" },
        { $set: { status: "solicitado", convertingAt: null } },
      );
    }
    fixed += 1;
  }
  return fixed;
}

export default router;
