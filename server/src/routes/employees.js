const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/employees
router.get('/', (req, res) => {
  try {
    const { department } = req.query;
    let employees;
    if (department) {
      employees = db.prepare('SELECT * FROM employees WHERE department = ?').all(department);
    } else {
      employees = db.prepare('SELECT * FROM employees').all();
    }
    res.json({ success: true, data: employees });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/employees/:id
router.get('/:id', (req, res) => {
  try {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee not found' });
    res.json({ success: true, data: employee });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/employees
router.post('/', (req, res) => {
  try {
    const { name, email, department, role, hire_date } = req.body;
    if (!name || !email || !department || !role || !hire_date) {
      return res.status(400).json({ success: false, error: 'Missing required fields: name, email, department, role, hire_date' });
    }
    const stmt = db.prepare('INSERT INTO employees (name, email, department, role, hire_date) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(name, email, department, role, hire_date);
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: employee });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/employees/:id
router.put('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Employee not found' });

    const { name, email, department, role, hire_date } = req.body;
    if (!name || !email || !department || !role || !hire_date) {
      return res.status(400).json({ success: false, error: 'Missing required fields: name, email, department, role, hire_date' });
    }
    db.prepare('UPDATE employees SET name=?, email=?, department=?, role=?, hire_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(name, email, department, role, hire_date, req.params.id);
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: employee });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/employees/:id
router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Employee not found' });
    db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
    res.json({ success: true, data: { message: 'Employee deleted successfully' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
