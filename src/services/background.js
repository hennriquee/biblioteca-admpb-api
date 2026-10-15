/**
 * Recorte do fundo da foto de perfil (remove.bg).
 *
 * O app manda a foto JA RECORTADA pelo front (quadrado 400x400, data URI) e
 * recebe de volta a MESMA foto em PNG com fundo transparente - so a pessoa,
 * sem a parede, a cortina nem o resto do ambiente atras.
 *
 * POR QUE A remove.bg: e a unica API de recorte de fundo cuja cota gratuita
 * se RENOVA todo mes (a conta gratis recebe, por mes, 50 fotos no tamanho
 * "preview", sem cartao). As outras que olhamos dao credito de boas-vindas
 * que acaba e nao volta (withoutbg: 50 creditos uma vez so), ou uma cota
 * menor (Cloudinary: 15/mes no complemento gratis; PhotoRoom: 10/mes com
 * marca d'agua).
 *
 * POR QUE size=preview: e o tamanho barato (a tabela da remove.bg cobra uma
 * fracao do credito por foto de "preview", contra 1 credito inteiro da foto
 * grande) e e justamente o que a conta gratuita pode usar. Quanto cada
 * chamada custou de verdade sai no log do servidor, no cabecalho
 * X-Credits-Charged que a resposta traz. Ele entrega ate 0,25 megapixel, e a nossa foto de
 * perfil tem 400x400 = 0,16 MP: CABE INTEIRA e volta sem perder nada. Se um
 * dia o recorte do front crescer (ver PhotoPicker/CoverEditor), passar de
 * 500x500 faria a remove.bg reduzir a foto - e ai o certo seria assinar um
 * plano, nao trocar este parametro por "full" (que cobra 4x mais e o plano
 * gratis nao cobre).
 *
 * A chave fica em REMOVEBG_API_KEY, so no backend (o navegador nunca a ve).
 * SEM A CHAVE o sistema continua funcionando: a rota avisa, e o app salva a
 * foto com o fundo original (ver routes/photos.js e PhotoPicker.jsx).
 */

const ENDPOINT = "https://api.remove.bg/v1.0/removebg";

// A remove.bg costuma responder em 1-3 s. 25 s e folga para dia ruim; passou
// disso, e melhor avisar e salvar a foto com o fundo original do que deixar
// a tela travada esperando.
const TIMEOUT_MS = 25000;

export function isBackgroundRemovalConfigured() {
  return Boolean(process.env.REMOVEBG_API_KEY);
}

function failure(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// Mensagem que a propria remove.bg manda no corpo do erro, quando manda:
// { "errors": [{ "title": "...", "code": "..." }] }. So vai para o LOG do
// servidor - quem usa o app recebe a mensagem em portugues.
async function upstreamDetail(response) {
  try {
    const body = await response.json();
    const first = Array.isArray(body?.errors) ? body.errors[0] : null;
    return first?.title || first?.code || JSON.stringify(body);
  } catch {
    return "sem detalhes no corpo da resposta";
  }
}

/**
 * Devolve a foto recebida como PNG com fundo transparente (data URI).
 * Lanca erro com .status e .code quando nao da - nunca devolve a foto
 * original disfarcada de recorte.
 */
export async function removePhotoBackground(dataUri) {
  if (!isBackgroundRemovalConfigured()) {
    throw failure(
      "O recorte de fundo não está configurado no servidor (falta a variável REMOVEBG_API_KEY).",
      503,
      "BACKGROUND_NOT_CONFIGURED",
    );
  }

  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "X-Api-Key": process.env.REMOVEBG_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_file_b64: base64,
        // type=person: a remove.bg usa o modelo de pessoa, nao o de produto.
        type: "person",
        size: "preview",
        format: "png",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(
      "Falha ao falar com a remove.bg:",
      error?.name === "TimeoutError" ? "demorou demais" : error?.message || error,
    );
    throw failure(
      "O serviço que recorta o fundo não respondeu.",
      502,
      "BACKGROUND_UNAVAILABLE",
    );
  }

  if (!response.ok) {
    const detail = await upstreamDetail(response);
    console.error("remove.bg recusou (HTTP " + response.status + "):", detail);

    if (response.status === 402) {
      throw failure(
        "As remoções de fundo gratuitas do mês acabaram (a cota volta no mês que vem).",
        402,
        "BACKGROUND_NO_CREDITS",
      );
    }
    // 401 e 403: chave ausente, errada ou sem permissao. Nao melhora
    // tentando de novo, entao o app para de pedir recorte nesta visita.
    if (response.status === 401 || response.status === 403) {
      throw failure(
        "A chave do serviço que recorta o fundo foi recusada. Confira REMOVEBG_API_KEY no servidor.",
        502,
        "BACKGROUND_BAD_KEY",
      );
    }
    if (response.status === 429) {
      throw failure(
        "Muitas fotos em pouco tempo no serviço que recorta o fundo. Aguarde um instante.",
        429,
        "BACKGROUND_RATE_LIMIT",
      );
    }
    if (response.status === 400) {
      throw failure(
        "O serviço não conseguiu recortar o fundo desta foto.",
        422,
        "BACKGROUND_REJECTED",
      );
    }
    throw failure(
      "O serviço que recorta o fundo falhou.",
      502,
      "BACKGROUND_UNAVAILABLE",
    );
  }

  // Quanto esta foto custou da cota, direto da remove.bg: e o numero para
  // conferir no log se a conta do mes esta de pe.
  const charged = response.headers.get("X-Credits-Charged");
  if (charged) console.log("remove.bg: " + charged + " de credito nesta foto.");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    console.error("remove.bg devolveu uma resposta vazia.");
    throw failure(
      "O serviço que recorta o fundo devolveu uma foto vazia.",
      502,
      "BACKGROUND_UNAVAILABLE",
    );
  }

  return "data:image/png;base64," + buffer.toString("base64");
}
