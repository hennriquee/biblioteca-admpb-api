/**
 * PREVIA DO LINK DA SOLICITACAO NO WHATSAPP.
 *
 * A mensagem que o acervo publico monta para o WhatsApp da biblioteca termina
 * com um link (/solicitacao/<token>). Quando a pessoa cola um link no
 * WhatsApp, o aplicativo dela busca a pagina e mostra, acima do texto, a
 * imagem e o titulo que a pagina anuncia (as etiquetas "og:" do HTML). Quem
 * responde ao WhatsApp e uma funcao da Vercel (frontend/api/solicitacao.js),
 * que pergunta a ESTE servidor qual livro o link e (GET /og/requests/:token).
 *
 * A imagem e a capa do livro, centralizada num quadro deitado (1200 x 630, o
 * formato em que o WhatsApp mostra a imagem grande, por cima da mensagem). O
 * quadro e montado pelo proprio Cloudinary, pelo endereco da imagem:
 * - capa enviada pelo app: ja esta no Cloudinary, so muda o endereco;
 * - capa que e link de outro site (Open Library, Google...): o Cloudinary
 *   copia a imagem UMA vez por livro (pasta "previas", nome = id do livro) e
 *   o quadro sai da copia. Trocou a capa, a copia e refeita.
 *
 * Nada aqui atrasa a pessoa: a copia comeca quando o link nasce, em segundo
 * plano, e a pergunta do WhatsApp espera por ela no maximo alguns segundos.
 */
import Book from "../models/Book.js";
import LoanRequest from "../models/LoanRequest.js";
import {
  cloudinary,
  deleteImage,
  ensureConfigured,
  isCloudinaryConfigured,
  PREVIEW_IMAGE,
} from "./images.js";

const PREVIEW_TRANSFORMATION = [
  { width: 1200, height: 630, crop: "pad", background: "rgb:FBF7EE" },
  { quality: "auto:good", fetch_format: "jpg" },
];
// Quanto a pergunta do WhatsApp espera a copia da capa ficar pronta.
const WAIT_FOR_PREPARE_MS = 4000;
const UPLOAD_TIMEOUT_MS = 10000;
const BOOK_FIELDS = "title authors cover coverPublicId ogImagePublicId ogImageSource";

// Preparos em andamento, por livro (o servidor do Render e um so).
const inFlight = new Map();

function isHttps(url) {
  return /^https:\/\//i.test(String(url || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function framed(publicId) {
  ensureConfigured();
  return cloudinary.url(publicId, {
    secure: true,
    transformation: PREVIEW_TRANSFORMATION,
  });
}

/**
 * Endereco da imagem da previa ("" = sem imagem: a funcao da Vercel usa a
 * logo da biblioteca). Sem a copia pronta, vale a propria capa de fora, do
 * jeito que ela e (o WhatsApp mostra menor, mas mostra).
 */
export function previewImageUrl(book) {
  if (!book?.cover) return "";
  if (isCloudinaryConfigured()) {
    if (book.coverPublicId) return framed(book.coverPublicId);
    if (book.ogImagePublicId && book.ogImageSource === book.cover) {
      return framed(book.ogImagePublicId);
    }
  }
  return isHttps(book.cover) ? book.cover : "";
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error("tempo esgotado");
    }),
  ]);
}

/**
 * Deixa a imagem da previa pronta (em segundo plano: nunca lanca erro).
 * Chamado quando o acervo publico cria o link de uma solicitacao.
 */
export function preparePreview(bookId) {
  const key = String(bookId);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    if (!isCloudinaryConfigured()) return;
    const book = await Book.findById(bookId).select(BOOK_FIELDS).lean();
    if (!book?.cover) return;

    const needsCopy =
      !book.coverPublicId &&
      /^https?:\/\//i.test(book.cover) &&
      !(book.ogImagePublicId && book.ogImageSource === book.cover);
    if (needsCopy) {
      ensureConfigured();
      // Quem baixa a imagem de fora e o Cloudinary, nao este servidor.
      const result = await withTimeout(
        cloudinary.uploader.upload(book.cover, {
          public_id: PREVIEW_IMAGE.folder + "/" + key,
          overwrite: true,
          invalidate: true,
          resource_type: "image",
          transformation: [
            { width: PREVIEW_IMAGE.width, height: PREVIEW_IMAGE.height, crop: "limit" },
          ],
        }),
        UPLOAD_TIMEOUT_MS,
      );
      // So grava se a capa nao mudou enquanto a copia era feita.
      await Book.updateOne(
        { _id: book._id, cover: book.cover },
        { ogImagePublicId: result.public_id, ogImageSource: book.cover },
      );
      book.ogImagePublicId = result.public_id;
      book.ogImageSource = book.cover;
    }

    // Pede a imagem uma vez: o Cloudinary monta o quadro na primeira vez que
    // alguem pede, e a primeira pessoa a pedir nao e o WhatsApp.
    const url = previewImageUrl(book);
    if (url.startsWith("https://res.cloudinary.com/")) {
      await fetch(url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
        .then((response) => response.arrayBuffer())
        .catch(() => {});
    }
  })()
    .catch((error) => {
      console.error(
        "[previa] Não foi possível preparar a capa do livro " + key + ":",
        (error && (error.message || error.error?.message)) || error,
      );
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/** O que a previa do link mostra: { title, authors, image } ou null. */
export async function previewFor(token) {
  const request = await LoanRequest.findOne({ token })
    .select("book bookTitle")
    .lean();
  if (!request) return null;

  const pending = inFlight.get(String(request.book));
  if (pending) await Promise.race([pending, sleep(WAIT_FOR_PREPARE_MS)]);

  const book = await Book.findById(request.book).select(BOOK_FIELDS).lean();
  return {
    title: book?.title || request.bookTitle,
    authors: book?.authors || [],
    image: previewImageUrl(book),
  };
}

/** A capa mudou (ou o livro saiu do acervo): a copia da previa sai junto. */
export async function forgetPreviewImage(book) {
  if (!book?.ogImagePublicId) return;
  await deleteImage(book.ogImagePublicId);
  await Book.updateOne(
    { _id: book._id, ogImagePublicId: book.ogImagePublicId },
    { ogImagePublicId: "", ogImageSource: "" },
  );
}
