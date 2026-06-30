/**
 * ====================================================
 * controllers/crmController.js
 * Full CRUD for: Leads, Follow-ups, Campaigns,
 *               Proposals, Templates, Contact Logins
 * Pattern: mirrors stockAdjustmentController.js exactly
 * ====================================================
 */

'use strict';
const transporter = require("../services/emailService");


const pool = require('../config/database');

// ─────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────
function fail(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─────────────────────────────────────────────────────────────
// LEADS
// ─────────────────────────────────────────────────────────────

const getLeads = async (req, res) => {
  try {
    const { search = '', stage = '', source = '', assigned = '' } = req.query;
    let query = 'SELECT * FROM crm_leads WHERE 1=1';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR mobile ILIKE $${params.length} OR email ILIKE $${params.length} OR company ILIKE $${params.length})`;
    }
    if (stage)    { params.push(stage);    query += ` AND stage = $${params.length}`; }
    if (source)   { params.push(source);   query += ` AND source = $${params.length}`; }
    if (assigned) { params.push(assigned); query += ` AND assigned = $${params.length}`; }

    query += ' ORDER BY created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json({ success: true, leads: rows });
  } catch (err) {
    console.error('getLeads:', err.message);
    fail(res, 500, 'Failed to fetch leads');
  }
};

const getLeadById = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_leads WHERE id = $1', [req.params.id]);
    if (!rows.length) return fail(res, 404, 'Lead not found');
    res.json({ success: true, lead: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to fetch lead');
  }
};

const createLead = async (req, res) => {
  try {
    const { name, company, mobile, email, source, stage = 'New', assigned, dob, notes } = req.body;
    if (!name || !mobile) return fail(res, 400, 'Name and mobile are required');

    // Generate next ID manually (L001, L002, …)
    const { rows: seq } = await pool.query(
      `SELECT 'L' || LPAD(COALESCE(MAX(CAST(SUBSTRING(id FROM 2) AS INTEGER)), 0) + 1, 3, '0') AS next_id FROM crm_leads`
    );
    const id = seq[0].next_id;

    const { rows } = await pool.query(
      `INSERT INTO crm_leads (id, name, company, mobile, email, source, stage, assigned, dob, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, name, company, mobile, email, source, stage, assigned, dob || null, notes]
    );
    res.status(201).json({ success: true, message: 'Lead created', lead: rows[0] });
  } catch (err) {
    console.error('createLead:', err.message);
    fail(res, 500, 'Failed to create lead');
  }
};

const updateLead = async (req, res) => {
  try {
    const { name, company, mobile, email, source, stage, assigned, dob, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_leads SET name=$1, company=$2, mobile=$3, email=$4, source=$5,
       stage=$6, assigned=$7, dob=$8, notes=$9
       WHERE id=$10 RETURNING *`,
      [name, company, mobile, email, source, stage, assigned, dob || null, notes, req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'Lead not found');
    res.json({ success: true, message: 'Lead updated', lead: rows[0] });
  } catch (err) {
    console.error('updateLead:', err.message);
    fail(res, 500, 'Failed to update lead');
  }
};

const deleteLead = async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM crm_leads WHERE id = $1', [req.params.id]);
    if (!rowCount) return fail(res, 404, 'Lead not found');
    res.json({ success: true, message: 'Lead deleted' });
  } catch (err) {
    fail(res, 500, 'Failed to delete lead');
  }
};

const convertLead = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE crm_leads SET converted=true, converted_date=CURRENT_DATE, stage='Proposal'
       WHERE id=$1 AND converted=false RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'Lead not found or already converted');
    res.json({ success: true, message: 'Lead converted to customer', lead: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to convert lead');
  }
};

// ─────────────────────────────────────────────────────────────
// FOLLOW UPS
// ─────────────────────────────────────────────────────────────

const getFollowups = async (req, res) => {
  try {
    const { search = '', status = '', type = '', assigned = '' } = req.query;
    let query = 'SELECT * FROM crm_followups WHERE 1=1';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (lead ILIKE $${params.length} OR title ILIKE $${params.length} OR assigned ILIKE $${params.length})`;
    }
    if (status)   { params.push(status);   query += ` AND status = $${params.length}`; }
    if (type)     { params.push(type);     query += ` AND type = $${params.length}`; }
    if (assigned) { params.push(assigned); query += ` AND assigned = $${params.length}`; }

    query += ' ORDER BY start_time DESC';

    const { rows } = await pool.query(query, params);
    // Normalize to camelCase shape expected by frontend
    const normalized = rows.map(r => ({
      id:       r.id,
      lead:     r.lead,
      title:    r.title,
      status:   r.status,
      type:     r.type,
      category: r.category,
      assigned: r.assigned,
      start:    r.start_time ? r.start_time.toISOString().slice(0, 16) : '',
      end:      r.end_time   ? r.end_time.toISOString().slice(0, 16)   : '',
      desc:     r.description,
    }));
    res.json({ success: true, followups: normalized });
  } catch (err) {
    console.error('getFollowups:', err.message);
    fail(res, 500, 'Failed to fetch follow ups');
  }
};

