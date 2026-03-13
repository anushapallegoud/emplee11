process.env.DB_PATH = ':memory:';
const request = require('supertest');
const app = require('../src/server');

describe('Employee API', () => {
  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/employees', () => {
    it('should return empty array initially', async () => {
      const res = await request(app).get('/api/employees');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('POST /api/employees', () => {
    it('should create a new employee', async () => {
      const res = await request(app).post('/api/employees').send({
        name: 'John Doe',
        email: 'john@example.com',
        department: 'Engineering',
        role: 'Developer',
        hire_date: '2024-01-15'
      });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('John Doe');
    });

    it('should return 400 for missing fields', async () => {
      const res = await request(app).post('/api/employees').send({ name: 'Jane' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for duplicate email', async () => {
      await request(app).post('/api/employees').send({
        name: 'Alice',
        email: 'alice@example.com',
        department: 'HR',
        role: 'Manager',
        hire_date: '2024-02-01'
      });
      const res = await request(app).post('/api/employees').send({
        name: 'Alice2',
        email: 'alice@example.com',
        department: 'HR',
        role: 'Manager',
        hire_date: '2024-02-01'
      });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/employees/:id', () => {
    it('should return 404 for non-existent employee', async () => {
      const res = await request(app).get('/api/employees/9999');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('PUT /api/employees/:id', () => {
    it('should update an employee', async () => {
      const create = await request(app).post('/api/employees').send({
        name: 'Bob',
        email: 'bob@example.com',
        department: 'Finance',
        role: 'Analyst',
        hire_date: '2024-03-01'
      });
      const id = create.body.data.id;
      const res = await request(app).put(`/api/employees/${id}`).send({
        name: 'Bob Updated',
        email: 'bob@example.com',
        department: 'Finance',
        role: 'Senior Analyst',
        hire_date: '2024-03-01'
      });
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('Senior Analyst');
    });

    it('should return 404 for non-existent employee', async () => {
      const res = await request(app).put('/api/employees/9999').send({
        name: 'X', email: 'x@x.com', department: 'X', role: 'X', hire_date: '2024-01-01'
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/employees/:id', () => {
    it('should delete an employee', async () => {
      const create = await request(app).post('/api/employees').send({
        name: 'Charlie',
        email: 'charlie@example.com',
        department: 'Marketing',
        role: 'Coordinator',
        hire_date: '2024-04-01'
      });
      const id = create.body.data.id;
      const res = await request(app).delete(`/api/employees/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent employee', async () => {
      const res = await request(app).delete('/api/employees/9999');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/employees?department=', () => {
    it('should filter by department', async () => {
      const res = await request(app).get('/api/employees?department=Engineering');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
