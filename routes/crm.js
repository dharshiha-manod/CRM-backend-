const express = require('express');
const router = express.Router();

const authenticateToken = require('../middleware/auth');
const pool = require('../config/database');
const transporter = require('../services/emailService');

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED LEADS ROUTES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/leads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_leads ORDER BY created_at DESC');
    res.json({ success: true, leads: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_leads WHERE id=$1', [req.params.id]);
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/leads', async (req, res) => {
  try {
    const { name, mobile, email, company, contact, location, industry, source, stage, assigned, notes, value } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO crm_leads (name, mobile, email, company, contact, location, industry, source, stage, assigned, notes, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        name,
        mobile || null,
        email || null,
        company || null,
        contact || null,
        location || null,
        industry || null,
        source || 'Website',
        stage || 'New',
        assigned || null,
        notes || null,
        value || 0
      ]
    );
    res.json({ success: true, lead: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/leads/:id', async (req, res) => {
  try {
    const { name, mobile, email, company, contact, location, industry, source, stage, assigned, notes, value } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_leads SET name=$1, mobile=$2, email=$3, company=$4, contact=$5, location=$6, industry=$7,
       source=$8, stage=$9, assigned=$10, notes=$11, value=$12, updated_at=NOW() WHERE id=$13 RETURNING *`,
      [
        name,
        mobile || null,
        email || null,
        company || null,
        contact || null,
        location || null,
        industry || null,
        source || 'Website',
        stage || 'New',
        assigned || null,
        notes || null,
        value || 0,
        req.params.id
      ]
    );
    res.json({ success: true, lead: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_leads WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/leads/:id/convert', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE crm_leads SET converted=true, converted_date=CURRENT_DATE, stage='Proposal', updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json({ success: true, lead: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED FOLLOW-UPS ROUTES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/followups', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_followups ORDER BY created_at DESC');
    const data = rows.map(r => ({
      id: r.id,
      lead: r.lead || r.lead_name || '',
      title: r.title,
      status: r.status,
      type: r.type,
      category: r.category,
      assigned: r.assigned,
      start: r.start_time ? new Date(r.start_time).toISOString().slice(0, 16) : '',
      end: r.end_time ? new Date(r.end_time).toISOString().slice(0, 16) : '',
      desc: r.description || '',
    }));
    res.json({ success: true, followups: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/followups', async (req, res) => {
  try {
    const { lead, lead_name, title, status, type, category, assigned, start, start_time, end, end_time, desc, description } = req.body;
    const leadVal = lead || lead_name || null;
    const startVal = start || start_time || null;
    const endVal = end || end_time || null;
    const descVal = desc || description || null;

    const { rows } = await pool.query(
      `INSERT INTO crm_followups (lead_name, title, status, type, category, assigned, start_time, end_time, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [leadVal, title, status || 'Scheduled', type || 'Call', category || 'Sales', assigned || null, startVal, endVal, descVal]
    );
    res.json({ success: true, followup: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/followups/:id', async (req, res) => {
  try {
    const { lead, lead_name, title, status, type, category, assigned, start, start_time, end, end_time, desc, description } = req.body;
    const leadVal = lead || lead_name || null;
    const startVal = start || start_time || null;
    const endVal = end || end_time || null;
    const descVal = desc || description || null;

    const { rows } = await pool.query(
      `UPDATE crm_followups SET lead_name=$1, title=$2, status=$3, type=$4, category=$5,
       assigned=$6, start_time=$7, end_time=$8, description=$9, updated_at=NOW() WHERE id=$10 RETURNING *`,
      [leadVal, title, status, type, category, assigned || null, startVal, endVal, descVal, req.params.id]
    );
    res.json({ success: true, followup: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/followups/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_followups WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED CAMPAIGNS ROUTES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/campaigns', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_campaigns ORDER BY created_at DESC');
    res.json({ success: true, campaigns: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { name, type, status, createdBy, created_by, recipients, subject, body, cc } = req.body;
    const createdByVal = createdBy || created_by || null;

    const { rows } = await pool.query(
      `INSERT INTO crm_campaigns (name, type, status, created_by, recipients, subject, body, cc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, type || 'Email', status || 'Draft', createdByVal, recipients || 0, subject || null, body || null, cc || null]
    );
    res.json({ success: true, campaign: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/campaigns/:id', async (req, res) => {
  try {
    const { name, type, status, createdBy, created_by, recipients, subject, body, cc } = req.body;
    const createdByVal = createdBy || created_by || null;

    const { rows } = await pool.query(
      `UPDATE crm_campaigns SET name=$1, type=$2, status=$3, created_by=$4, recipients=$5, subject=$6, body=$7, cc=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [name, type || 'Email', status || 'Draft', createdByVal, recipients || 0, subject || null, body || null, cc || null, req.params.id]
    );
    res.json({ success: true, campaign: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/campaigns/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED PROPOSALS ROUTES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/proposals', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_proposals ORDER BY created_at DESC');
    res.json({ success: true, proposals: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/proposals', async (req, res) => {
  try {
    const { lead, lead_name, subject, sentBy, sent_by, value, status, dueDate, due_date, cc, bcc, body } = req.body;
    const leadVal = lead || lead_name || null;
    const sentByVal = sentBy || sent_by || null;
    const dueDateVal = dueDate || due_date || null;

    const { rows } = await pool.query(
      `INSERT INTO crm_proposals (lead_name, subject, sent_by, value, status, due_date, cc, bcc, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [leadVal, subject, sentByVal, value || 0, status || 'Draft', dueDateVal, cc || null, bcc || null, body || null]
    );
    res.json({ success: true, proposal: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/proposals/:id', async (req, res) => {
  try {
    const { lead, lead_name, subject, sentBy, sent_by, value, status, dueDate, due_date, cc, bcc, body } = req.body;
    const leadVal = lead || lead_name || null;
    const sentByVal = sentBy || sent_by || null;
    const dueDateVal = dueDate || due_date || null;

    const { rows } = await pool.query(
      `UPDATE crm_proposals SET lead_name=$1, subject=$2, sent_by=$3, value=$4, status=$5, due_date=$6, cc=$7, bcc=$8, body=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [leadVal, subject, sentByVal, value || 0, status, dueDateVal, cc || null, bcc || null, body || null, req.params.id]
    );
    res.json({ success: true, proposal: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEND PROPOSAL — emails the proposal to the lead's saved email and marks it Sent
router.post('/proposals/:id/send', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_proposals WHERE id=$1', [req.params.id]);
    const proposal = rows[0];
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const leadResult = await pool.query(
      'SELECT email FROM crm_leads WHERE name=$1 LIMIT 1',
      [proposal.lead_name]
    );
    const toEmail = leadResult.rows[0]?.email;
    if (!toEmail) {
      return res.status(400).json({ error: "This lead has no email address saved. Add one before sending." });
    }

    await transporter.sendMail({
      from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      cc: proposal.cc || undefined,
      bcc: proposal.bcc || undefined,
      subject: proposal.subject,
      html: proposal.body,
    });

    const { rows: updated } = await pool.query(
      `UPDATE crm_proposals SET status='Sent', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );

    res.json({ success: true, proposal: updated[0] });
  } catch (err) {
    console.error('sendProposal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/proposals/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_proposals WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED CONTACTS ROUTES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/contacts', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_contacts ORDER BY created_at DESC');
    res.json({ success: true, contacts: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/contacts', async (req, res) => {
  try {
    const { firstName, first_name, lastName, last_name, email, mobile, department, designation,
             linkedLead, linked_lead, active, is_active, phone, altPhone, alt_phone,
             lifeStage, life_stage, salesCommission, sales_commission } = req.body;

    const firstNameVal = firstName || first_name || null;
    const lastNameVal = lastName || last_name || null;
    const linkedLeadVal = linkedLead || linked_lead || null;
    const lifeStageVal = lifeStage || life_stage || null;
    const activeVal = active !== undefined ? active : (is_active !== undefined ? is_active : true);

    const { rows } = await pool.query(
      `INSERT INTO crm_contacts (first_name, last_name, email, mobile, department, designation, linked_lead,
                                  is_active, phone, alt_phone, life_stage, sales_commission)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [firstNameVal, lastNameVal, email, mobile || null, department || null, designation || null,
       linkedLeadVal, activeVal, phone || null, altPhone || alt_phone || null,
       lifeStageVal || null, salesCommission || sales_commission || null]
    );
    res.json({ success: true, contact: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/contacts/:id', async (req, res) => {
  try {
    const { firstName, first_name, lastName, last_name, email, mobile, department, designation,
             linkedLead, linked_lead, active, is_active, phone, altPhone, alt_phone,
             lifeStage, life_stage, salesCommission, sales_commission } = req.body;

    const firstNameVal = firstName || first_name || null;
    const lastNameVal = lastName || last_name || null;
    const linkedLeadVal = linkedLead || linked_lead || null;
    const lifeStageVal = lifeStage || life_stage || null;
    const activeVal = active !== undefined ? active : (is_active !== undefined ? is_active : true);

    const { rows } = await pool.query(
      `UPDATE crm_contacts SET first_name=$1, last_name=$2, email=$3, mobile=$4, department=$5,
                               designation=$6, linked_lead=$7, is_active=$8, phone=$9, alt_phone=$10,
                               life_stage=$11, sales_commission=$12, updated_at=NOW() WHERE id=$13 RETURNING *`,
      [firstNameVal, lastNameVal, email, mobile || null, department || null, designation || null,
       linkedLeadVal, activeVal, phone || null, altPhone || alt_phone || null,
       lifeStageVal || null, salesCommission || sales_commission || null, req.params.id]
    );
    res.json({ success: true, contact: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_contacts WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES ROUTES (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/templates', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_templates ORDER BY updated_at DESC');
    res.json({ success: true, templates: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/templates', async (req, res) => {
  try {
    const { name, subject, description, status } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO crm_templates (name, subject, description, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, subject, description || null, status || 'Active']
    );
    res.json({ success: true, template: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const { name, subject, description, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_templates SET name=$1, subject=$2, description=$3, status=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, subject, description || null, status, req.params.id]
    );
    res.json({ success: true, template: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_templates WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD STATS ROUTE
// ═══════════════════════════════════════════════════════════════════════════
router.get('/dashboard/stats', async (req, res) => {
  try {
    const [leads, followups, proposals] = await Promise.all([
      pool.query('SELECT stage, converted FROM crm_leads'),
      pool.query('SELECT status FROM crm_followups'),
      pool.query('SELECT status, value FROM crm_proposals'),
    ]);
    res.json({ success: true, leads: leads.rows, followups: followups.rows, proposals: proposals.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;