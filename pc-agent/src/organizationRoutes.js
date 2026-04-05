import express from 'express';
import { jwtAuth, requireAdmin } from './authMiddleware.js';
import { getCompanyProfileByOrgId, upsertCompanyProfile } from './companyDb.js';

export function createOrganizationRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '128kb' }));
  r.use(jwtAuth);

  r.get('/company', async (req, res) => {
    try {
      const company = await getCompanyProfileByOrgId(req.user.orgId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, company: company || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  r.put('/company', requireAdmin, async (req, res) => {
    const b = req.body || {};
    try {
      const patch = {};
      if (typeof b.name === 'string') patch.name = b.name;
      if (typeof b.description === 'string') patch.description = b.description;
      if (typeof b.mission === 'string') patch.mission = b.mission;
      if (typeof b.vision === 'string') patch.vision = b.vision;
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          error: 'Send at least one of: name, description, mission, vision',
        });
      }
      const company = await upsertCompanyProfile(req.user.orgId, patch);
      res.json({ ok: true, company });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  return r;
}