const createFollowup = async (req, res) => {
  try {
    const { lead, title, status = 'Scheduled', type = 'Call', category, assigned, start, end, desc } = req.body;
    if (!lead || !title) return fail(res, 400, 'Lead and title are required');
    const { rows } = await pool.query(
      `INSERT INTO crm_followups (lead, title, status, type, category, assigned, start_time, end_time, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [lead, title, status, type, category, assigned, start || null, end || null, desc]
    );
    res.status(201).json({ success: true, message: 'Follow up created', followup: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to create follow up');
  }
};

const updateFollowup = async (req, res) => {
  try {
    const { lead, title, status, type, category, assigned, start, end, desc } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_followups SET lead=$1, title=$2, status=$3, type=$4, category=$5,
       assigned=$6, start_time=$7, end_time=$8, description=$9
       WHERE id=$10 RETURNING *`,
      [lead, title, status, type, category, assigned, start || null, end || null, desc, req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'Follow up not found');
    res.json({ success: true, message: 'Follow up updated', followup: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to update follow up');
  }
};

const deleteFollowup = async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM crm_followups WHERE id = $1', [req.params.id]);
    if (!rowCount) return fail(res, 404, 'Follow up not found');
    res.json({ success: true, message: 'Follow up deleted' });
  } catch (err) {
    fail(res, 500, 'Failed to delete follow up');
  }
};

// ─────────────────────────────────────────────────────────────
// CAMPAIGNS
// ─────────────────────────────────────────────────────────────

const getCampaigns = async (req, res) => {
  try {
    const { search = '', type = '', status = '' } = req.query;
    let query = 'SELECT * FROM crm_campaigns WHERE 1=1';
    const params = [];
    if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR created_by ILIKE $${params.length})`; }
    if (type)   { params.push(type);   query += ` AND type = $${params.length}`; }
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    const normalized = rows.map(r => ({ ...r, by: r.created_by }));
    res.json({ success: true, campaigns: normalized });
  } catch (err) {
    fail(res, 500, 'Failed to fetch campaigns');
  }
};

const createCampaign = async (req, res) => {
  try {
    const { name, type = 'Email', status = 'Draft', by, recipients = 0 } = req.body;
    if (!name) return fail(res, 400, 'Campaign name is required');
    const { rows } = await pool.query(
      `INSERT INTO crm_campaigns (name, type, status, created_by, recipients)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, type, status, by, recipients]
    );
    res.status(201).json({ success: true, message: 'Campaign created', campaign: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to create campaign');
  }
};

// ─────────────────────────────────────────────────────────────
// PROPOSALS
// ─────────────────────────────────────────────────────────────

const getProposals = async (req, res) => {
  try {
    const { search = '', status = '', sent_by = '' } = req.query;
    let query = 'SELECT * FROM crm_proposals WHERE 1=1';
    const params = [];
    if (search)  { params.push(`%${search}%`); query += ` AND (lead ILIKE $${params.length} OR subject ILIKE $${params.length} OR sent_by ILIKE $${params.length})`; }
    if (status)  { params.push(status);  query += ` AND status = $${params.length}`; }
    if (sent_by) { params.push(sent_by); query += ` AND sent_by = $${params.length}`; }
    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    const normalized = rows.map(r => ({ ...r, sentBy: r.sent_by }));
    res.json({ success: true, proposals: normalized });
  } catch (err) {
    fail(res, 500, 'Failed to fetch proposals');
  }
};

