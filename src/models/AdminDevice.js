import mongoose from 'mongoose';

/**
 * APARELHO DE UM ADMINISTRADOR que recebe as notificacoes do app da
 * biblioteca (Configurações > Notificações). E a inscricao do Web Push do
 * navegador daquele aparelho (o mesmo padrao do "Avise-me quando voltar" do
 * acervo: ver services/returnAlerts.js), ligada a ficha do administrador.
 *
 * O QUE cada administrador quer receber fica na ficha dele (Person.notify);
 * aqui so ficam os aparelhos. Um aparelho e de UMA conta por vez: outro
 * administrador ativando no mesmo navegador passa o aparelho para ele.
 * Quem perde o acesso ao painel deixa de receber na hora (o envio confere o
 * login), e o aparelho sai daqui quando o servico do fabricante diz que a
 * inscricao nao existe mais.
 */
const adminDeviceSchema = new mongoose.Schema(
  {
    person: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    // "Edge no Windows", "Chrome no Android"... so para a tela mostrar.
    label: { type: String, default: '' },
    // Envios seguidos que falharam (servico fora do ar): passou do teto, sai.
    failures: { type: Number, default: 0 },
    lastOkAt: { type: Date, default: null },
  },
  { collection: 'admin_devices', timestamps: true }
);

export default mongoose.model('AdminDevice', adminDeviceSchema);
