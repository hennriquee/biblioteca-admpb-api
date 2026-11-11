import mongoose from 'mongoose';

/**
 * Sessao do WhatsApp da biblioteca (ver services/whatsapp/authState.js).
 *
 * Cada documento e UMA peca da sessao do Baileys: as credenciais ("creds") ou
 * uma chave de criptografia ("session:...", "pre-key:...", etc.). O valor fica
 * CIFRADO (AES-256-GCM): a sessao vale como uma chave da conta do WhatsApp, e
 * quem lesse o banco sem a chave nao consegue usa-la.
 *
 * Ficam no banco, e nao em arquivo, porque o disco do Render e apagado a cada
 * deploy - e o QR code so deve ser lido uma vez.
 */
const waAuthSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    value: { type: String, required: true },
  },
  { collection: 'wa_auth', versionKey: false }
);

export default mongoose.model('WaAuth', waAuthSchema);
