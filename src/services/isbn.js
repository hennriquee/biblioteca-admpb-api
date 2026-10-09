/**
 * Busca dados de um livro pelo ISBN usando tres APIs gratuitas e sem cadastro:
 * 1) BrasilAPI (brasilapi.com.br) - agrega CBL (agencia oficial do ISBN no
 *    Brasil), Mercado Editorial, Open Library e Google Books numa unica
 *    chamada. E a que mais acha livro nacional, entao consultamos primeiro.
 * 2) Open Library (openlibrary.org) - via search.json, o endpoint atual e mais estavel
 * 3) Google Books (googleapis.com/books) - usado como reforco quando disponivel
 *
 * Se as tres acima nao acharem NEM O TITULO (livro nao cadastrado em
 * nenhuma), tentamos como reforco 4) o SerpAPI (busca do Google, precisa da
 * SERP_API_KEY no .env) e, por ultimo, 5) uma busca de texto no DuckDuckGo
 * so para adivinhar o titulo - esses dados vem marcados como aproximados,
 * pois nao ha como confirmar com certeza.
 *
 * Para a CAPA, se nenhuma das fontes acima trouxer imagem, ainda tentamos,
 * nessa ordem: a) capa direta da Open Library (endpoint oficial); b) imagens
 * do Google via SerpAPI; c) busca publica do Mercado Livre, primeiro por ISBN
 * (raro achar, mas confiavel quando acha) e depois por titulo+autor (acha
 * muito mais, com uma checagem mais fraca de similaridade de titulo);
 * d) busca de imagens no DuckDuckGo; e) padrao de URL de capa da Amazon
 * (chute final).
 *
 * A CATEGORIA vem da BrasilAPI ("subjects") e do Google Books ("categories"),
 * convertidas para portugues e reduzidas ao nivel mais amplo (ver
 * categories.js). A Open Library nao entra: seus "subject" sao etiquetas soltas.
 *
 * O SerpAPI tem cota mensal limitada no plano gratis, por isso ele so e
 * chamado quando as fontes sem custo nao resolveram.
 *
 * O Node 20+ ja tem fetch nativo, entao nao precisamos instalar nada.
 */

import { categoriesFromProvider } from "./categories.js";

const TIMEOUT_MS = 8000;

// A Open Library pede para identificar a aplicacao com um User-Agent proprio;
// isso reduz a chance de bloqueio por excesso de requisicoes anonimas.
const USER_AGENT =
  "BibliotecaADMPBrasil/1.0 (uso interno, sem fins comerciais)";

