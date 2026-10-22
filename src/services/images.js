/**
 * Fotos hospedadas no Cloudinary: capas de livro e fotos de perfil das
 * pessoas do cadastro.
 *
 * - uploadImage(dataUri, destino): recebe a foto ja recortada pelo front
 *   (data URI base64), envia para o Cloudinary e devolve { url, publicId }.
 * - deleteImage(publicId): apaga a foto la, para nao lotar o plano gratis.
 *
 * REGRA DA CASA: toda foto guardada aqui tem um publicId salvo no banco
 * (Book.coverPublicId, Person.photoPublicId, BookSuggestion.photoPublicId).
 * Sempre que esse campo deixa de apontar para a foto (troca, remocao ou
 * exclusao do registro), quem fez a mudanca chama deleteImage com o publicId
 * ANTIGO. Se a gravacao no banco
 * falhar depois de um upload, a foto recem-enviada tambem e apagada: nenhuma
 * foto fica orfa no Cloudinary.
 *
 * As credenciais vem do .env (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e
 * CLOUDINARY_API_SECRET). O segredo nunca sai do backend.
 */
import { v2 as cloudinary } from "cloudinary";

// Destinos possiveis. A pasta tambem serve de trava: deleteImage so apaga
// arquivos que estejam dentro de uma destas pastas.
export const BOOK_COVER = {
  folder: "biblioteca-admpb/capas",
  // Capa de livro: retrato 2:3 (o front recorta em 600x900).
  width: 800,
  height: 1200,
  label: "a foto da capa",
};

// Foto de perfil de QUALQUER pessoa do cadastro, nao so de administrador (a
// pasta se chama "admins" porque nasceu assim; o nome dela no Cloudinary nao
// pode mudar sem orfanar as fotos que ja estao la).
export const PROFILE_PHOTO = {
  folder: "biblioteca-admpb/admins",
  // Foto de perfil: quadrada (o app mostra redonda, o front recorta 400x400).
  width: 600,
  height: 600,
  label: "a foto de perfil",
};

// Foto do livro que alguem do acervo publico sugeriu comprar (ver
// routes/suggestions.js). Mesmo recorte 2:3 da capa, pasta propria.
export const SUGGESTION_PHOTO = {
  folder: "biblioteca-admpb/sugestoes",
  width: 800,
  height: 1200,
  label: "a foto do livro",
};

const FOLDERS = [BOOK_COVER.folder, PROFILE_PHOTO.folder, SUGGESTION_PHOTO.folder];

// Limite do arquivo ja decodificado. O front manda ~150 KB (capa), ~60 KB
// (perfil com fundo) ou ate algumas centenas de KB (perfil recortado, que e
// PNG com transparencia e nao comprime como JPEG - ver services/background.js);
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

export function assertValidImage(dataUri, destination = BOOK_COVER) {
  const label = destination.label || "a foto";
  if (typeof dataUri !== "string" || !DATA_URI_PATTERN.test(dataUri)) {
    throw badRequest(
      label.charAt(0).toUpperCase() +
        label.slice(1) +
        " precisa ser uma imagem JPG, PNG ou WebP.",
    );
  }
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_BYTES) {
    throw badRequest(
      label.charAt(0).toUpperCase() +
        label.slice(1) +
        " é grande demais (máximo de 4 MB).",
    );
  }
}

export async function uploadImage(dataUri, destination = BOOK_COVER) {
  assertValidImage(dataUri, destination);
  ensureConfigured();

  let result;
  try {
    result = await cloudinary.uploader.upload(dataUri, {
      folder: destination.folder,
      resource_type: "image",
      unique_filename: true,
      overwrite: false,
      // Mesmo que alguem mande uma imagem gigante, guardamos no maximo o
      // tamanho do destino (mesma proporcao do recorte feito no app).
      transformation: [
        {
          width: destination.width,
          height: destination.height,
          crop: "limit",
        },
      ],
    });
  } catch (error) {
    console.error(
      "Falha no upload para o Cloudinary:",
      (error && (error.message || error.error?.message)) || error,
    );
    const failure = new Error(
      "Não foi possível enviar " +
        (destination.label || "a foto") +
        ". Tente novamente em instantes.",
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

// Apaga a foto no Cloudinary. Nunca lanca erro: o banco de dados e a fonte
// da verdade, entao uma falha aqui so vai para o log. Devolve true/false
// para quem chamou saber se deu certo.
export async function deleteImage(publicId) {
  if (!publicId || typeof publicId !== "string") return false;

  // Trava de seguranca: so mexe em arquivos das nossas pastas.
  if (!FOLDERS.some((folder) => publicId.startsWith(folder + "/"))) {
    console.error("Recusado apagar arquivo fora das pastas do app:", publicId);
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
    console.error("Cloudinary nao apagou a foto " + publicId + ":", result);
    return false;
  } catch (error) {
    console.error(
      "Falha ao apagar a foto " + publicId + " no Cloudinary:",
      (error && (error.message || error.error?.message)) || error,
    );
    return false;
  }
}
