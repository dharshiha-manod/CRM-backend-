const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const authenticateToken = require('../middleware/auth');
const pool = require('../config/database');
const transporter = require('../services/emailService');

let twilioFactory = null;
try {
  twilioFactory = require('twilio');
} catch (err) {
  twilioFactory = null;
}

const normalizeCallPhone = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return '+' + raw.slice(1).replace(/\D/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return '';
};

const escapeTwiml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const ensureLeadExtraColumns = async () => {
  try {
    await pool.query(`
      ALTER TABLE crm_leads
      ADD COLUMN IF NOT EXISTS contact_type TEXT,
      ADD COLUMN IF NOT EXISTS entity_type TEXT,
      ADD COLUMN IF NOT EXISTS tax_number TEXT,
      ADD COLUMN IF NOT EXISTS address1 TEXT,
      ADD COLUMN IF NOT EXISTS address2 TEXT,
      ADD COLUMN IF NOT EXISTS city TEXT,
      ADD COLUMN IF NOT EXISTS state TEXT,
      ADD COLUMN IF NOT EXISTS country TEXT,
      ADD COLUMN IF NOT EXISTS zip_code TEXT,
      ADD COLUMN IF NOT EXISTS landmark TEXT,
      ADD COLUMN IF NOT EXISTS street_name TEXT,
      ADD COLUMN IF NOT EXISTS building_number TEXT,
      ADD COLUMN IF NOT EXISTS additional_number TEXT,
      ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS contact_persons JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS lead_details JSONB DEFAULT '{}'::jsonb
    `);
  } catch (err) {
    console.error('lead extra column setup failed:', err.message);
  }
};
ensureLeadExtraColumns();

const jsonValue = (value, fallback) => JSON.stringify(value ?? fallback);
const ensureProposalAutomationColumns = async () => {
  await pool.query(`
    ALTER TABLE crm_proposals
      ADD COLUMN IF NOT EXISTS public_token TEXT,
      ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS followup_1_sent_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS call_task_created_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS final_reminder_sent_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS responded_at TIMESTAMP
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS crm_proposals_public_token_idx
    ON crm_proposals (public_token)
    WHERE public_token IS NOT NULL
  `);
};
ensureProposalAutomationColumns().catch((err) => console.error('proposal automation column setup failed:', err.message));
const CUSTOMER_SUCCESS_STAGES = [
  'Order Confirmed',
  'Invoice Generated',
  'Project Assigned',
  'Document Collection',
  'Implementation Started',
  'Training Scheduled',
  'Go Live',
  'Support',
  'Feedback Collected',
  'Upsell Opportunity',
  'AMC / Renewal Reminder',
];

const CUSTOMER_SUCCESS_PLAN = [
  { stage: 'Order Confirmed', days: 0, title: 'Confirm customer order', type: 'Call', category: 'Admin' },
  { stage: 'Invoice Generated', days: 1, title: 'Generate and send invoice', type: 'Email', category: 'Admin' },
  { stage: 'Project Assigned', days: 2, title: 'Assign project owner', type: 'Meeting', category: 'Admin' },
  { stage: 'Document Collection', days: 3, title: 'Collect customer documents', type: 'Email', category: 'Support' },
  { stage: 'Implementation Started', days: 5, title: 'Start implementation', type: 'Meeting', category: 'Technical' },
  { stage: 'Training Scheduled', days: 10, title: 'Schedule customer training', type: 'Demo', category: 'Technical' },
  { stage: 'Go Live', days: 15, title: 'Prepare go live checklist', type: 'Meeting', category: 'Technical' },
  { stage: 'Support', days: 20, title: 'Post go-live support check', type: 'Call', category: 'Support' },
  { stage: 'Feedback Collected', days: 30, title: 'Collect customer feedback', type: 'Call', category: 'Support' },
  { stage: 'Upsell Opportunity', days: 45, title: 'Review upsell opportunity', type: 'Call', category: 'Sales' },
  { stage: 'AMC / Renewal Reminder', days: 330, title: 'AMC / renewal reminder', type: 'Call', category: 'Sales' },
];


const PAYMENT_REMINDER_STAGES = [
  'Advance Payment Pending',
  'Reminder 1',
  'Reminder 2',
  'Final Reminder',
  'Payment Received',
];

const PAYMENT_REMINDER_PLAN = [
  { stage: 'Advance Payment Pending', days: 0, title: 'Collect advance payment', type: 'Email', category: 'Sales' },
  { stage: 'Reminder 1', days: 2, title: 'Payment reminder 1', type: 'Email', category: 'Sales' },
  { stage: 'Reminder 2', days: 5, title: 'Payment reminder 2', type: 'Call', category: 'Sales' },
  { stage: 'Final Reminder', days: 7, title: 'Final payment reminder', type: 'Call', category: 'Sales' },
];

const ensurePaymentReminderTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_payment_reminders (
      id SERIAL PRIMARY KEY,
      proposal_id TEXT UNIQUE,
      lead_id TEXT,
      lead_name TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      phone TEXT,
      assigned TEXT,
      amount NUMERIC DEFAULT 0,
      current_stage TEXT NOT NULL DEFAULT 'Advance Payment Pending',
      status TEXT NOT NULL DEFAULT 'Pending',
      due_date DATE,
      paid_at TIMESTAMP,
      notes TEXT,
      stage_history JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE crm_payment_reminders ADD COLUMN IF NOT EXISTS proposal_id TEXT`);
  await pool.query(`ALTER TABLE crm_payment_reminders ADD COLUMN IF NOT EXISTS lead_id TEXT`);
  await pool.query(`ALTER TABLE crm_payment_reminders ADD COLUMN IF NOT EXISTS amount NUMERIC DEFAULT 0`);
  await pool.query(`ALTER TABLE crm_payment_reminders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`);
};
ensurePaymentReminderTable().catch((err) => console.error('payment reminder table setup failed:', err.message));

const ensureCustomerSuccessTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_customer_success (
      id SERIAL PRIMARY KEY,
      lead_id TEXT,
      lead_name TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      phone TEXT,
      assigned TEXT,
      current_stage TEXT NOT NULL DEFAULT 'Order Confirmed',
      status TEXT NOT NULL DEFAULT 'Active',
      started_at TIMESTAMP DEFAULT NOW(),
      due_date DATE,
      completed_at TIMESTAMP,
      notes TEXT,
      stage_history JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (lead_name)
    )
  `);
  await pool.query(`ALTER TABLE crm_customer_success ALTER COLUMN lead_id TYPE TEXT USING lead_id::TEXT`);
};
ensureCustomerSuccessTable().catch((err) => console.error('customer success table setup failed:', err.message));

const cleanupOrphanLeadRecords = async () => {
  const cleanupQueries = [
    `DELETE FROM crm_followups f
      WHERE COALESCE(f.lead_name, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.name = f.lead_name)`,
    `DELETE FROM crm_proposals p
      WHERE COALESCE(p.lead_name, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.name = p.lead_name)`,
    `DELETE FROM crm_payment_reminders pr
      WHERE NOT EXISTS (
        SELECT 1 FROM crm_leads l
        WHERE (pr.lead_id IS NOT NULL AND l.id::text = pr.lead_id)
           OR l.name = pr.lead_name
      )`,
    `DELETE FROM crm_customer_success cs
      WHERE NOT EXISTS (
        SELECT 1 FROM crm_leads l
        WHERE (cs.lead_id IS NOT NULL AND l.id::text = cs.lead_id)
           OR l.name = cs.lead_name
      )`,
    `DELETE FROM crm_contacts c
      WHERE COALESCE(c.linked_lead, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.name = c.linked_lead)`,
  ];

  for (const query of cleanupQueries) {
    try {
      await pool.query(query);
    } catch (err) {
      console.warn('orphan cleanup skipped:', err.message);
    }
  }
};
const SALES_TEAM = [
  { name: 'Er Sarath Raj', email: process.env.SALES_ER_SARATH_EMAIL || process.env.SALES_EMAIL_1 },
  { name: 'Ms Dharshiha C', email: process.env.SALES_DHARSHIHA_EMAIL || process.env.SALES_EMAIL_2 },
  { name: 'Mr Leejin', email: process.env.SALES_LEEJIN_EMAIL || process.env.SALES_EMAIL_3 },
];

