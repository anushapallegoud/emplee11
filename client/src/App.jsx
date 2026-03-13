import { useState, useEffect } from 'react'
import EmployeeList from './components/EmployeeList'
import EmployeeForm from './components/EmployeeForm'
import SearchFilter from './components/SearchFilter'

const API_URL = 'http://localhost:5000/api'

function App() {
  const [employees, setEmployees] = useState([])
  const [editingEmployee, setEditingEmployee] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [department, setDepartment] = useState('')
  const [error, setError] = useState('')

  const fetchEmployees = async (dept = '') => {
    try {
      const url = dept ? `${API_URL}/employees?department=${encodeURIComponent(dept)}` : `${API_URL}/employees`
      const res = await fetch(url)
      const json = await res.json()
      if (json.success) setEmployees(json.data)
      else setError(json.error)
    } catch (e) {
      setError('Failed to fetch employees')
    }
  }

  useEffect(() => {
    fetchEmployees(department)
  }, [department])

  const handleSave = async (formData) => {
    try {
      const method = editingEmployee ? 'PUT' : 'POST'
      const url = editingEmployee ? `${API_URL}/employees/${editingEmployee.id}` : `${API_URL}/employees`
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      const json = await res.json()
      if (json.success) {
        setShowForm(false)
        setEditingEmployee(null)
        fetchEmployees(department)
      } else {
        setError(json.error)
      }
    } catch (e) {
      setError('Failed to save employee')
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this employee?')) return
    try {
      const res = await fetch(`${API_URL}/employees/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (json.success) fetchEmployees(department)
      else setError(json.error)
    } catch (e) {
      setError('Failed to delete employee')
    }
  }

  const handleEdit = (employee) => {
    setEditingEmployee(employee)
    setShowForm(true)
  }

  const handleAdd = () => {
    setEditingEmployee(null)
    setShowForm(true)
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingEmployee(null)
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px', fontFamily: 'sans-serif' }}>
      <h1 style={{ marginBottom: 24 }}>Employee Management System</h1>
      {error && (
        <div style={{ background: '#fee', border: '1px solid #f99', padding: 12, marginBottom: 16, borderRadius: 4 }}>
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: 12 }}>✕</button>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SearchFilter department={department} onChange={setDepartment} />
        <button onClick={handleAdd} style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          + Add Employee
        </button>
      </div>
      {showForm && (
        <EmployeeForm
          employee={editingEmployee}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}
      <EmployeeList employees={employees} onEdit={handleEdit} onDelete={handleDelete} />
    </div>
  )
}

export default App
