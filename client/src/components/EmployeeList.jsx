function EmployeeList({ employees, onEdit, onDelete }) {
  if (employees.length === 0) {
    return <p style={{ color: '#888', textAlign: 'center', padding: 32 }}>No employees found.</p>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ background: '#f1f5f9' }}>
            {['ID', 'Name', 'Email', 'Department', 'Role', 'Hire Date', 'Actions'].map(h => (
              <th key={h} style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {employees.map(emp => (
            <tr key={emp.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
              <td style={{ padding: '10px 12px' }}>{emp.id}</td>
              <td style={{ padding: '10px 12px' }}>{emp.name}</td>
              <td style={{ padding: '10px 12px' }}>{emp.email}</td>
              <td style={{ padding: '10px 12px' }}>{emp.department}</td>
              <td style={{ padding: '10px 12px' }}>{emp.role}</td>
              <td style={{ padding: '10px 12px' }}>{emp.hire_date}</td>
              <td style={{ padding: '10px 12px' }}>
                <button onClick={() => onEdit(emp)} style={{ marginRight: 8, padding: '4px 10px', background: '#059669', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}>Edit</button>
                <button onClick={() => onDelete(emp.id)} style={{ padding: '4px 10px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default EmployeeList