const LOCATION_ASSIGNMENT = [
  { terms: ['vencode', 'colachel', 'nagercoil', 'kanyakumari'], assigned: 'Ms Dharshiha C' },
  { terms: ['chennai', 'madurai', 'coimbatore'], assigned: 'Er Sarath Raj' },
  { terms: ['trivandrum', 'kerala', 'ernakulam'], assigned: 'Mr Leejin' },
];

const PRODUCT_ASSIGNMENT = [
  { terms: ['software', 'crm', 'technology', 'website', 'app'], assigned: 'Er Sarath Raj' },
  { terms: ['industrial', 'manufacturing', 'machine', 'equipment'], assigned: 'Ms Dharshiha C' },
  { terms: ['service', 'support', 'maintenance'], assigned: 'Mr Leejin' },
];
const addDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(10, 0, 0, 0);
  return date;
};

const leadNameOf = (lead) => lead?.name || lead?.lead_name || '';
const leadAssignedOf = (lead) => lead?.assigned || null;
const resolveLinkedLeadName = async (value) => {
  const input = String(value || '').trim();
  if (!input) return null;
  const { rows } = await pool.query(
    'SELECT name FROM crm_leads WHERE id::text=$1 OR name=$1 LIMIT 1',
    [input]
  );
  return rows[0]?.name || null;
};
const normalize = (value) => String(value || '').toLowerCase();
const salespersonEmail = (name) => SALES_TEAM.find((person) => person.name === name)?.email || process.env.SALES_DEFAULT_EMAIL || process.env.EMAIL_USER;

const matchAssignmentRule = (rules, value) => {
  const haystack = normalize(value);
  const rule = rules.find((item) => item.terms.some((term) => haystack.includes(term)));
  return rule?.assigned || null;
};

const getRoundRobinAssignee = async () => {
  const { rows } = await pool.query(
    `SELECT assigned, COUNT(*)::int AS count
     FROM crm_leads
     WHERE assigned = ANY($1)
     GROUP BY assigned`,
    [SALES_TEAM.map((person) => person.name)]
  );
  const counts = new Map(rows.map((row) => [row.assigned, row.count]));
  return SALES_TEAM
    .map((person) => ({ ...person, count: counts.get(person.name) || 0 }))
    .sort((a, b) => a.count - b.count)[0].name;
};

const resolveLeadAssignee = async (lead) => {
  return (
    matchAssignmentRule(LOCATION_ASSIGNMENT, lead.location) ||
    matchAssignmentRule(PRODUCT_ASSIGNMENT, `${lead.industry || ''} ${lead.product || ''} ${lead.notes || ''}`) ||
    await getRoundRobinAssignee()
  );
};

const optionalCompanyAttachments = () => {
  const items = [
    ['Company Profile', process.env.COMPANY_PROFILE_PATH],
    ['Brochure', process.env.BROCHURE_PATH],
    ['Product Catalog', process.env.PRODUCT_CATALOG_PATH],
  ];
  return items.filter(([, path]) => path).map(([filename, path]) => ({ filename, path }));
};

const emailSetupError = () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return 'Email sending is not configured. Add EMAIL_USER and EMAIL_PASS in CRM-backend .env, then restart the backend.';
  }
  return null;
};

const safeSendMail = async (mailOptions) => {
  if (emailSetupError()) return false;
  try {
    const info = await transporter.sendMail(mailOptions);
    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info.rejected) ? info.rejected : [];
    if (!accepted.length) {
      console.error('automation email rejected:', {
        messageId: info.messageId,
        rejected,
        response: info.response,
      });
      return false;
    }
    console.log('automation email accepted:', {
      messageId: info.messageId,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
    });
    return true;
  } catch (err) {
    console.error('automation email failed:', err.code || '', err.command || '', err.message);
    return false;
  }
};

const proposalPublicUrl = (token) => {
  const configured = process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
  const frontend = configured.split(',')[0].trim().replace(/\/+$/, '');
  return `${frontend}/proposal/${encodeURIComponent(token)}`;
};

const proposalEmailHtml = (proposal, publicUrl) => `
  <p>Dear ${proposal.lead_name || 'Customer'},</p>
  <p>Please review the proposal from Manod Technologies using the secure link below.</p>
  <p style="margin:24px 0;">
    <a href="${publicUrl}" style="background:#166534;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;">View Proposal</a>
  </p>
  <p>This private link lets you review and respond to the proposal online.</p>
  <p>Regards,<br/>Manod Technologies</p>
`;

const proposalReminderHtml = (proposal, publicUrl, finalReminder = false) => `
  <p>Dear ${proposal.lead_name || 'Customer'},</p>
  <p>${finalReminder
    ? 'This is a final reminder regarding the proposal you reviewed. Please let us know your decision or any questions.'
    : 'We noticed that you reviewed our proposal. Please let us know if you have any questions or would like to discuss the next steps.'}</p>
  <p style="margin:24px 0;">
    <a href="${publicUrl}" style="background:#166534;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Review Proposal</a>
  </p>
  <p>Regards,<br/>Manod Technologies</p>
`;

const sendWelcomeEmail = async (lead) => {
  if (!lead?.email) return false;
  return safeSendMail({
    from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
    to: lead.email,
    subject: 'Thank you for contacting Manod Technologies',
    attachments: optionalCompanyAttachments(),
    html: `
      <p>Dear ${lead.contact || lead.name || 'Customer'},</p>
      <p>Thank you for contacting Manod Technologies.</p>
      <p>Our executive will contact you shortly.</p>
      <p>Regards,<br/>Manod Team</p>
    `,
  });
};

const notifySalesperson = async (lead) => {
  const to = salespersonEmail(lead.assigned);
  if (!to) return false;
  return safeSendMail({
    from: `"Manod CRM" <${process.env.EMAIL_USER}>`,
    to,
    subject: `New lead assigned: ${lead.name}`,
    html: `
      <p>A new lead has been assigned to you.</p>
      <p><strong>Name:</strong> ${lead.name || '-'}</p>
      <p><strong>Company:</strong> ${lead.company || '-'}</p>
      <p><strong>Phone:</strong> ${lead.mobile || '-'}</p>
      <p><strong>Email:</strong> ${lead.email || '-'}</p>
      <p><strong>Location:</strong> ${lead.location || '-'}</p>
      <p><strong>Source:</strong> ${lead.source || '-'}</p>
    `,
  });
};

