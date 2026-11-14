import Person from '../../models/Person.js';
import { notifyNewMessage } from '../adminPush.js';
import { previewOf } from './content.js';
import { noteActivity } from './floor.js';
import { phoneVariants } from './phone.js';
import { noteRequestLink } from './requestLink.js';

/**
 * O que o servidor faz quando CHEGA uma mensagem no WhatsApp da biblioteca,
 * agora que nao ha mais atendimento automatico (o robo de services/whatsapp/
 * bot.js esta desligado e comentado). Nada aqui responde a pessoa:
 *
 * - mensagem com o link de uma solicitacao: anota de qual conversa ela veio
 *   (requestLink.js);
 * - avisa, pela notificacao do app, os administradores que escolheram
 *   "Mensagens no WhatsApp" (services/adminPush.js). Quem responde e um
 *   administrador, pelo painel (Conversas);
 * - UMA CONVERSA POR VEZ (floor.js): a pessoa respondendo mantem a conversa
 *   dela em andamento; mensagem escrita pelo CELULAR da biblioteca passa a
 *   vez para aquela conversa (o celular e o mesmo numero).
 */
export function createInboxWatch({ whatsapp }) {
  let stop = null;

  async function onIncoming(event) {
    const { chat } = event;
    if (!chat?._id) return;
    await noteRequestLink(event).catch((error) => {
      console.error('WhatsApp: não foi possível anotar a conversa da solicitação:', error.message);
    });
    // O nome que o painel mostra: o do cadastro (pelo telefone), senao o do
    // perfil do WhatsApp, senao o numero.
    let who = chat.pushName || '';
    const variants = phoneVariants(chat.phone);
    if (variants.length) {
      const person = await Person.findOne({ phone: { $in: variants } })
        .sort({ code: 1 })
        .select('fullName')
        .lean()
        .catch(() => null);
      if (person?.fullName) who = person.fullName;
    }
    if (!who) who = chat.phone ? '+' + chat.phone : 'Número oculto';
    notifyNewMessage({ chat, who, preview: previewOf(event.kind, event.text) });
  }

  return {
    start() {
      if (stop) return;
      stop = whatsapp.onEvent((event) => {
        if (event?.type === 'phone-out' && event.chat?._id) {
          return noteActivity({
            chatId: event.chat._id,
            at: event.message?.at,
            byName: 'Celular da biblioteca',
            force: true,
          }).catch((error) => {
            console.error('WhatsApp: não foi possível anotar a conversa do celular:', error.message);
          });
        }
        if (event?.type !== 'incoming') return undefined;
        if (event.chat?._id) {
          noteActivity({ chatId: event.chat._id, at: event.message?.at }).catch(() => {});
        }
        return onIncoming(event).catch((error) => {
          console.error('WhatsApp: falha ao tratar uma mensagem recebida:', error.message);
        });
      });
    },
    stop() {
      stop?.();
      stop = null;
    },
  };
}
