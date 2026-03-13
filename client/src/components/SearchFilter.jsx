function SearchFilter({ department, onChange }) {
  const departments = ['', 'Engineering', 'HR', 'Finance', 'Marketing', 'Sales', 'Operations']
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ fontWeight: 500, fontSize: 14 }}>Filter by Department:</label>
      <select
        value={department}
        onChange={(e) => onChange(e.target.value)}
        style={{ padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 14 }}
      >
        {departments.map(d => (
          <option key={d} value={d}>{d || 'All Departments'}</option>
        ))}
      </select>
    </div>
  )
}

export default SearchFilter