const customerSuccessEmailContent = (stage, journey) => {
  const customer = journey.customer_name || journey.lead_name || 'Customer';
  const company = journey.company || customer;
  const projectName = journey.project_name || journey.projectName || company;
  const assigned = journey.assigned || 'Implementation Team';
  const managerEmail = salespersonEmail(assigned) || process.env.SUPPORT_EMAIL || process.env.EMAIL_USER || '';
  const managerPhone = process.env.PROJECT_MANAGER_PHONE || process.env.COMPANY_PHONE || process.env.SUPPORT_PHONE || '';
  const companyPhone = process.env.COMPANY_PHONE || process.env.SUPPORT_PHONE || '';
  const supportPhone = process.env.SUPPORT_PHONE || process.env.COMPANY_PHONE || '';
  const supportEmail = process.env.SUPPORT_EMAIL || process.env.EMAIL_USER || '';
  const website = process.env.COMPANY_WEBSITE || 'www.manodtechnologies.com';
  const dueDate = journey.due_date ? new Date(journey.due_date).toLocaleDateString('en-IN') : null;
  const amount = journey.amount || journey.value || 'As per quotation';
  const invoiceNo = journey.invoice_no || journey.invoiceNo || 'To be shared by Accounts Team';
  const trainingDate = journey.training_date || journey.trainingDate || dueDate || 'To be confirmed';
  const trainingTime = journey.training_time || journey.trainingTime || 'To be confirmed';
  const meetingLink = journey.meeting_link || journey.meetingLink || process.env.TRAINING_MEETING_LINK || 'To be shared before the session';
  const feedbackUrl = journey.feedback_url || journey.feedbackUrl || process.env.FEEDBACK_URL || 'To be shared by Customer Success Team';
  const expiryDate = journey.expiry_date || journey.expiryDate || dueDate || 'To be confirmed';
  const expectedCompletionDate = journey.expected_completion_date || journey.expectedCompletionDate || dueDate || 'To be confirmed';
  const details = dueDate ? `<p><strong>Target date:</strong> ${dueDate}</p>` : '';

  const templates = {
    'Order Confirmed': {
      subject: 'Your Order Has Been Confirmed',
      body: `
        <p>Thank you for choosing <strong>Manod Technologies</strong>.</p>
        <p>We are pleased to confirm your order for <strong>${projectName}</strong>.</p>
        <p>Our team has successfully received your order and has started the onboarding process. You will receive further updates regarding implementation shortly.</p>
        <p>If you have any questions, please contact us.</p>
        ${companyPhone ? `<p><strong>Phone:</strong> ${companyPhone}</p>` : ''}
        <p><strong>Website:</strong> ${website}</p>
      `,
      signoff: 'Manod Technologies',
    },
    'Invoice Generated': {
      subject: 'Invoice Generated Successfully',
      body: `
        <p>Your invoice has been generated successfully.</p>
        <p><strong>Invoice Number:</strong> ${invoiceNo}</p>
        <p><strong>Amount:</strong> ${amount}</p>
        <p>Please review the invoice and complete the payment as per the agreed terms.</p>
        <p>For any billing queries, feel free to contact us.</p>
      `,
      signoff: 'Accounts Team<br/>Manod Technologies',
    },
    'Project Assigned': {
      subject: 'Your Project Has Been Assigned',
      body: `
        <p>Great news!</p>
        <p>Your project has now been assigned to our implementation team.</p>
        <p><strong>Project Manager:</strong> ${assigned}</p>
        ${managerPhone ? `<p><strong>Mobile:</strong> ${managerPhone}</p>` : ''}
        ${managerEmail ? `<p><strong>Email:</strong> ${managerEmail}</p>` : ''}
        <p>Our team will contact you shortly to begin the implementation process.</p>
      `,
      signoff: 'Manod Technologies',
    },
    'Document Collection': {
      subject: 'Documents Required to Begin Implementation',
      body: `
        <p>To begin your project implementation, kindly share the following documents:</p>
        <ul>
          <li>Purchase Order (PO)</li>
          <li>GST details</li>
          <li>Company logo</li>
          <li>Existing data (Excel/CSV)</li>
          <li>User list</li>
          <li>Any additional requirements</li>
        </ul>
        <p>You can reply to this email or upload the documents through our portal.</p>
      `,
      signoff: 'Implementation Team',
    },
    'Implementation Started': {
      subject: 'Project Implementation Started',
      body: `
        <p>We are happy to inform you that the implementation of your project has officially started.</p>
        <p><strong>Current Status:</strong> Implementation In Progress</p>
        <p><strong>Expected Completion:</strong> ${expectedCompletionDate}</p>
        <p>Our team will keep you updated throughout the project.</p>
        <p>Thank you for your trust.</p>
      `,
      signoff: 'Manod Technologies',
    },
    'Training Scheduled': {
      subject: 'User Training Scheduled',
      body: `
        <p>Your product training session has been scheduled.</p>
        <p><strong>Date:</strong> ${trainingDate}</p>
        <p><strong>Time:</strong> ${trainingTime}</p>
        <p><strong>Meeting Link:</strong> ${meetingLink}</p>
        <p>The session will cover system usage, reports, user management, and best practices.</p>
        <p>We look forward to meeting you.</p>
      `,
      signoff: 'Training Team',
    },
    'Go Live': {
      subject: 'Congratulations! Your System Is Live',
      body: `
        <p>Congratulations!</p>
        <p>Your <strong>${projectName}</strong> has successfully gone live.</p>
        <p>You can now begin using the system.</p>
        <p>If you require any assistance, our support team is always available.</p>
        <p>Thank you for choosing Manod Technologies.</p>
      `,
      signoff: 'Implementation Team',
    },
    'Support': {
      subject: "We're Here to Help",
      body: `
        <p>We hope everything is running smoothly.</p>
        <p>If you need any assistance regarding your ERP, CRM, AI solution, or custom software, our support team is ready to help.</p>
        ${supportPhone ? `<p><strong>Support:</strong> ${supportPhone}</p>` : ''}
        ${supportEmail ? `<p><strong>Email:</strong> ${supportEmail}</p>` : ''}
        <p>Feel free to contact us anytime.</p>
      `,
      signoff: 'Customer Support Team',
    },
    'Feedback Collected': {
      subject: "We'd Love Your Feedback",
      body: `
        <p>Thank you for choosing Manod Technologies.</p>
        <p>Your feedback helps us improve our products and services.</p>
        <p>Please take a minute to rate your experience.</p>
        <p><strong>Feedback Link:</strong> ${feedbackUrl}</p>
        <p>We appreciate your valuable feedback.</p>
      `,
      signoff: 'Customer Success Team',
    },
    'Upsell Opportunity': {
      subject: 'Enhance Your Business with More Smart Solutions',
      body: `
        <p>Thank you for being our valued customer.</p>
        <p>Based on your current solution, we recommend additional products that can further improve your business operations.</p>
        <p><strong>Recommended Solutions:</strong></p>
        <ul>
          <li>AI Automation</li>
          <li>CRM</li>
          <li>HRMS</li>
          <li>Inventory Management</li>
          <li>Mobile App</li>
          <li>Customer Portal</li>
          <li>WhatsApp Automation</li>
          <li>Business Intelligence Dashboard</li>
        </ul>
        <p>Contact us for a free demonstration.</p>
      `,
      signoff: 'Business Development Team',
    },
    'AMC / Renewal Reminder': {
      subject: 'Annual Support Renewal Reminder',
      body: `
        <p>This is a friendly reminder that your Annual Maintenance Contract (AMC) will expire on:</p>
        <p><strong>${expiryDate}</strong></p>
        <p>Renewing your AMC ensures:</p>
        <ul>
          <li>Priority support</li>
          <li>Software updates</li>
          <li>Bug fixes</li>
          <li>Security updates</li>
          <li>Technical assistance</li>
        </ul>
        <p>Please contact us to renew your AMC and continue enjoying uninterrupted support.</p>
      `,
      signoff: 'Manod Technologies',
    },
  };

  const content = templates[stage] || {
    subject: `Customer Success update - ${company}`,
    body: `<p>Your Customer Success stage has been updated to <strong>${stage}</strong>.</p>${details}`,
    signoff: 'Manod Team',
  };

  return {
    subject: content.subject,
    html: `
      <p>Dear ${customer},</p>
      ${content.body}
      <p>Regards,<br/>${content.signoff}</p>
    `,
  };
};
const sendCustomerSuccessStageEmail = async (journey, stage) => {
  if (!journey?.email) return false;
  const content = customerSuccessEmailContent(stage, journey);
  return safeSendMail({
    from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
    to: journey.email,
    subject: content.subject,
    html: content.html,
  });
};
const ensureFollowup = async ({ lead, title, type = 'Call', category = 'Sales', daysFromNow = 1, desc }) => {
  const leadName = leadNameOf(lead);
  if (!leadName || !title) return null;

  const existing = await pool.query(
    `SELECT id FROM crm_followups
     WHERE lead_name = $1 AND title = $2 AND status IN ('Scheduled', 'Pending')
     LIMIT 1`,
    [leadName, title]
  );
  if (existing.rows.length) return null;

  const start = addDays(daysFromNow);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const { rows } = await pool.query(
    `INSERT INTO crm_followups (lead_name, title, status, type, category, assigned, start_time, end_time, description)
     VALUES ($1, $2, 'Scheduled', $3, $4, $5, $6, $7, $8) RETURNING *`,
    [leadName, title, type, category, leadAssignedOf(lead), start, end, desc || null]
  );
  return rows[0];
};


