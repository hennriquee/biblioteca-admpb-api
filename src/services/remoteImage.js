/**
 * Baixa uma imagem de um endereco da internet e devolve como data URI.
 *
 * Para que serve: muitas capas de livro sao LINKS de outros sites (Open
 * Library, Google, Mercado Livre...), e o navegador nao deixa o app ler os
 * pontos de uma imagem de outro site (CORS) - sem ler, nao ha como recortar,
 * ampliar ou girar a capa que ja esta no livro. O servidor nao tem essa
 * trava: ele baixa a imagem e entrega ao app como se fosse dele.
 *
 * Como o endereco vem de fora, o servidor NAO pode ser usado para espiar a
 * rede interna (SSRF). Por isso:
 *
 * - so http e https, nas portas padrao, sem usuario/senha no endereco;
 * - o endereco IP onde a conexao realmente vai parar e conferido no momento
 *   da conexao (safeLookup), e nao so antes - isso fecha a brecha de um nome
 *   que aponta para um IP publico na conferencia e para um interno depois;
 * - IPs internos, de loopback, de rede privada e reservados sao recusados;
 * - cada redirecionamento (no maximo 3) passa pela mesma conferencia;
 * - so volta o que e imagem DE VERDADE (conferido pelos primeiros bytes, nao
 *   pelo que o outro site diz) e ate 4 MB.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 15000;
const USER_AGENT = "BibliotecaADMPBrasil/1.0 (uso interno, sem fins comerciais)";

// Enderecos que um servidor publico de imagens nunca teria.
const BLOCKED = new net.BlockList();
[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].forEach(([address, prefix]) => BLOCKED.addSubnet(address, prefix, "ipv4"));
[
  // "::" ate "::ffff:ffff" (inclui o loopback ::1 e o IPv4 "compativel").
  ["::", 96],
  // IPv4 "traduzido" (::ffff:0:a.b.c.d) e os blocos de traducao NAT64.
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  // "Site-local" antigo, ja aposentado.
  ["fec0::", 10],
  ["ff00::", 8],
].forEach(([address, prefix]) => BLOCKED.addSubnet(address, prefix, "ipv6"));

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const FORBIDDEN = () =>
  fail(400, "Esse endereço de imagem não pode ser usado.");
const tooBig = () => fail(413, "A imagem é grande demais (máximo de 4 MB).");

function isBlockedAddress(address) {
  const family = net.isIPv6(address) ? "ipv6" : "ipv4";
  // O BlockList entende o IPv4 "embrulhado" em IPv6 (::ffff:127.0.0.1).
  return BLOCKED.check(address, family);
}

// Usada pelo http/https NO MOMENTO de conectar: so deixa passar se TODOS os
// enderecos do nome forem publicos.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (
      !addresses.length ||
      addresses.some((entry) => isBlockedAddress(entry.address))
    ) {
      return callback(FORBIDDEN());
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function parseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw fail(400, "O endereço da imagem não é válido.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fail(400, "O endereço da imagem precisa começar com http ou https.");
  }
  if (url.username || url.password) throw FORBIDDEN();
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== defaultPort) throw FORBIDDEN();

  // Endereco escrito direto como IP nao passa pelo lookup: confere aqui.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host)) throw FORBIDDEN();
  return url;
}

// Um pedido so, sem seguir redirecionamento.
function requestOnce(url, signal) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(
      url,
      {
        lookup: safeLookup,
        signal,
        headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          response.resume();
          // 3xx sem "Location" (ex.: 304) nao leva a lugar nenhum.
          if (!response.headers.location) {
            return reject(fail(502, "O site da imagem não a entregou."));
          }
          return resolve({ status, location: response.headers.location });
        }
        if (status < 200 || status >= 300) {
          response.resume();
          return reject(fail(502, "O site da imagem não a entregou."));
        }

        const declared = Number(response.headers["content-length"]);
        if (declared > MAX_BYTES) {
          response.destroy();
          return reject(tooBig());
        }

        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            response.destroy();
            return reject(tooBig());
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ status, body: Buffer.concat(chunks) }),
        );
        response.on("error", reject);
        // Conexao cortada no meio: "end" nao vem, "close" vem sem terminar.
        response.on("close", () => {
          if (!response.complete) {
            reject(fail(502, "O download da imagem foi interrompido."));
          }
        });
      },
    );
    request.on("error", reject);
  });
}

// Descobre o tipo olhando os primeiros bytes - o cabecalho "Content-Type" do
// outro site pode mentir.
function sniffImageType(buffer) {
  const ascii = (from, to) => buffer.toString("latin1", from, to);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer.length >= 8 && ascii(1, 4) === "PNG" && buffer[0] === 0x89) {
    return "image/png";
  }
  if (buffer.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 6 && ascii(0, 3) === "GIF") return "image/gif";
  if (
    buffer.length >= 12 &&
    ascii(4, 8) === "ftyp" &&
    (ascii(8, 12) === "avif" || ascii(8, 12) === "avis")
  ) {
    return "image/avif";
  }
  return null;
}

export async function fetchRemoteImage(rawUrl) {
  let url = parseUrl(rawUrl);
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let result;
    try {
      result = await requestOnce(url, signal);
    } catch (error) {
      if (error.status) throw error;
      console.error(
        "Falha ao baixar imagem de " + url.hostname + ":",
        error.code || error.message,
      );
      throw fail(502, "Não foi possível baixar a imagem desse endereço.");
    }

    if (result.location) {
      try {
        url = parseUrl(new URL(result.location, url).href);
      } catch (error) {
        throw error.status ? error : FORBIDDEN();
      }
      continue;
    }

    const type = sniffImageType(result.body);
    if (!type) {
      throw fail(400, "Esse endereço não leva a uma imagem.");
    }
    return "data:" + type + ";base64," + result.body.toString("base64");
  }

  throw fail(502, "O endereço da imagem leva a voltas demais.");
}
