import { useState, useEffect } from 'react'

const emptyForm = { name: '', email: '', department: '', role: '', hire_date: '' }

function EmployeeForm({ employee, onSave, onCancel }) {
  const [form, setForm] = useState(emptyForm)

  useEffect(() => {
    if (employee) {
      setForm({
        name: employee.name || '',
        email: employee.email || '',
        department: employee.department || '',
        role: employee.role || '',
        hire_date: employee.hire_date || ''
      })
    } else {
      setForm(emptyForm)
    }
  }, [employee])

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value })

  const handleSubmit = (e) => {
    e.preventDefault()
    onSave(form)
  }

  const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 14, boxSizing: 'border-box' }
  const labelStyle = { display: 'block', marginBottom: 4, fontWeight: 500, fontSize: 13 }

  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 24, marginBottom: 24 }}>
      <h2 style={{ marginTop: 0 }}>{employee ? 'Edit Employee' : 'Add New Employee'}</h2>
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {[
            { label: 'Name', name: 'name', type: 'text' },
            { label: 'Email', name: 'email', type: 'email' },
            { label: 'Department', name: 'department', type: 'text' },
            { label: 'Role', name: 'role', type: 'text' },
            { label: 'Hire Date', name: 'hire_date', type: 'date' },
          ].map(field => (
            <div key={field.name}>
              <label style={labelStyle}>{field.label}</label>
              <input
                type={field.type}
                name={field.name}
                value={form[field.name]}
                onChange={handleChange}
                required
                style={inputStyle}
              />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 20, display: 'flex', gap: 12 }}>
          <button type="submit" style={{ padding: '8px 20px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
            {employee ? 'Update' : 'Create'}
          </button>
          <button type="button" onClick={onCancel} style={{ padding: '8px 20px', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

export default EmployeeForm
