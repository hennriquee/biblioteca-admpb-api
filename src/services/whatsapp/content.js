import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';

/**
 * O que mostrar de uma mensagem do WhatsApp. Tudo que chega de fora e dado nao
 * confiavel: aqui sai so TEXTO (limitado), nunca HTML nem endereco para abrir.
 */

export const MAX_TEXT = 8000;

// Mensagens que nao sao conversa (reacao, aviso interno do WhatsApp...).
const SKIPPED = new Set([
  'reactionMessage',
  'encReactionMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'requestPhoneNumberMessage',
]);

const KIND_BY_TYPE = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
};

function clip(text) {
  const value = String(text || '');
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '…' : value;
}

/**
 * @returns {{ skip: boolean, kind?: string, text?: string, revokeId?: string,
 *            edit?: { id: string, text: string } }}
 */
export function describeMessage(message) {
  const content = normalizeMessageContent(message?.message);
  if (!content) return { skip: true };
  const type = getContentType(content);
  if (!type || SKIPPED.has(type)) return { skip: true };

  if (type === 'protocolMessage') {
    const protocol = content.protocolMessage || {};
    // 0 = apagada para todos; 14 = editada.
    if (protocol.type === 0 && protocol.key?.id) {
      return { skip: true, revokeId: protocol.key.id };
    }
    if (protocol.type === 14 && protocol.key?.id) {
      const edited = describeMessage({ message: protocol.editedMessage });
      if (!edited.skip) {
        return { skip: true, edit: { id: protocol.key.id, text: edited.text || '' } };
      }
    }
    return { skip: true };
  }

  if (type === 'conversation') {
    return { skip: false, kind: 'text', text: clip(content.conversation) };
  }
  if (type === 'extendedTextMessage') {
    return { skip: false, kind: 'text', text: clip(content.extendedTextMessage?.text) };
  }

  const kind = KIND_BY_TYPE[type] || 'other';
  const body = content[type] || {};
  let text = '';
  if (kind === 'image' || kind === 'video') text = body.caption || '';
  else if (kind === 'document') {
    text = body.caption || body.fileName || body.message?.documentMessage?.fileName || '';
  } else if (kind === 'poll') text = body.name || '';
  else if (type === 'buttonsResponseMessage') text = body.selectedDisplayText || '';
  else if (type === 'listResponseMessage') text = body.title || '';
  else if (type === 'templateButtonReplyMessage') text = body.selectedDisplayText || '';
  return { skip: false, kind: KIND_BY_TYPE[type] ? kind : text ? 'text' : 'other', text: clip(text) };
}

/** Texto curto para a lista de conversas. */
export const KIND_LABELS = {
  image: 'Foto',
  video: 'Vídeo',
  audio: 'Áudio',
  document: 'Documento',
  sticker: 'Figurinha',
  location: 'Localização',
  contact: 'Contato',
  poll: 'Enquete',
  other: 'Mensagem sem texto',
};

export function previewOf(kind, text) {
  const label = KIND_LABELS[kind];
  if (!label) return String(text || '').slice(0, 140);
  return text ? label + ': ' + String(text).slice(0, 120) : label;
}
