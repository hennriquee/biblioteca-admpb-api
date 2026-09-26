import mongoose from 'mongoose';
import { normalizeText } from './Book.js';

const personSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    nameSort: { type: String, index: true },
    phone: { type: String, default: '' },
    loansCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

personSchema.pre('save', function setNameSort(next) {
  this.nameSort = normalizeText(this.fullName);
  next();
});

export default mongoose.model('Person', personSchema);