const createProposal = async (req, res) => {
  try {
    const { lead, subject, sentBy, value = 0, status = 'Draft' } = req.body;
    if (!lead || !subject) return fail(res, 400, 'Lead and subject are required');
    const { rows } = await pool.query(
      `INSERT INTO crm_proposals (lead, subject, sent_by, value, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [lead, subject, sentBy, value, status]
    );
    res.status(201).json({ success: true, message: 'Proposal created', proposal: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to create proposal');
  }
};

const updateProposal = async (req, res) => {
  try {
    const { lead, subject, sentBy, value, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_proposals SET lead=$1, subject=$2, sent_by=$3, value=$4, status=$5
       WHERE id=$6 RETURNING *`,
      [lead, subject, sentBy, value, status, req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'Proposal not found');
    res.json({ success: true, message: 'Proposal updated', proposal: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to update proposal');
  }
};

const deleteProposal = async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM crm_proposals WHERE id = $1', [req.params.id]);
    if (!rowCount) return fail(res, 404, 'Proposal not found');
    res.json({ success: true, message: 'Proposal deleted' });
  } catch (err) {
    fail(res, 500, 'Failed to delete proposal');
  }
};

// ─────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────

const getTemplates = async (req, res) => {
  try {
    const { search = '' } = req.query;
    let query = 'SELECT * FROM crm_templates WHERE 1=1';
    const params = [];
    if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR subject ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    const normalized = rows.map(r => ({ ...r, lastUpdated: r.last_updated }));
    res.json({ success: true, templates: normalized });
  } catch (err) {
    fail(res, 500, 'Failed to fetch templates');
  }
};

const createTemplate = async (req, res) => {
  try {
    const { name, subject, description, status = 'Active' } = req.body;
    if (!name || !subject) return fail(res, 400, 'Name and subject are required');
    const { rows } = await pool.query(
      `INSERT INTO crm_templates (name, subject, description, status)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, subject, description, status]
    );
    res.status(201).json({ success: true, message: 'Template created', template: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to create template');
  }
};

const updateTemplate = async (req, res) => {
  try {
    const { name, subject, description, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_templates SET name=$1, subject=$2, description=$3, status=$4, last_updated=CURRENT_DATE
       WHERE id=$5 RETURNING *`,
      [name, subject, description, status, req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'Template not found');
    res.json({ success: true, message: 'Template updated', template: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to update template');
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM crm_templates WHERE id = $1', [req.params.id]);
    if (!rowCount) return fail(res, 404, 'Template not found');
    res.json({ success: true, message: 'Template deleted' });
  } catch (err) {
    fail(res, 500, 'Failed to delete template');
  }
};

// ─────────────────────────────────────────────────────────────
// CONTACT LOGINS
// ─────────────────────────────────────────────────────────────

const getContacts = async (req, res) => {
  try {
    const { search = '' } = req.query;
    let query = 'SELECT * FROM crm_contacts WHERE 1=1';
    const params = [];
    if (search) { params.push(`%${search}%`); query += ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    const normalized = rows.map(r => ({
      id: r.id, firstName: r.first_name, lastName: r.last_name,
      email: r.email, mobile: r.mobile, dept: r.dept, active: r.active,
    }));
    res.json({ success: true, contacts: normalized });
  } catch (err) {
    fail(res, 500, 'Failed to fetch contacts');
  }
};

const createContact = async (req, res) => {
  try {
    const { firstName, lastName, email, mobile, dept, active = true } = req.body;
    if (!firstName || !email) return fail(res, 400, 'First name and email are required');
    const { rows } = await pool.query(
      `INSERT INTO crm_contacts (first_name, last_name, email, mobile, dept, active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [firstName, lastName, email, mobile, dept, active]
    );
    res.status(201).json({ success: true, message: 'Contact created', contact: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to create contact');
  }
};

const updateContact = async (req, res) => {
  try {
    const { firstName, lastName, email, mobile, dept, active } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_contacts SET first_name=$1, last_name=$2, email=$3, mobile=$4, dept=$5, active=$6
       WHERE id=$7 RETURNING *`,
      [firstName, lastName, email, mobile, dept, active, req.params.id]
    );
    if (!rows.length) return fail(res, 404, 'Contact not found');
    res.json({ success: true, message: 'Contact updated', contact: rows[0] });
  } catch (err) {
    fail(res, 500, 'Failed to update contact');
  }
};

const deleteContact = async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM crm_contacts WHERE id = $1', [req.params.id]);
    if (!rowCount) return fail(res, 404, 'Contact not found');
    res.json({ success: true, message: 'Contact deleted' });
  } catch (err) {
    fail(res, 500, 'Failed to delete contact');
  }
};

// ─────────────────────────────────────────────────────────────
// DASHBOARD STATS
// ─────────────────────────────────────────────────────────────

const getDashboardStats = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [leads, followups, proposals] = await Promise.all([
      pool.query('SELECT stage, converted FROM crm_leads'),
      pool.query(`SELECT status, DATE(start_time) AS day FROM crm_followups`),
      pool.query('SELECT status, value FROM crm_proposals'),
    ]);

    const totalLeads     = leads.rows.length;
    const newLeads       = leads.rows.filter(r => r.stage === 'New').length;
    const conversions    = leads.rows.filter(r => r.converted).length;
    const pipelineValue  = proposals.rows.reduce((s, r) => s + Number(r.value || 0), 0);
    const todayFollowups = followups.rows.filter(r => r.day?.toISOString?.().slice(0, 10) === today || String(r.day) === today).length;
    const pendingProposals = proposals.rows.filter(r => r.status === 'Sent').length;

    res.json({
      success: true,
      stats: { totalLeads, newLeads, conversions, pipelineValue, todayFollowups, pendingProposals },
    });
  } catch (err) {
    console.error('getDashboardStats:', err.message);
    fail(res, 500, 'Failed to fetch CRM stats');
  }
};

module.exports = {
  // leads
  getLeads, getLeadById, createLead, updateLead, deleteLead, convertLead,
  // followups
  getFollowups, createFollowup, updateFollowup, deleteFollowup,
  // campaigns
  getCampaigns, createCampaign,
  // proposals
  getProposals, createProposal, updateProposal, deleteProposal,
  // templates
  getTemplates, createTemplate, updateTemplate, deleteTemplate,
  // contacts
  getContacts, createContact, updateContact, deleteContact,
  // dashboard
  getDashboardStats,
};