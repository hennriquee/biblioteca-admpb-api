import { Router } from 'express';
import Person from '../models/Person.js';
import Loan from '../models/Loan.js';
import { normalizeText } from '../models/Book.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/people?search=texto -> usado para sugerir nomes enquanto digita
router.get('/', async (req, res, next) => {
  try {
    const search = normalizeText(req.query.search || '');
    const filter = {};

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.nameSort = regex;
    }

    const people = await Person.find(filter).sort({ nameSort: 1 }).limit(10).lean();

    const activeLoans = await Loan.find({
      status: 'ativo',
      person: { $in: people.map((p) => p._id) },
    })
      .select('person bookTitle')
      .lean();

    const loansByPerson = new Map();
    activeLoans.forEach((loan) => {
      const key = String(loan.person);
      loansByPerson.set(key, [...(loansByPerson.get(key) || []), loan.bookTitle]);
    });

    return res.json(
      people.map((person) => ({
        ...person,
        activeLoans: loansByPerson.get(String(person._id)) || [],
      }))
    );
  } catch (error) {
    return next(error);
  }
});

// GET /api/people/check?name=Nome Completo
// Diz se a pessoa ja existe e se ja esta com algum livro.
router.get('/check', async (req, res, next) => {
  try {
    const nameSort = normalizeText(req.query.name || '');
    if (!nameSort) return res.json({ exists: false, activeLoans: [] });

    const person = await Person.findOne({ nameSort });
    if (!person) return res.json({ exists: false, activeLoans: [] });

    const loans = await Loan.find({ person: person._id, status: 'ativo' })
      .select('bookTitle startDate dueDate')
      .lean();

    return res.json({ exists: true, person, activeLoans: loans });
  } catch (error) {
    return next(error);
  }
});

export default router;