const ensureCustomerSuccessJourney = async (lead) => {
  const leadName = leadNameOf(lead);
  if (!leadName) return null;
  await ensureCustomerSuccessTable();

  const existing = await pool.query(
    `SELECT * FROM crm_customer_success
     WHERE (lead_id IS NOT NULL AND lead_id = $1) OR lead_name = $2
     ORDER BY CASE WHEN lead_id = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [lead.id ? String(lead.id) : null, leadName]
  );
  if (existing.rows.length) {
    const { rows: synced } = await pool.query(
      `UPDATE crm_customer_success SET
        lead_id=$1, lead_name=$2, customer_name=$3, company=$4, email=$5, phone=$6, assigned=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [
        lead.id ? String(lead.id) : existing.rows[0].lead_id,
        leadName,
        lead.company || leadName,
        lead.company || null,
        lead.email || null,
        lead.mobile || lead.phone || null,
        leadAssignedOf(lead),
        existing.rows[0].id,
      ]
    );
    return synced[0];
  }

  const firstStage = CUSTOMER_SUCCESS_STAGES[0];
  const dueDate = addDays(2).toISOString().slice(0, 10);
  const history = [{ stage: firstStage, date: new Date().toISOString(), note: 'Created automatically after lead won.' }];
  const { rows } = await pool.query(
    `INSERT INTO crm_customer_success
      (lead_id, lead_name, customer_name, company, email, phone, assigned, current_stage, due_date, notes, stage_history)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      lead.id ? String(lead.id) : null,
      leadName,
      lead.company || leadName,
      lead.company || null,
      lead.email || null,
      lead.mobile || lead.phone || null,
      leadAssignedOf(lead),
      firstStage,
      dueDate,
      'Customer Success workflow created automatically after lead was won.',
      jsonValue(history, []),
    ]
  );

  const journey = rows[0];
  await sendCustomerSuccessStageEmail(journey, firstStage);

  for (const item of CUSTOMER_SUCCESS_PLAN) {
    await ensureFollowup({
      lead,
      title: `Customer Success: ${item.title}`,
      type: item.type,
      category: item.category,
      daysFromNow: item.days,
      desc: `${item.stage} stage for ${lead.company || leadName}.`,
    });
  }

  return journey;
};
const formatINR = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(Number(value) || 0);

const buildStandardProposalBody = ({ customer, value, dueDate }) => `
  <p>Dear ${customer || 'Customer'},</p>
  <p>Thank you for your enquiry. Please find our standard quotation for your requirement.</p>
  <table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:13px;">
    <tbody>
      <tr><td style="border:1px solid #e5e7eb; padding:8px; font-weight:600;">Customer / Lead</td><td style="border:1px solid #e5e7eb; padding:8px;">${customer || 'Customer'}</td></tr>
      <tr><td style="border:1px solid #e5e7eb; padding:8px; font-weight:600;">Quotation Value</td><td style="border:1px solid #e5e7eb; padding:8px;"><strong>${formatINR(value)}</strong></td></tr>
      <tr><td style="border:1px solid #e5e7eb; padding:8px; font-weight:600;">Validity</td><td style="border:1px solid #e5e7eb; padding:8px;">${dueDate || '7 days from quotation date'}</td></tr>
    </tbody>
  </table>
  <p><strong>Scope of Work</strong></p>
  <ul>
    <li>Requirement review and confirmation</li>
    <li>Solution setup / implementation as discussed</li>
    <li>Testing, handover, and basic user guidance</li>
    <li>Support as per agreed terms</li>
  </ul>
  <p><strong>Terms</strong></p>
  <ul>
    <li>Taxes, hosting, third-party charges, and custom changes will be billed as applicable.</li>
    <li>Delivery timeline starts after confirmation and receipt of required documents.</li>
  </ul>
  <p>Kindly review and confirm so we can proceed with the next step.</p>
  <p>Regards,<br/>Manod Technologies</p>
`;
const ensureProposalQuotation = async (lead) => {
  const leadName = leadNameOf(lead);
  if (!leadName) return null;

  const existing = await pool.query(
    `SELECT id FROM crm_proposals
     WHERE lead_name = $1 AND subject ILIKE 'Quotation:%'
     LIMIT 1`,
    [leadName]
  );
  if (existing.rows.length) return null;

  const dueDate = addDays(7).toISOString().slice(0, 10);
  const value = lead.value || 0;
  const subject = `Quotation: ${lead.company || leadName}`;
  const body = `
    <p>Dear ${lead.contact || leadName},</p>
    <p>Thank you for your enquiry. Please find our quotation for your requirement.</p>
    <p><strong>Estimated value:</strong> ${value}</p>
    <p>Regards,<br/>Manod Technologies</p>
  `;

  const { rows } = await pool.query(
    `INSERT INTO crm_proposals (lead_name, subject, sent_by, value, status, due_date, body)
     VALUES ($1, $2, $3, $4, 'Draft', $5, $6) RETURNING *`,
    [leadName, subject, leadAssignedOf(lead), value, dueDate, body]
  );
  return rows[0];
};


const paymentReminderEmailContent = (stage, reminder) => {
  const customer = reminder.customer_name || reminder.lead_name || 'Customer';
  const amount = formatINR(reminder.amount || 0);
  const dueDate = reminder.due_date ? new Date(reminder.due_date).toLocaleDateString('en-IN') : 'at the earliest';
  const templates = {
    'Advance Payment Pending': {
      subject: 'Advance Payment Pending - Manod Technologies',
      body: `
        <p>Thank you for accepting our proposal.</p>
        <p>Your order is now ready for advance payment processing.</p>
        <p><strong>Amount:</strong> ${amount}</p>
        <p><strong>Due Date:</strong> ${dueDate}</p>
        <p>Once payment is received, our Customer Success process will begin.</p>
      `,
    },
    'Reminder 1': {
      subject: 'Payment Reminder 1 - Manod Technologies',
      body: `
        <p>This is a gentle reminder that the advance payment is pending.</p>
        <p><strong>Amount:</strong> ${amount}</p>
        <p>Please complete the payment so we can start the next process.</p>
      `,
    },
    'Reminder 2': {
      subject: 'Payment Reminder 2 - Manod Technologies',
      body: `
        <p>We would like to remind you that the advance payment is still pending.</p>
        <p><strong>Amount:</strong> ${amount}</p>
        <p>Kindly complete the payment to avoid delays in project initiation.</p>
      `,
    },
    'Final Reminder': {
      subject: 'Final Payment Reminder - Manod Technologies',
      body: `
        <p>This is the final reminder for the pending advance payment.</p>
        <p><strong>Amount:</strong> ${amount}</p>
        <p>Please complete the payment immediately so we can proceed with your project.</p>
      `,
    },
    'Payment Received': {
      subject: 'Payment Received - Customer Success Started',
      body: `
        <p>We have received your payment. Thank you.</p>
        <p>Your Customer Success workflow has now started, and our team will contact you for the next steps.</p>
      `,
    },
  };
  const content = templates[stage] || templates['Advance Payment Pending'];
  return {
    subject: content.subject,
    html: `
      <p>Dear ${customer},</p>
      ${content.body}
      <p>Regards,<br/>Manod Technologies</p>
    `,
  };
};

const sendPaymentReminderStageEmail = async (reminder, stage) => {
  if (!reminder?.email) return false;
  const content = paymentReminderEmailContent(stage, reminder);
  return safeSendMail({
    from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
    to: reminder.email,
    subject: content.subject,
    html: content.html,
  });
};

const ensurePaymentReminderForProposal = async (proposal, lead) => {
  const leadName = proposal?.lead_name || proposal?.lead || leadNameOf(lead);
  if (!leadName) return null;
  await ensurePaymentReminderTable();
  const amount = Number(proposal?.value || lead?.value || 0) || 0;
  const dueDate = addDays(2).toISOString().slice(0, 10);
  const proposalId = proposal?.id ? String(proposal.id) : null;

  const existing = await pool.query(
    `SELECT * FROM crm_payment_reminders
     WHERE (proposal_id IS NOT NULL AND proposal_id=$1) OR lead_name=$2
     ORDER BY CASE WHEN proposal_id=$1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [proposalId, leadName]
  );
  if (existing.rows.length) {
    const { rows } = await pool.query(
      `UPDATE crm_payment_reminders SET
        proposal_id=$1, lead_id=$2, lead_name=$3, customer_name=$4, company=$5,
        email=$6, phone=$7, assigned=$8, amount=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [
        proposalId || existing.rows[0].proposal_id,
        lead?.id ? String(lead.id) : existing.rows[0].lead_id,
        leadName,
        lead?.company || leadName,
        lead?.company || null,
        lead?.email || existing.rows[0].email || null,
        lead?.mobile || lead?.phone || existing.rows[0].phone || null,
        leadAssignedOf(lead) || proposal?.sent_by || existing.rows[0].assigned,
        amount,
        existing.rows[0].id,
      ]
    );
    return rows[0];
  }

  const firstStage = PAYMENT_REMINDER_STAGES[0];
  const history = [{ stage: firstStage, date: new Date().toISOString(), note: 'Created automatically after proposal accepted.' }];
  const { rows } = await pool.query(
    `INSERT INTO crm_payment_reminders
      (proposal_id, lead_id, lead_name, customer_name, company, email, phone, assigned, amount, current_stage, status, due_date, notes, stage_history)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Pending', $11, $12, $13) RETURNING *`,
    [
      proposalId,
      lead?.id ? String(lead.id) : null,
      leadName,
      lead?.company || leadName,
      lead?.company || null,
      lead?.email || null,
      lead?.mobile || lead?.phone || null,
      leadAssignedOf(lead) || proposal?.sent_by || null,
      amount,
      firstStage,
      dueDate,
      'Payment workflow created automatically after proposal acceptance.',
      jsonValue(history, []),
    ]
  );
  const reminder = rows[0];
  await sendPaymentReminderStageEmail(reminder, firstStage);
  for (const item of PAYMENT_REMINDER_PLAN) {
    await ensureFollowup({
      lead: lead || { name: leadName, assigned: proposal?.sent_by },
      title: `Payment Reminder: ${item.title}`,
      type: item.type,
      category: item.category,
      daysFromNow: item.days,
      desc: `${item.stage} for accepted proposal ${proposal?.subject || leadName}.`,
    });
  }
  return reminder;
};

