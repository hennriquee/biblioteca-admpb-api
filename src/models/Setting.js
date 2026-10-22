import mongoose from 'mongoose';

/**
 * Configuracoes que o proprio servidor cria e guarda, uma por documento
 * (_id = nome da configuracao). Hoje existe uma: "webpush", o par de chaves
 * que assina as notificacoes do "Avise-me quando voltar" (ver
 * services/returnAlerts.js).
 *
 * Fica no banco, e nao so na memoria, porque as chaves precisam ser as MESMAS
 * a cada reinicio do servidor: com chaves novas, todo aparelho que ja pediu
 * aviso deixaria de receber.
 */
const settingSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('Setting', settingSchema);
