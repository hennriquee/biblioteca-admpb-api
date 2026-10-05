/**
 * Capas de livros hospedadas no Cloudinary.
 *
 * - uploadCover(dataUri): recebe a foto ja recortada pelo front (data URI
 *   base64), envia para o Cloudinary e devolve { url, publicId }.
 * - deleteCover(publicId): apaga a foto la, para nao lotar o plano gratis.
 *
 * As credenciais vem do .env (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e
 * CLOUDINARY_API_SECRET). O segredo nunca sai do backend.
 */
import { v2 as cloudinary } from "cloudinary";

// Pasta onde as capas ficam no Cloudinary. Tambem serve de trava: so
// apagamos arquivos que estejam aqui dentro.
export const COVERS_FOLDER = "biblioteca-admpb/capas";

// Limite do arquivo ja decodificado. O front manda ~150 KB (600x900 JPEG);
// 4 MB e folga de sobra e impede abuso.
const MAX_BYTES = 4 * 1024 * 1024;

const DATA_URI_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,/i;

let configured = false;

export function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET,
  );
}

function ensureConfigured() {
  if (!isCloudinaryConfigured()) {
    const error = new Error(
      "O envio de fotos não está configurado no servidor (faltam as variáveis do Cloudinary).",
    );
    error.status = 503;
    throw error;
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function assertValidCoverImage(dataUri) {
  if (typeof dataUri !== "string" || !DATA_URI_PATTERN.test(dataUri)) {
    throw badRequest("A foto da capa precisa ser uma imagem JPG, PNG ou WebP.");
  }
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_BYTES) {
    throw badRequest("A foto da capa é grande demais (máximo de 4 MB).");
  }
}

export async function uploadCover(dataUri) {
  assertValidCoverImage(dataUri);
  ensureConfigured();

  let result;
  try {
    result = await cloudinary.uploader.upload(dataUri, {
      folder: COVERS_FOLDER,
      resource_type: "image",
      unique_filename: true,
      overwrite: false,
      // Mesmo que alguem mande uma imagem gigante, guardamos no maximo
      // 800x1200 (proporcao 2:3, a mesma do recorte do app).
      transformation: [{ width: 800, height: 1200, crop: "limit" }],
    });
  } catch (error) {
    console.error(
      "Falha no upload para o Cloudinary:",
      (error && (error.message || error.error?.message)) || error,
    );
    const failure = new Error(
      "Não foi possível enviar a foto da capa. Tente novamente em instantes.",
    );
    failure.status = 502;
    throw failure;
  }

  // Entrega otimizada: f_auto escolhe WebP/AVIF quando o navegador aceita e
  // q_auto reduz o peso sem perder qualidade visivel.
  const url = cloudinary.url(result.public_id, {
    secure: true,
    version: result.version,
    fetch_format: "auto",
    quality: "auto",
  });

  return { url, publicId: result.public_id };
}

// Apaga a capa no Cloudinary. Nunca lanca erro: o banco de dados e a fonte
// da verdade, entao uma falha aqui so vai para o log. Devolve true/false
// para quem chamou saber se deu certo.
export async function deleteCover(publicId) {
  if (!publicId || typeof publicId !== "string") return false;

  // Trava de seguranca: so mexe em arquivos da pasta de capas.
  if (!publicId.startsWith(COVERS_FOLDER + "/")) {
    console.error("Recusado apagar arquivo fora da pasta de capas:", publicId);
    return false;
  }

  try {
    ensureConfigured();
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      invalidate: true,
    });
    // "ok" = apagou; "not found" = ja nao existia (tudo bem, objetivo cumprido).
    if (result.result === "ok" || result.result === "not found") return true;
    console.error("Cloudinary nao apagou a capa " + publicId + ":", result);
    return false;
  } catch (error) {
    console.error(
      "Falha ao apagar a capa " + publicId + " no Cloudinary:",
      (error && (error.message || error.error?.message)) || error,
    );
    return false;
  }
}