const runLeadAutomation = async (lead, previousStage) => {
  const stage = lead?.stage || 'New';
  const stageChanged = previousStage === undefined || previousStage !== stage;

  if (stage === 'New' && previousStage === undefined) {
    await ensureFollowup({
      lead,
      title: 'New client follow-up message',
      type: 'Email',
      daysFromNow: 1,
      desc: 'Send welcome message and confirm the customer requirement.',
    });
  }

  if (stage === 'Proposal' && stageChanged) {
    await ensureProposalQuotation(lead);
    await ensureFollowup({
      lead,
      title: 'Send proposal quotation',
      type: 'Email',
      daysFromNow: 0,
      desc: 'Review the quotation draft and send it to the customer.',
    });
  }

  if (stage === 'Won' && stageChanged) {
    await ensurePaymentReminderForProposal(null, lead);
    await ensureFollowup({
      lead,
      title: 'Advance payment follow-up',
      type: 'Call',
      category: 'Sales',
      daysFromNow: 1,
      desc: 'Lead is won. Confirm accepted proposal and advance payment status.',
    });
  }
};

const runProposalAutomation = async (proposal, previousStatus) => {
  const status = proposal?.status;
  const leadName = proposal?.lead_name || proposal?.lead;
  const statusChanged = previousStatus === undefined || previousStatus !== status;
  if (!leadName || !statusChanged) return;

  if (status === 'Sent' || status === 'Viewed') {
    await ensureFollowup({
      lead: { name: leadName, assigned: proposal.sent_by },
      title: 'Proposal follow-up',
      type: 'Call',
      daysFromNow: 2,
      desc: 'Follow up after sending the proposal quotation.',
    });
  }

  if (status === 'Accepted') {
    const { rows } = await pool.query(
      `UPDATE crm_leads
       SET stage='Won', converted=true, converted_date=CURRENT_DATE, updated_at=NOW()
       WHERE name=$1 RETURNING *`,
      [leadName]
    );
    const lead = rows[0] || { name: leadName, assigned: proposal.sent_by, converted: true, stage: 'Won' };
    await ensurePaymentReminderForProposal(proposal, lead);
  }

  if (status === 'Rejected') {
    await ensureFollowup({
      lead: { name: leadName, assigned: proposal.sent_by },
      title: 'Proposal rejection follow-up',
      type: 'Call',
      daysFromNow: 3,
      desc: 'Understand why the proposal was rejected and plan the next action.',
    });
  }
};

