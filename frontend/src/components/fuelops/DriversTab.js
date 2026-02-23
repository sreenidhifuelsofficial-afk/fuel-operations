import React, { useState } from 'react';
import { safeJson } from './utils';

function DriverCreate({ token, onCreated, perms }) {
  const permsProvided = !!perms;
  const canCreateDrivers = permsProvided ? !!perms?.actions?.['FuelOps.create_drivers'] : true;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!canCreateDrivers) { alert('Not allowed'); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/fuel-ops/drivers', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ name, phone, driver_id: code }) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed to create driver');
      onCreated && onCreated(data);
      setName(''); setPhone(''); setCode('');
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }
  return (
    <div className="card" style={{ padding: 16, maxWidth: 800 }}>
      <div className="fo-grid-auto">
        <input placeholder="Driver name" value={name} onChange={e=>setName(e.target.value)} style={{ padding: 8 }} />
        <input placeholder="Phone" value={phone} onChange={e=>setPhone(e.target.value)} style={{ padding: 8 }} />
        <input placeholder="Driver ID" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} style={{ padding: 8 }} />
        <button className="btn" disabled={saving || !name || !code || !canCreateDrivers} onClick={save}>{saving? 'Saving…':'Save'}</button>
      </div>
    </div>
  );
}

function DriversList({ token, drivers, setDrivers, perms }) {
  return (
    <div className="card" style={{ padding: 16, marginTop: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Drivers</div>
      <div className="table-wrap fo-table-responsive">
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ textAlign:'left' }}>
              <th>Driver ID</th>
              <th>Name</th>
              <th>Phone</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map(d => (
              <DriverRow
                key={d.id}
                token={token}
                row={d}
                perms={perms}
                onUpdated={(nd)=> setDrivers(xs => xs.map(x => x.id===nd.id? nd : x))}
                onDeleted={(id)=> setDrivers(xs => xs.filter(x => String(x.id) !== String(id)))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DriverRow({ token, row, onUpdated, onDeleted, perms }) {
  const permsProvided = !!perms;
  const canEditDrivers = permsProvided ? !!perms?.actions?.['FuelOps.edit_drivers'] : true;
  const canDeleteDrivers = permsProvided ? !!perms?.actions?.['FuelOps.delete_drivers'] : true;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: row.name || '', phone: row.phone || '', driver_id: row.driver_id || '', active: !!row.active });
  async function save() {
    if (!canEditDrivers) { alert('Not allowed'); return; }
    try {
      const r = await fetch(`/api/fuel-ops/drivers/${row.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(form) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed to update driver');
      onUpdated && onUpdated(data); setEditing(false);
    } catch (e) { alert(e.message); }
  }
  async function doDelete() {
    if (!canDeleteDrivers) { alert('Not allowed'); return; }
    try {
      if (!window.confirm(`Delete driver ${row.driver_id}? This cannot be undone.`)) return;
      const headers = { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
      const r = await fetch(`/api/fuel-ops/drivers/${row.id}`, { method: 'DELETE', headers });
      const j = await safeJson(r).catch(()=>null);
      if (!r.ok) {
        alert((j && j.error) || 'Delete failed');
        return;
      }
      if (typeof onDeleted === 'function') onDeleted(row.id);
    } catch (e) {
      alert(String(e.message||e));
    }
  }
  if (!editing) return (
    <tr>
      <td data-label="Driver ID">{row.driver_id}</td><td data-label="Name">{row.name}</td><td data-label="Phone">{row.phone||'-'}</td><td data-label="Status">{row.active? 'Active':'Inactive'}</td>
      <td data-label="Actions"><div className="fo-actions">
        {canEditDrivers && (<button className="btn" onClick={()=>setEditing(true)}>Edit</button>)}
        {canDeleteDrivers && (<button className="btn ghost" onClick={doDelete}>Delete</button>)}
      </div></td>
    </tr>
  );
  return (
    <tr>
      <td data-label="Driver ID"><input value={form.driver_id} onChange={e=>setForm({...form, driver_id:e.target.value})} style={{width:'100%',padding:6}} /></td>
      <td data-label="Name"><input value={form.name} onChange={e=>setForm({...form, name:e.target.value})} style={{width:'100%',padding:6}} /></td>
      <td data-label="Phone"><input value={form.phone} onChange={e=>setForm({...form, phone:e.target.value})} style={{width:'100%',padding:6}} /></td>
      <td data-label="Status">
        <select value={form.active? '1':'0'} onChange={e=>setForm({...form, active: e.target.value==='1'})} style={{padding:6}}>
          <option value="1">Active</option>
          <option value="0">Inactive</option>
        </select>
      </td>
      <td data-label="Actions"><div className="fo-actions">
        <button className="btn" onClick={save} disabled={!canEditDrivers}>Save</button>
        <button className="btn ghost" onClick={()=>{ setEditing(false); setForm({ name: row.name || '', phone: row.phone || '', driver_id: row.driver_id || '', active: !!row.active }); }}>Cancel</button>
      </div></td>
    </tr>
  );
}

// Helper: robust JSON parsing with nice HTML error surface

export default function DriversSection({ token, drivers, setDrivers, perms }) {
  return (
    <>
      {(perms?.actions?.['FuelOps.create_drivers'] ?? true) && (
        <>
          <h3 style={{ margin: '12px 0', fontSize: 16 }}>Create Driver</h3>
          <DriverCreate token={token} perms={perms} onCreated={(d)=> setDrivers(ds=>[...ds, d])} />
        </>
      )}
      <DriversList token={token} drivers={drivers} setDrivers={setDrivers} perms={perms} />
    </>
  );
}