async function fetchJson(url, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...extraHeaders,
      },
    });
    if (!response.ok) {
      console.error(
        "Resposta nao-OK ao buscar " + url + ": " + response.status,
      );
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error("Falha ao buscar " + url + ":", error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...extraHeaders },
    });
    if (!response.ok) {
      console.error(
        "Resposta nao-OK ao buscar " + url + ": " + response.status,
      );
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error("Falha ao buscar " + url + ":", error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Rede de seguranca para TODA fonte duvidosa/nao-oficial (Mercado Livre,
// DuckDuckGo Imagens, Amazon...): se algo inesperado estourar uma excecao
// no meio do caminho (formato de resposta mudou, campo que nao existe mais,
// etc.), a gente registra no log e devolve o valor de reserva em vez de
// derrubar o lookupIsbn inteiro. Uma fonte quebrando nunca deve quebrar as
// outras nem a busca como um todo.
async function safely(promise, fallback) {
  try {
    return await promise;
  } catch (error) {
    console.error(
      "Fonte de reforco falhou de forma inesperada (ignorando):",
      error && error.message,
    );
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// SerpAPI (https://serpapi.com): busca do Google via API. Precisa da chave
// SERP_API_KEY no .env; sem ela, todas as funcoes abaixo simplesmente devolvem
// vazio e o fluxo segue para as outras fontes.
//
// Nao usamos o fetchJson() aqui de proposito: ele escreve a URL inteira no log
// quando da erro, e a URL do SerpAPI carrega a api_key.
// ---------------------------------------------------------------------------
const SERPAPI_TIMEOUT_MS = 15000;

export function isSerpApiConfigured() {
  return Boolean(process.env.SERP_API_KEY);
}

async function serpApiSearch(params) {
  if (!isSerpApiConfigured()) return null;

  const url = new URL("https://serpapi.com/search.json");
  Object.entries({ hl: "pt-br", gl: "br", ...params }).forEach(([k, v]) =>
    url.searchParams.set(k, String(v)),
  );
  url.searchParams.set("api_key", process.env.SERP_API_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || (data && data.error)) {
      const reason = (data && data.error) || "HTTP " + response.status;
      // "Google hasn't returned any results" e resposta normal de busca vazia.
      if (!/hasn't returned any results/i.test(reason)) {
        console.error("SerpAPI (" + params.engine + ") recusou a busca:", reason);
      }
      return null;
    }
    return data;
  } catch (error) {
    console.error("SerpAPI (" + params.engine + ") falhou:", error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Titulo/autor "adivinhados" a partir de uma busca no Google por "isbn <n>".
// Prefere o painel de conhecimento (knowledge_graph) quando ele e de um livro;
// senao usa o titulo do primeiro resultado organico que pareca um livro.
async function metadataFromSerpApi(isbn) {
  const data = await serpApiSearch({
    engine: "google",
    q: "isbn " + isbn + " livro",
    num: 5,
  });
  if (!data) return null;

  const kg = data.knowledge_graph;
  const kgIsBook =
    kg && kg.title && /livro|book|romance|novel|fic[cç][aã]o/i.test(kg.type || "");

  let title = "";
  let authors = [];
  let synopsis = "";

  if (kgIsBook) {
    title = String(kg.title).trim();
    const rawAuthor = kg.author || kg.authors;
    if (Array.isArray(rawAuthor)) authors = rawAuthor.map(String);
    else if (typeof rawAuthor === "string" && rawAuthor.trim())
      authors = rawAuthor.split(/,| e | and /).map((a) => a.trim());
    synopsis = typeof kg.description === "string" ? kg.description : "";
  } else {
    const organic = Array.isArray(data.organic_results)
      ? data.organic_results
      : [];
    for (const item of organic) {
      title = guessTitleFromSearchResult(item && item.title);
      if (title) break;
    }
  }

  if (!title) return null;

  return {
    isbn,
    title,
    authors: authors.filter(Boolean),
    publisher: "",
    year: "",
    pages: null,
    cover: "",
    synopsis,
    categories: [],
    source: "Google via SerpAPI (dado aproximado, confirme antes de usar)",
  };
}

// Capa pelo Google Imagens. Capas de livro sao retratos (mais altas que
// largas), entao descartamos paisagens e imagens minusculas; entre as que
// sobram, prefere a cujo titulo da pagina mais se parece com o do livro.
async function coverFromSerpApi(isbn, title, authors) {
  const query = title
    ? "capa livro " + title + (authors && authors[0] ? " " + authors[0] : "")
    : "isbn " + isbn + " capa livro";

  const data = await serpApiSearch({
    engine: "google_images",
    q: query,
  });
  const results =
    data && Array.isArray(data.images_results) ? data.images_results : [];

  const portraits = results.filter(
    (item) =>
      item &&
      item.original &&
      /^https?:\/\//i.test(item.original) &&
      item.original_height > item.original_width &&
      item.original_width >= 200,
  );
  if (!portraits.length) return "";

  const titleWords = normalize(title)
    .split(" ")
    .filter((w) => w.length > 2);
  const scored = portraits.map((item) => {
    const haystack = normalize((item.title || "") + " " + (item.source || ""));
    const hits = titleWords.filter((w) => haystack.includes(w)).length;
    return { item, ratio: titleWords.length ? hits / titleWords.length : 0 };
  });

  // Sem titulo para comparar (so temos o ISBN), confia na ordem do Google.
  const best = titleWords.length
    ? scored.find((entry) => entry.ratio >= 0.5)
    : scored[0];
  return best ? best.item.original : "";
}

async function fromBrasilApi(isbn) {
  // A BrasilAPI tenta todos os provedores (cbl, mercado-editorial,
  // open-library, google-books) e devolve o primeiro que responder. Isso da
  // acesso ao acervo da CBL e da Mercado Editorial, que cobrem muito mais
  // titulos nacionais do que a Open Library e o Google Books sozinhos.
  const data = await fetchJson("https://brasilapi.com.br/api/isbn/v1/" + isbn);
  if (!data || !data.title) return null;

  return {
    isbn,
    title: data.subtitle ? data.title + ": " + data.subtitle : data.title || "",
    authors: data.authors || [],
    publisher: data.publisher || "",
    year: data.year ? String(data.year) : "",
    pages: data.page_count || null,
    cover: data.cover_url || "",
    synopsis: data.synopsis || "",
    categories: categoriesFromProvider(data.subjects),
    source: "BrasilAPI (" + (data.provider || "desconhecido") + ")",
  };
}

async function fromOpenLibrary(isbn) {
  // search.json e o endpoint atual recomendado pela Open Library (o antigo
  // /api/books?bibkeys=... e mais instavel e vem apresentando erro 404).
  const fields =
    "title,author_name,first_publish_year,publisher,number_of_pages_median,cover_i,key";
  const data = await fetchJson(
    "https://openlibrary.org/search.json?isbn=" + isbn + "&fields=" + fields,
  );
  const doc = data && Array.isArray(data.docs) ? data.docs[0] : null;
  if (!doc) return null;

  let synopsis = "";
  if (doc.key) {
    // A sinopse completa fica no registro da obra (work), nao no da edicao.
    const work = await fetchJson("https://openlibrary.org" + doc.key + ".json");
    const description = work && work.description;
    if (typeof description === "string") synopsis = description;
    else if (description && description.value) synopsis = description.value;
  }

  return {
    isbn,
    title: doc.title || "",
    authors: doc.author_name || [],
    publisher: (doc.publisher || [])[0] || "",
    year: doc.first_publish_year ? String(doc.first_publish_year) : "",
    pages: doc.number_of_pages_median || null,
    cover: doc.cover_i
      ? "https://covers.openlibrary.org/b/id/" + doc.cover_i + "-L.jpg"
      : "",
    synopsis,
    // Os "subject" da Open Library sao etiquetas soltas (dezenas, em varios
    // idiomas, sem ordem de importancia), entao nao viram categoria.
    categories: [],
    source: "Open Library",
  };
}

async function fromGoogleBooks(isbn) {
  const data = await fetchJson(
    "https://www.googleapis.com/books/v1/volumes?q=isbn:" + isbn,
  );
  const item = data && data.items && data.items[0];
  if (!item) return null;

  const info = item.volumeInfo || {};
  const images = info.imageLinks || {};
  const cover = (
    images.extraLarge ||
    images.large ||
    images.thumbnail ||
    ""
  ).replace("http://", "https://");

  return {
    isbn,
    title: info.title
      ? info.subtitle
        ? info.title + ": " + info.subtitle
        : info.title
      : "",
    authors: info.authors || [],
    publisher: info.publisher || "",
    year: info.publishedDate ? String(info.publishedDate).slice(0, 4) : "",
    pages: info.pageCount || null,
    cover,
    synopsis: info.description || "",
    categories: categoriesFromProvider(info.categories, { keepUnknown: false }),
    source: "Google Books",
  };
}

async function searchMercadoLivre(query) {
  // Aviso: esse endpoint publico vem sendo bloqueado (HTTP 403) para varios
  // IPs de servidor desde 2025; quando isso acontece, fetchJson devolve
  // null e a funcao chamadora simplesmente segue sem foto desta fonte.
  const data = await fetchJson(
    "https://api.mercadolibre.com/sites/MLB/search?q=" +
      encodeURIComponent(query) +
      "&limit=5",
  );
  return data && Array.isArray(data.results) ? data.results : [];
}

// Remove acentos/pontuacao para comparar titulos de forma mais tolerante
// ("Memórias Póstumas" ~= "memorias postumas").
function normalize(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function coverFromDuckDuckGo(title, authors) {
  if (!title) return "";
  const query =
    "capa livro " + title + (authors && authors[0] ? " " + authors[0] : "");
  const results = await duckDuckGoImageResults(query);
  if (!results.length) return "";

  // Mesma checagem de similaridade usada no Mercado Livre: so aceita se a
  // maioria das palavras do titulo do livro aparecer no titulo da imagem
  // encontrada, para reduzir a chance de trazer uma foto de outra coisa.
  const titleWords = normalize(title)
    .split(" ")
    .filter((w) => w.length > 2);
  const match = results.find((item) => {
    const itemTitle = normalize(item.title);
    const hits = titleWords.filter((w) => itemTitle.includes(w)).length;
    return titleWords.length > 0 && hits / titleWords.length >= 0.5;
  });

  const chosen = match || results[0];
  return chosen && (chosen.image || chosen.thumbnail)
    ? chosen.image || chosen.thumbnail
    : "";
}

// Reproduz o que a aba "Imagens" do DuckDuckGo faz, mas usando o endpoint
// interno que o proprio site usa (nao e uma API oficial nem documentada -
// e engenharia reversa, entao pode parar de funcionar sem aviso).
// Fluxo: 1) abre a pagina de busca normal so para pegar um token "vqd"
// que ela exige; 2) usa esse token para chamar o endpoint de imagens,
// que devolve JSON com os resultados. Usada tanto para achar capa por
// ISBN (com titulo+autor) quanto para a busca livre de capa (texto que a
// pessoa digitou ou colou de um link de busca do Google que nao trouxe
// imagem nenhuma dentro dele, so o texto pesquisado).
async function duckDuckGoImageResults(query) {
  if (!query) return [];

  const html = await fetchText(
    "https://duckduckgo.com/?q=" +
      encodeURIComponent(query) +
      "&iax=images&ia=images",
  );
  if (!html) return [];

  const vqdMatch = html.match(/vqd=['"]?([\d-]+)['"&]/);
  const vqd = vqdMatch && vqdMatch[1];
  if (!vqd) return [];

  const data = await fetchJson(
    "https://duckduckgo.com/i.js?l=br-pt&o=json&q=" +
      encodeURIComponent(query) +
      "&vqd=" +
      vqd +
      "&f=,,,&p=1",
    { Referer: "https://duckduckgo.com/" },
  );
  return data && Array.isArray(data.results) ? data.results : [];
}

// Versao para busca livre (a pessoa digitou um texto, ou colou um link de
// busca do Google Imagens que nao trouxe nenhuma imagem embutida - so o
// texto pesquisado, tipo "google.com/search?q=...&udm=2"). Sem titulo de
// livro pra comparar, nao da pra validar similaridade como no ISBN: so
// devolvemos os melhores resultados crus para a pessoa escolher na tela.
export async function searchCoverImages(query, limit = 8) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];

  let results = await safely(duckDuckGoImageResults(cleanQuery), []);

  // O DuckDuckGo costuma bloquear IP de servidor. Quando nao devolve nada,
  // o Google via SerpAPI (se configurado) assume a busca.
  if (!results.length) {
    const serp = await safely(
      serpApiSearch({ engine: "google_images", q: cleanQuery }),
      null,
    );
    results = ((serp && serp.images_results) || []).map((item) => ({
      title: item.title,
      image: item.original,
      thumbnail: item.thumbnail,
      url: item.link,
    }));
  }

  return results
    .filter((item) => item && (item.image || item.thumbnail))
    .slice(0, limit)
    .map((item) => ({
      title: item.title || "",
      image: item.image || item.thumbnail,
      thumbnail: item.thumbnail || item.image,
      source: item.url || "",
    }));
}

// Tira tags HTML e decodifica entidades basicas (&amp;, &#39; etc) de um
// pedaco de HTML, sem precisar de biblioteca externa.
function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Um resultado de busca costuma vir "Titulo do livro - Nome do Site" ou
// "Titulo do livro | Loja X". Corta esses sufixos de site/loja para sobrar
// so o que parece ser o titulo do livro.
function guessTitleFromSearchResult(rawTitle) {
  const cleaned = stripHtml(rawTitle);
  const cut = cleaned.split(/ [-|–] /)[0].trim();
  // Descarta resultados curtos demais ou que sao so numeros/codigo (ex: o
  // proprio ISBN repetido como "titulo", tipo "9788535914849 - Google
  // Books") - isso nao e um titulo de verdade, e um falso positivo.
  const looksLikeJustANumber = /^[\d\-\s]+$/.test(cut);
  if (cut.length < 3 || looksLikeJustANumber) return "";
  return cut;
}

async function metadataFromDuckDuckGo(isbn) {
  // Ultimo recurso, so chamado quando NENHUMA das fontes estruturadas
  // (BrasilAPI, Google Books, Open Library) achou o livro. Ao contrario
  // delas, aqui nao existe JSON com campos separados - e um resultado de
  // busca em HTML, entao so conseguimos "adivinhar" o titulo com alguma
  // seguranca. Autor/editora/ano nao sao tentados porque o risco de vir
  // errado e alto demais para um dado que fica salvo sem revisao humana.
  const html = await fetchText(
    "https://html.duckduckgo.com/html/?q=" +
      encodeURIComponent("isbn " + isbn + " livro"),
  );
  if (!html) return null;

  const linkMatch = html.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
  if (!linkMatch) return null;

  const title = guessTitleFromSearchResult(linkMatch[1]);
  if (!title) return null;

  return {
    isbn,
    title,
    authors: [],
    publisher: "",
    year: "",
    pages: null,
    cover: "",
    synopsis: "",
    categories: [],
    source: "DuckDuckGo (dado aproximado, confirme antes de usar)",
  };
}

async function coverFromOpenLibraryDirect(isbn) {
  // Endpoint OFICIAL da Open Library que serve capa direto pelo ISBN, sem
  // precisar de busca previa (search.json) nem de scraping. Com
  // "?default=false" ela devolve 404 quando nao tem capa, em vez do
  // placeholder generico cinza - entao um 200 aqui e confirmacao real de
  // que existe imagem, ao contrario do chute de URL da Amazon. Por ser
  // endpoint publico e documentado, nao costuma bloquear IP de datacenter
  // como o Mercado Livre e o DuckDuckGo fazem.
  const checkUrl =
    "https://covers.openlibrary.org/b/isbn/" + isbn + "-L.jpg?default=false";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(checkUrl, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return "";
    return "https://covers.openlibrary.org/b/isbn/" + isbn + "-L.jpg";
  } catch (error) {
    console.error("Falha ao checar capa na Open Library:", error.message);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function coverFromMercadoLivre(isbn, title, authors) {
  // 1a tentativa: buscar pelo proprio ISBN. Poucos vendedores colocam o
  // ISBN no titulo do anuncio, entao isso raramente acha algo - mas quando
  // acha, a checagem e forte (o ISBN aparece literalmente no titulo).
  const byIsbn = await searchMercadoLivre(isbn);
  const strictMatch = byIsbn.find((item) => (item.title || "").includes(isbn));
  if (strictMatch && strictMatch.thumbnail) {
    return strictMatch.thumbnail.replace("http://", "https://");
  }

  // 2a tentativa: buscar por titulo + primeiro autor, que e como os
  // anuncios de livro costumam ser escritos de verdade. Sem ISBN no meio,
  // nao da pra confirmar 100% que e a edicao certa, entao a checagem aqui e
  // mais fraca: so aceitamos se as palavras do titulo do livro aparecerem
  // no titulo do anuncio (evita pegar a capa de um produto totalmente
  // diferente, tipo um brinquedo ou eletronico).
  if (!title) return "";
  const query = authors && authors[0] ? title + " " + authors[0] : title;
  const byText = await searchMercadoLivre(query);
  if (!byText.length) return "";

  const titleWords = normalize(title)
    .split(" ")
    .filter((w) => w.length > 2);
  const looseMatch = byText.find((item) => {
    const itemTitle = normalize(item.title);
    const hits = titleWords.filter((w) => itemTitle.includes(w)).length;
    // Exige que a maior parte das palavras do titulo batam, para nao
    // aceitar qualquer coisa so porque veio como primeiro resultado.
    return titleWords.length > 0 && hits / titleWords.length >= 0.6;
  });

  return looseMatch && looseMatch.thumbnail
    ? looseMatch.thumbnail.replace("http://", "https://")
    : "";
}

function merge(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    isbn: primary.isbn,
    title: primary.title || secondary.title,
    authors: primary.authors?.length ? primary.authors : secondary.authors,
    publisher: primary.publisher || secondary.publisher,
    year: primary.year || secondary.year,
    pages: primary.pages || secondary.pages,
    cover: primary.cover || secondary.cover,
    synopsis: primary.synopsis || secondary.synopsis,
    categories: primary.categories?.length
      ? primary.categories
      : secondary.categories,
    source: [primary.source, secondary.source].filter(Boolean).join(" + "),
  };
}

export async function lookupIsbn(isbn) {
  // Busca nas tres ao mesmo tempo. Se alguma falhar (fora do ar, cota
  // esgotada, ISBN nao cadastrado naquela fonte), fetchJson devolve null e
  // seguimos so com as que responderam.
  const [brasilApi, google, openLibrary] = await Promise.all([
    safely(fromBrasilApi(isbn), null),
    safely(fromGoogleBooks(isbn), null),
    safely(fromOpenLibrary(isbn), null),
  ]);

  // Ordem de prioridade: BrasilAPI (melhor cobertura nacional) > Google
  // Books > Open Library. Cada merge so preenche o que a fonte anterior
  // deixou em branco, entao o resultado final soma o que cada uma tem.
  let result = merge(merge(brasilApi, google), openLibrary);

  // Categoria: a do Google Books segue um padrao de mercado (Religion,
  // Fiction...), enquanto a da CBL via BrasilAPI as vezes e generica ou
  // imprecisa. Quando as duas existem, vale a do Google.
  if (result && google && google.categories && google.categories.length) {
    result.categories = google.categories;
  }

  if (!result || !result.title) {
    // Nenhuma fonte estruturada achou o livro. Tenta adivinhar pelo menos o
    // titulo: primeiro pelo Google (SerpAPI, se houver chave) e, se tambem
    // nao achar, pelo DuckDuckGo. Em ambos o dado vem marcado como
    // aproximado no "source".
    let guess = await safely(metadataFromSerpApi(isbn), null);
    if (!guess) guess = await safely(metadataFromDuckDuckGo(isbn), null);
    result = merge(result, guess);
  }

  if (!result || !result.title) return null;

  // A partir daqui sao todas fontes de reforco. Cada uma passa pelo
  // safely(): se quebrar por qualquer motivo, vira "" e a gente so tenta a
  // proxima, sem propagar erro nenhum pra fora.
  // Ordem: Open Library direta primeiro (endpoint oficial, confirmado com
  // ?default=false, nao costuma bloquear IP de servidor) -> Google via
  // SerpAPI -> Mercado Livre -> DuckDuckGo -> Amazon (chute final, sem
  // nenhuma garantia).
  if (!result.cover) {
    result.cover = await safely(coverFromOpenLibraryDirect(isbn), "");
    if (result.cover) console.log("[capa] achou na Open Library:", isbn);
  }

  if (!result.cover) {
    result.cover = await safely(
      coverFromSerpApi(isbn, result.title, result.authors),
      "",
    );
    if (result.cover) console.log("[capa] achou no Google (SerpAPI):", isbn);
  }

  if (!result.cover) {
    result.cover = await safely(
      coverFromMercadoLivre(isbn, result.title, result.authors),
      "",
    );
    if (result.cover) console.log("[capa] achou no Mercado Livre:", isbn);
  }

  if (!result.cover) {
    result.cover = await safely(
      coverFromDuckDuckGo(result.title, result.authors),
      "",
    );
    if (result.cover) console.log("[capa] achou no DuckDuckGo:", isbn);
  }

  if (!result.cover) {
    console.log("[capa] caiu no chute da Amazon:", isbn);
    // A Amazon serve capas por ISBN sem precisar de chave/autenticacao, e
    // costuma ter capa ate de livro nacional que as outras fontes nao tem.
    // Nao e uma API oficial (e um padrao de URL de imagem, nao um endpoint
    // documentado), entao pode devolver uma imagem generica de "sem capa"
    // em vez de dar erro quando o ISBN nao existe la - por isso ela so
    // entra como ultimo recurso.
    result.cover =
      "https://images-na.ssl-images-amazon.com/images/P/" +
      isbn +
      ".01.LZZZZZZZ.jpg";
  }

  return result;
}