const processProposalEngagements = async () => {
  await ensureProposalAutomationColumns();
  await pool.query(`
    UPDATE crm_proposals
    SET status='Expired', updated_at=NOW()
    WHERE status IN ('Sent', 'Viewed')
      AND due_date IS NOT NULL
      AND due_date < CURRENT_DATE
  `);

  const { rows } = await pool.query(`
    SELECT p.*, l.email, l.assigned
    FROM crm_proposals p
    LEFT JOIN crm_leads l ON l.name = p.lead_name
    WHERE p.status='Viewed'
      AND p.first_viewed_at IS NOT NULL
      AND (p.due_date IS NULL OR p.due_date >= CURRENT_DATE)
      AND (
        (p.followup_1_sent_at IS NULL AND p.first_viewed_at <= NOW() - INTERVAL '1 day')
        OR (p.call_task_created_at IS NULL AND p.first_viewed_at <= NOW() - INTERVAL '3 days')
        OR (p.final_reminder_sent_at IS NULL AND p.first_viewed_at <= NOW() - INTERVAL '5 days')
      )
  `);

  for (const proposal of rows) {
    const publicUrl = proposalPublicUrl(proposal.public_token);
    const viewedAt = new Date(proposal.first_viewed_at).getTime();

    if (!proposal.followup_1_sent_at && viewedAt <= Date.now() - 86400000) {
      const sent = proposal.email && await safeSendMail({
        from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
        to: proposal.email,
        subject: `Follow-up: ${proposal.subject}`,
        html: proposalReminderHtml(proposal, publicUrl),
      });
      if (sent) {
        await pool.query(
          `UPDATE crm_proposals SET followup_1_sent_at=NOW(), updated_at=NOW()
           WHERE id=$1 AND status='Viewed' AND followup_1_sent_at IS NULL`,
          [proposal.id]
        );
      }
    }

    if (!proposal.call_task_created_at && viewedAt <= Date.now() - 3 * 86400000) {
      await ensureFollowup({
        lead: { name: proposal.lead_name, assigned: proposal.assigned || proposal.sent_by },
        title: `Proposal response call: ${proposal.subject}`,
        type: 'Call',
        category: 'Sales',
        daysFromNow: 0,
        desc: 'The client viewed the proposal three days ago but has not accepted or rejected it.',
      });
      await pool.query(
        `UPDATE crm_proposals SET call_task_created_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status='Viewed' AND call_task_created_at IS NULL`,
        [proposal.id]
      );
    }

    if (!proposal.final_reminder_sent_at && viewedAt <= Date.now() - 5 * 86400000) {
      const sent = proposal.email && await safeSendMail({
        from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
        to: proposal.email,
        subject: `Final reminder: ${proposal.subject}`,
        html: proposalReminderHtml(proposal, publicUrl, true),
      });
      if (sent) {
        await pool.query(
          `UPDATE crm_proposals SET final_reminder_sent_at=NOW(), updated_at=NOW()
           WHERE id=$1 AND status='Viewed' AND final_reminder_sent_at IS NULL`,
          [proposal.id]
        );
      }
    }
  }
};

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENHANCED LEADS ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
router.get('/leads', async (req, res) => {
  try {
    await cleanupOrphanLeadRecords();
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
    const {
      name, mobile, email, company, contact, location, industry, source, stage, assigned, notes, value,
      contactType, entityType, taxNumber, address1, address2, city, state, country, zipCode,
      landmark, streetName, buildingNumber, additionalNumber, customFields, contactPersons,
    } = req.body;
    await ensureLeadExtraColumns();
    const safeStage = stage === 'Won' ? 'New' : (stage || 'New');
    const autoAssigned = await resolveLeadAssignee({ location, industry, notes, assigned });
    const { rows } = await pool.query(
      `INSERT INTO crm_leads (
        name, mobile, email, company, contact, location, industry, source, stage, assigned, notes, value,
        contact_type, entity_type, tax_number, address1, address2, city, state, country, zip_code,
        landmark, street_name, building_number, additional_number, custom_fields, contact_persons, lead_details
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28) RETURNING *`,
      [
        name,
        mobile || null,
        email || null,
        company || null,
        contact || null,
        location || null,
        industry || null,
        source || 'Website',
        safeStage,
        autoAssigned || assigned || null,
        notes || null,
        value || 0,
        contactType || 'Lead',
        entityType || 'Individual',
        taxNumber || null,
        address1 || null,
        address2 || null,
        city || null,
        state || null,
        country || null,
        zipCode || null,
        landmark || null,
        streetName || null,
        buildingNumber || null,
        additionalNumber || null,
        jsonValue(customFields, {}),
        jsonValue(contactPersons, []),
        jsonValue(req.body, {})
      ]
    );
    await runLeadAutomation(rows[0]);
    const [welcomeEmailSent, salespersonEmailSent] = await Promise.all([sendWelcomeEmail(rows[0]), notifySalesperson(rows[0])]);
    res.json({
      success: true,
      lead: rows[0],
      automation: {
        followupCreated: rows[0].stage === 'New',
        welcomeEmailSent,
        salespersonEmailSent,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/leads/:id', async (req, res) => {
  try {
    const {
      name, mobile, email, company, contact, location, industry, source, stage, assigned, notes, value,
      contactType, entityType, taxNumber, address1, address2, city, state, country, zipCode,
      landmark, streetName, buildingNumber, additionalNumber, customFields, contactPersons,
    } = req.body;
    await ensureLeadExtraColumns();
    const current = await pool.query('SELECT stage FROM crm_leads WHERE id=$1', [req.params.id]);
    const previousStage = current.rows[0]?.stage;
    if (stage === 'Won' && previousStage !== 'Won') {
      return res.status(400).json({ error: 'Accept a proposal to move this lead to Won.' });
    }
    const { rows } = await pool.query(
      `UPDATE crm_leads SET
        name=$1, mobile=$2, email=$3, company=$4, contact=$5, location=$6, industry=$7,
        source=$8, stage=$9, assigned=$10, notes=$11, value=$12,
        contact_type=$13, entity_type=$14, tax_number=$15, address1=$16, address2=$17, city=$18,
        state=$19, country=$20, zip_code=$21, landmark=$22, street_name=$23, building_number=$24,
        additional_number=$25, custom_fields=$26, contact_persons=$27, lead_details=$28, updated_at=NOW()
       WHERE id=$29 RETURNING *`,
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
        contactType || 'Lead',
        entityType || 'Individual',
        taxNumber || null,
        address1 || null,
        address2 || null,
        city || null,
        state || null,
        country || null,
        zipCode || null,
        landmark || null,
        streetName || null,
        buildingNumber || null,
        additionalNumber || null,
        jsonValue(customFields, {}),
        jsonValue(contactPersons, []),
        jsonValue(req.body, {}),
        req.params.id,
      ]
    );
    if (rows[0]) {
      await runLeadAutomation(rows[0], previousStage);
    }
    res.json({ success: true, lead: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/leads/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, name FROM crm_leads WHERE id=$1', [req.params.id]);
    const lead = current.rows[0];
    if (!lead) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }

    await client.query('DELETE FROM crm_payment_reminders WHERE lead_id=$1', [String(lead.id)]);
    await client.query('DELETE FROM crm_customer_success WHERE lead_id=$1', [String(lead.id)]);

    const remaining = await client.query('SELECT id FROM crm_leads WHERE id<>$1 AND name=$2 LIMIT 1', [req.params.id, lead.name]);
    if (!remaining.rows.length) {
      await client.query('DELETE FROM crm_followups WHERE lead_name=$1', [lead.name]);
      await client.query('DELETE FROM crm_proposals WHERE lead_name=$1', [lead.name]);
      await client.query('DELETE FROM crm_payment_reminders WHERE lead_name=$1', [lead.name]);
      await client.query('DELETE FROM crm_customer_success WHERE lead_name=$1', [lead.name]);
    }

    await client.query('DELETE FROM crm_leads WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.patch('/leads/:id/convert', async (req, res) => {
  try {
    const accepted = await pool.query(
      `SELECT p.* FROM crm_proposals p
       JOIN crm_leads l ON p.lead = l.name
       WHERE l.id=$1 AND p.status='Accepted'
       ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
       LIMIT 1`,
      [req.params.id]
    );
    if (!accepted.rows[0]) {
      return res.status(400).json({ error: 'Accept a proposal before moving this lead to Won.' });
    }
    const { rows } = await pool.query(
      `UPDATE crm_leads SET converted=true, converted_date=CURRENT_DATE, stage='Won', updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    await ensurePaymentReminderForProposal(accepted.rows[0], rows[0]);
    await runLeadAutomation(rows[0], 'New');
    res.json({ success: true, lead: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENHANCED FOLLOW-UPS ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
router.post('/leads/:id/ai-call', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_leads WHERE id=$1 LIMIT 1', [req.params.id]);
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!twilioFactory) {
      return res.status(400).json({ error: 'Twilio package is not installed. Run npm install twilio in CRM-backend-.' });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER;
    if (!accountSid || !authToken || !fromNumber) {
      return res.status(400).json({ error: 'Twilio credentials are missing. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER in backend .env.' });
    }

    const toNumber = normalizeCallPhone(req.body?.phone || lead.mobile || lead.phone);
    if (!toNumber) {
      return res.status(400).json({ error: 'Lead phone number is missing or invalid. Use country code like +919876543210.' });
    }

    const leadName = leadNameOf(lead) || 'Customer';
    const message = req.body?.message || `Hello ${leadName}. This is Manod Technologies. Thank you for your enquiry. Are you looking for CRM or ERP software? Our executive will contact you shortly.`;
    if (req.body?.dryRun) {
      return res.json({
        success: true,
        message: 'AI call endpoint is ready.',
        lead: { id: lead.id, name: leadName, phone: toNumber }
      });
    }

    const twiml = `<Response><Say voice="alice" language="en-IN">${escapeTwiml(message)}</Say></Response>`;
    const client = twilioFactory(accountSid, authToken);
    const call = await client.calls.create({ to: toNumber, from: fromNumber, twiml });

    const start = addDays(1);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const { rows: followupRows } = await pool.query(
      `INSERT INTO crm_followups (lead_name, title, status, type, category, assigned, start_time, end_time, description)
       VALUES ($1, $2, 'Scheduled', 'Call', 'Sales', $3, $4, $5, $6) RETURNING *`,
      [leadName, 'AI call follow-up', leadAssignedOf(lead), start, end, `Twilio AI call started. Call SID: ${call.sid}. Message: ${message}`]
    );

    res.json({
      success: true,
      call: { sid: call.sid, status: call.status, to: toNumber },
      followup: followupRows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/followups', async (req, res) => {
  try {
    await cleanupOrphanLeadRecords();
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENHANCED CAMPAIGNS ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const campaignLeadFilterSql = (group) => {
  const value = String(group || 'all').toLowerCase();
  if (value === 'new') return " AND LOWER(COALESCE(stage, '')) = 'new'";
  if (value === 'proposal') return " AND LOWER(COALESCE(stage, '')) = 'proposal'";
  if (value === 'won') return " AND (LOWER(COALESCE(stage, '')) = 'won' OR LOWER(COALESCE(status, '')) = 'customer')";
  return '';
};

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


router.post('/campaigns/:id/send', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_campaigns WHERE id=$1', [req.params.id]);
    const campaign = rows[0];
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if ((campaign.type || 'Email') !== 'Email') return res.status(400).json({ error: 'Only Email campaigns can be sent.' });
    if (!campaign.subject) return res.status(400).json({ error: 'Campaign subject is required before sending.' });
    if (!campaign.body) return res.status(400).json({ error: 'Campaign body is required before sending.' });

    const setupError = emailSetupError();
    if (setupError) return res.status(400).json({ error: setupError });

    const filterSql = campaignLeadFilterSql(req.body?.recipientGroup);
    const leadResult = await pool.query(
      `SELECT name, email FROM crm_leads
       WHERE COALESCE(email, '') <> ''
       AND LOWER(COALESCE(status, '')) <> 'deleted'${filterSql}
       ORDER BY created_at DESC`
    );
    const seen = new Set();
    const recipients = leadResult.rows
      .map((lead) => String(lead.email || '').trim())
      .filter((email) => {
        const key = email.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No lead email addresses found for this campaign recipient group.' });
    }

    const sent = await safeSendMail({
      from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      cc: campaign.cc || undefined,
      bcc: recipients.join(','),
      subject: campaign.subject,
      html: campaign.body,
    });
    if (!sent) return res.status(500).json({ error: 'Email sending failed. Check backend email credentials and logs.' });

    const updated = await pool.query(
      `UPDATE crm_campaigns SET status='Active', recipients=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [recipients.length, req.params.id]
    );
    res.json({ success: true, campaign: updated.rows[0], sentCount: recipients.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/campaigns/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM crm_campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENHANCED PROPOSALS ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
router.get('/proposals', async (req, res) => {
  try {
    await cleanupOrphanLeadRecords();
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
    await runProposalAutomation(rows[0]);
    res.json({ success: true, proposal: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/proposals/:id', async (req, res) => {
  try {
    const { lead, lead_name, subject, sentBy, sent_by, value, status, dueDate, due_date, cc, bcc, body } = req.body;
    const leadVal = lead || lead_name || null;
    const sentByVal = sentBy || sent_by || null;
    const dueDateVal = dueDate || due_date || null;
    const current = await pool.query('SELECT status FROM crm_proposals WHERE id=$1', [req.params.id]);
    const previousStatus = current.rows[0]?.status;

    const { rows } = await pool.query(
      `UPDATE crm_proposals SET lead_name=$1, subject=$2, sent_by=$3, value=$4, status=$5, due_date=$6, cc=$7, bcc=$8, body=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [leadVal, subject, sentByVal, value || 0, status, dueDateVal, cc || null, bcc || null, body || null, req.params.id]
    );
    await runProposalAutomation(rows[0], previousStatus);
    res.json({ success: true, proposal: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public proposal endpoints use a random token instead of exposing a proposal id.
router.get('/public/proposals/:token', async (req, res) => {
  try {
    await ensureProposalAutomationColumns();
    const { rows } = await pool.query(
      `UPDATE crm_proposals
       SET first_viewed_at=COALESCE(first_viewed_at, NOW()),
           last_viewed_at=NOW(),
           view_count=COALESCE(view_count, 0) + 1,
           status=CASE WHEN status='Sent' THEN 'Viewed' ELSE status END,
           updated_at=NOW()
       WHERE public_token=$1 AND status <> 'Draft'
       RETURNING id, lead_name, subject, value, status, due_date, body,
                 first_viewed_at, last_viewed_at, view_count`,
      [req.params.token]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proposal link is invalid or no longer available.' });
    res.json({ success: true, proposal: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Unable to open this proposal.' });
  }
});

router.post('/public/proposals/:token/respond', async (req, res) => {
  try {
    const decision = String(req.body?.decision || '').trim().toLowerCase();
    if (!['accept', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'Choose accept or reject.' });
    }
    const nextStatus = decision === 'accept' ? 'Accepted' : 'Rejected';
    const current = await pool.query('SELECT * FROM crm_proposals WHERE public_token=$1', [req.params.token]);
    const proposal = current.rows[0];
    if (!proposal) return res.status(404).json({ error: 'Proposal link is invalid.' });
    if (['Accepted', 'Rejected', 'Expired'].includes(proposal.status)) {
      return res.json({ success: true, proposal: { status: proposal.status } });
    }
    const { rows } = await pool.query(
      `UPDATE crm_proposals
       SET status=$1, responded_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND status IN ('Sent', 'Viewed')
       RETURNING *`,
      [nextStatus, proposal.id]
    );
    if (!rows[0]) return res.status(409).json({ error: 'This proposal can no longer be updated.' });
    await runProposalAutomation(rows[0], proposal.status);
    res.json({ success: true, proposal: { status: rows[0].status } });
  } catch (err) {
    res.status(500).json({ error: 'Unable to save your response.' });
  }
});

// SEND PROPOSAL — emails a secure proposal link and marks it Sent
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

    const setupError = emailSetupError();
    if (setupError) {
      return res.status(400).json({ error: setupError });
    }

    const publicToken = proposal.public_token || crypto.randomBytes(32).toString('hex');
    const publicUrl = proposalPublicUrl(publicToken);
    const sent = await safeSendMail({
      from: `"Manod Technologies" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      cc: proposal.cc || undefined,
      bcc: proposal.bcc || undefined,
      subject: proposal.subject,
      html: proposalEmailHtml(proposal, publicUrl),
    });
    if (!sent) {
      return res.status(500).json({ error: 'Email could not be sent. Check backend email settings and try again.' });
    }

    const { rows: updated } = await pool.query(
      `UPDATE crm_proposals
       SET status='Sent', public_token=$2, sent_at=NOW(),
           first_viewed_at=NULL, last_viewed_at=NULL, view_count=0,
           followup_1_sent_at=NULL, call_task_created_at=NULL,
           final_reminder_sent_at=NULL, responded_at=NULL, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, publicToken]
    );
    await runProposalAutomation(updated[0], proposal.status);

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENHANCED CONTACTS ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
    const linkedLeadInput = linkedLead || linked_lead || null;
    const linkedLeadVal = await resolveLinkedLeadName(linkedLeadInput);
    if (linkedLeadInput && !linkedLeadVal) return res.status(400).json({ error: 'Linked lead not found. Select an existing lead or leave it blank.' });
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
    const linkedLeadInput = linkedLead || linked_lead || null;
    const linkedLeadVal = await resolveLinkedLeadName(linkedLeadInput);
    if (linkedLeadInput && !linkedLeadVal) return res.status(400).json({ error: 'Linked lead not found. Select an existing lead or leave it blank.' });
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TEMPLATES ROUTES (unchanged)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•


// PAYMENT REMINDER ROUTES
router.get('/payment-reminders', async (req, res) => {
  try {
    await cleanupOrphanLeadRecords();
    await ensurePaymentReminderTable();
    const { rows: acceptedRows } = await pool.query(
      `SELECT DISTINCT ON (l.id) l.*, p.id AS proposal_id, p.value AS proposal_value, p.status AS proposal_status
       FROM crm_leads l
       JOIN crm_proposals p ON p.lead_name = l.name
       WHERE l.stage='Won' AND p.status='Accepted'
       ORDER BY l.id, p.updated_at DESC NULLS LAST, p.id DESC`
    );
    for (const row of acceptedRows) {
      await ensurePaymentReminderForProposal(
        { id: row.proposal_id, lead_name: row.name, value: row.proposal_value, status: row.proposal_status },
        row
      );
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (pr.id) pr.*
       FROM crm_payment_reminders pr
       JOIN crm_leads l ON (pr.lead_id IS NOT NULL AND pr.lead_id = l.id::text) OR pr.lead_name = l.name
       JOIN crm_proposals p ON pr.proposal_id = p.id::text AND p.status = 'Accepted'
       ORDER BY pr.id, pr.updated_at DESC`
    );
    res.json({ success: true, paymentReminders: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/payment-reminders/:id', async (req, res) => {
  try {
    await ensurePaymentReminderTable();
    const { currentStage, current_stage, status, notes, assigned, dueDate, due_date } = req.body;
    const stage = currentStage || current_stage || PAYMENT_REMINDER_STAGES[0];
    if (!PAYMENT_REMINDER_STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid payment reminder stage.' });

    const current = await pool.query('SELECT * FROM crm_payment_reminders WHERE id=$1', [req.params.id]);
    const existing = current.rows[0];
    if (!existing) return res.status(404).json({ error: 'Payment reminder not found' });

    const stageChanged = existing.current_stage !== stage;
    const history = Array.isArray(existing.stage_history) ? existing.stage_history : [];
    const nextHistory = !stageChanged
      ? history
      : [...history, { stage, date: new Date().toISOString(), note: 'Payment stage updated manually.' }];
    const isPaid = stage === 'Payment Received';
    const nextStatus = status || (isPaid ? 'Completed' : 'Pending');
    const paidAt = isPaid ? 'NOW()' : 'NULL';

    const { rows } = await pool.query(
      `UPDATE crm_payment_reminders SET
        current_stage=$1, status=$2, notes=$3, assigned=$4, due_date=$5,
        stage_history=$6, paid_at=${paidAt}, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [stage, nextStatus, notes ?? existing.notes, assigned || existing.assigned, dueDate || due_date || existing.due_date, jsonValue(nextHistory, []), req.params.id]
    );

    const reminder = rows[0];
    const paymentEmailSent = stageChanged ? await sendPaymentReminderStageEmail(reminder, stage) : false;
    let customerSuccess = null;
    if (isPaid) {
      const leadResult = await pool.query(
        'SELECT * FROM crm_leads WHERE (id::text=$1 AND $1 IS NOT NULL) OR name=$2 LIMIT 1',
        [reminder.lead_id || null, reminder.lead_name]
      );
      const lead = leadResult.rows[0] || {
        id: reminder.lead_id,
        name: reminder.lead_name,
        company: reminder.company,
        email: reminder.email,
        mobile: reminder.phone,
        assigned: reminder.assigned,
        stage: 'Won',
      };
      customerSuccess = await ensureCustomerSuccessJourney(lead);
    }
    res.json({ success: true, paymentReminder: reminder, automation: { paymentEmailSent, customerSuccessStarted: !!customerSuccess } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CUSTOMER SUCCESS ROUTES
router.get('/customer-success', async (req, res) => {
  try {
    await cleanupOrphanLeadRecords();
    await ensurePaymentReminderTable();
    await ensureCustomerSuccessTable();

    const { rows: paidLeads } = await pool.query(
      `SELECT DISTINCT ON (l.id) l.*
       FROM crm_leads l
       JOIN crm_payment_reminders pr ON (pr.lead_id IS NOT NULL AND pr.lead_id = l.id::text) OR pr.lead_name = l.name
       WHERE l.stage='Won' AND pr.current_stage='Payment Received'
       ORDER BY l.id, pr.updated_at DESC NULLS LAST, pr.id DESC`
    );

    for (const lead of paidLeads) {
      await pool.query(
        `UPDATE crm_payment_reminders
         SET status='Completed', paid_at=COALESCE(paid_at, NOW()), updated_at=NOW()
         WHERE current_stage='Payment Received'
           AND status <> 'Completed'
           AND ((lead_id IS NOT NULL AND lead_id=$1) OR lead_name=$2)`,
        [String(lead.id), lead.name]
      );
      await ensureCustomerSuccessJourney(lead);
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (cs.id) cs.*
       FROM crm_customer_success cs
       JOIN crm_leads l ON (cs.lead_id IS NOT NULL AND cs.lead_id = l.id::text) OR cs.lead_name = l.name
       JOIN crm_payment_reminders pr ON (pr.lead_id IS NOT NULL AND pr.lead_id = l.id::text) OR pr.lead_name = l.name
       WHERE l.stage='Won' AND pr.status='Completed'
       ORDER BY cs.id, cs.updated_at DESC`
    );
    res.json({ success: true, customerSuccess: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/customer-success/from-lead/:leadId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_leads WHERE id=$1', [req.params.leadId]);
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.stage !== 'Won') return res.status(400).json({ error: 'Customer Success can be created only for leads in Won stage.' });
    const paid = await pool.query(
      `SELECT id FROM crm_payment_reminders
       WHERE status='Completed' AND ((lead_id IS NOT NULL AND lead_id=$1) OR lead_name=$2)
       LIMIT 1`,
      [String(lead.id), lead.name]
    );
    if (!paid.rows.length) return res.status(400).json({ error: 'Customer Success starts only after payment is received.' });
    const journey = await ensureCustomerSuccessJourney(lead);
    res.json({ success: true, customerSuccess: journey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/customer-success/:id', async (req, res) => {
  try {
    await ensureCustomerSuccessTable();
    const { currentStage, current_stage, status, notes, assigned, dueDate, due_date } = req.body;
    const stage = currentStage || current_stage || CUSTOMER_SUCCESS_STAGES[0];
    const current = await pool.query('SELECT * FROM crm_customer_success WHERE id=$1', [req.params.id]);
    const existing = current.rows[0];
    if (!existing) return res.status(404).json({ error: 'Customer success record not found' });

    const stageChanged = existing.current_stage !== stage;
    const history = Array.isArray(existing.stage_history) ? existing.stage_history : [];
    const nextHistory = !stageChanged
      ? history
      : [...history, { stage, date: new Date().toISOString(), note: 'Stage updated manually.' }];
    const isCompletedStage = stage === CUSTOMER_SUCCESS_STAGES[CUSTOMER_SUCCESS_STAGES.length - 1];
    const nextStatus = status || (isCompletedStage ? 'Completed' : 'Active');
    const completedAt = isCompletedStage ? 'NOW()' : 'NULL';

    const { rows } = await pool.query(
      `UPDATE crm_customer_success SET
        current_stage=$1, status=$2, notes=$3, assigned=$4, due_date=$5,
        stage_history=$6, completed_at=${completedAt}, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [stage, nextStatus, notes ?? existing.notes, assigned || existing.assigned, dueDate || due_date || existing.due_date, jsonValue(nextHistory, []), req.params.id]
    );
    const customerEmailSent = stageChanged ? await sendCustomerSuccessStageEmail(rows[0], stage) : false;
    res.json({ success: true, customerSuccess: rows[0], automation: { customerEmailSent } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// DASHBOARD STATS ROUTE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
router.get('/dashboard/stats', async (req, res) => {
  try {
    await cleanupOrphanLeadRecords();
    const [leads, followups, proposals] = await Promise.all([
      pool.query('SELECT stage, converted FROM crm_leads'),
      pool.query('SELECT status FROM crm_followups'),
      pool.query('SELECT status, value FROM crm_proposals'),
    ]);
    res.json({ success: true, leads: leads.rows, followups: followups.rows, proposals: proposals.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

let proposalAutomationRunning = false;
const runProposalAutomationCycle = async () => {
  if (proposalAutomationRunning) return;
  proposalAutomationRunning = true;
  try {
    await processProposalEngagements();
  } catch (err) {
    console.error('proposal engagement automation failed:', err.message);
  } finally {
    proposalAutomationRunning = false;
  }
};

if (process.env.NODE_ENV !== 'test') {
  const intervalMinutes = Math.max(1, Number(process.env.PROPOSAL_AUTOMATION_INTERVAL_MINUTES) || 15);
  setTimeout(runProposalAutomationCycle, 10000);
  setInterval(runProposalAutomationCycle, intervalMinutes * 60 * 1000);
}

module.exports = router;

























