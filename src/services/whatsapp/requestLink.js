import LoanRequest from '../../models/LoanRequest.js';
import { whatsapp as defaultWhatsapp } from './service.js';
import { digitsOf } from './phone.js';

/**
 * O LINK DA SOLICITACAO na conversa do WhatsApp, SEM robo.
 *
 * Desde 12/11/2026 o atendimento automatico (services/whatsapp/bot.js) esta
 * desligado e comentado: o numero da biblioteca nao responde nada sozinho. O
 * que sobrou dele e o que nao manda mensagem nenhuma:
 * - REQUEST_LINK: acha o link /solicitacao/<id> no texto (o botao "Aprovar
 *   solicitação" da conversa, em routes/whatsapp.js);
 * - requestChannel: para qual WhatsApp a tela do acervo manda a mensagem
 *   pronta do "Combinar";
 * - noteRequestLink: a mensagem com o link chegou numa conversa - so ANOTA na
 *   solicitacao de qual conversa/numero ela veio (o "Registrar solicitação"
 *   confere com a ficha, e o sininho oferece "Abrir conversa"). Nao responde.
 */

// O link do fim da mensagem: /solicitacao/<id> (o id e o mesmo formato de
// TOKEN_PATTERN em routes/requests.js).
export const REQUEST_LINK = /\/solicitacao\/([A-Za-z0-9_-]{16,64})(?![A-Za-z0-9_-])/;

// O WhatsApp BRASILEIRO da biblioteca: para onde ia o "Combinar" do acervo
// publico antes do numero conectado ao painel (reserva: ver requestChannel).
export const LEGACY_REQUESTS_WHATSAPP = '5534984241556';

// Reconectando ha mais que isto, o "Combinar" vai para o brasileiro: a
// mensagem para o numero do painel ficaria horas sem ninguem ver.
const RECONNECT_GRACE_MS = 15 * 60 * 1000;

// O WhatsApp do painel recebe agora (ou vai receber em instantes)?
// - aberto, ou outra copia do servidor com a conexao (standby, no deploy);
// - conectando/reconectando COM sessao salva e fora do ar ha pouco tempo
//   (servidor acordando, queda rapida). Sem sessao, conectando e o QR.
function receivingSoon(status, now) {
  // (sleeping: conexao sob demanda fechada de proposito, com a sessao salva -
  // o WhatsApp guarda a mensagem e entrega quando o painel abrir)
  if (status.state === 'open' || status.state === 'standby' || status.state === 'sleeping') return true;
  if (status.state !== 'connecting' && status.state !== 'reconnecting') return false;
  if (!status.hasSession) return false;
  const down = status.downSince ? Date.parse(status.downSince) : NaN;
  return Number.isFinite(down) && now - down < RECONNECT_GRACE_MS;
}

/**
 * Para qual WhatsApp vai o "Combinar" do acervo publico:
 * - o numero da biblioteca conectado ao painel (padrao): a mensagem cai em
 *   Conversas, e quem responde e um administrador, de dentro do painel;
 * - o BRASILEIRO (LIBRARY_WHATSAPP_BR, modelo antigo, de reserva) quando o
 *   numero do painel nao esta conectado ou com REQUESTS_WHATSAPP=brasil.
 * Devolve { number, via: "robo" | "brasil" }. ("robo" ficou como nome do
 * numero do painel: a tela do acervo ja instalada nos celulares le esse nome.)
 */
export function requestChannel({ env = process.env, whatsapp = defaultWhatsapp, now = Date.now() } = {}) {
  const legacy = digitsOf(env.LIBRARY_WHATSAPP_BR || LEGACY_REQUESTS_WHATSAPP);
  const mode = String(env.REQUESTS_WHATSAPP || 'robo').trim().toLowerCase();
  if (mode === 'brasil') return { number: legacy, via: 'brasil' };
  const status = whatsapp.snapshot();
  const ready = status.enabled && !status.broken && receivingSoon(status, now);
  const number = digitsOf(whatsapp.config?.number || status.number);
  return ready && number ? { number, via: 'robo' } : { number: legacy, via: 'brasil' };
}

/**
 * Mensagem recebida com o link de uma solicitacao: anota a conversa e o
 * numero na solicitacao ainda pendente. O link fica com a PRIMEIRA conversa
 * que o mandou (encaminhado para outra pessoa nao "toma" o link). Nada e
 * enviado de volta.
 */
export async function noteRequestLink({ chat, text }) {
  const match = String(text || '').slice(0, 3000).match(REQUEST_LINK);
  if (!match || !chat?._id) return false;
  const updated = await LoanRequest.updateOne(
    { token: match[1], status: 'pendente', waChat: null },
    { $set: { waChat: chat._id, waPhone: chat.phone || '' } }
  );
  return updated.modifiedCount > 0;
}
