const express = require('express');
const pool = require('../config/database');
const authenticateToken = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');

const router = express.Router();

router.get('/', authenticateToken, requirePermission('Roles', 'View role'), async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.role_name, r.description, r.deletable, r.created_at, r.updated_at,
        COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', p.id, 'group_name', p.group_name, 'name', p.name)
          ORDER BY p.group_name, p.name) FILTER (WHERE p.id IS NOT NULL), '[]'::json) AS permissions
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id=r.id
      LEFT JOIN permissions p ON p.id=rp.permission_id
      GROUP BY r.id ORDER BY r.role_name
    `);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/permissions', authenticateToken, requirePermission('Roles', 'View role'), async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, group_name, name FROM permissions ORDER BY group_name, name`);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
