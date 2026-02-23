import React, { useState } from 'react';
import { safeJson } from './utils';

function VehicleCreate({ token, onCreated, perms }) {
  const permsProvided = !!perms;
  const canCreateVehicles = permsProvided ? !!perms?.actions?.['FuelOps.create_vehicles_storage_info'] : true;
  const [type, setType] = useState('TRUCK');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [code, setCode] = useState('');
  const [capacity, setCapacity] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!canCreateVehicles) { alert('Not allowed'); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/fuel-ops/storage-units', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ unit_type: type, unit_code: code, capacity_liters: parseInt(capacity,10), vehicle_number: vehicleNumber }) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed to create vehicle');
      onCreated && onCreated(data);
      setVehicleNumber(''); setCode(''); setCapacity('');
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }
  return (
    <div className="card" style={{ padding: 16, maxWidth: 800 }}>
      <div className="fo-grid-auto">
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Type
          <select value={type} onChange={e=>setType(e.target.value)} style={{ padding: 8 }}>
            <option value="TRUCK">Vehicle</option>
            <option value="DATUM">DATUM</option>
            <option value="STORAGE">Other Storage</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Vehicle No.
          <input value={vehicleNumber} onChange={e=>setVehicleNumber(e.target.value)} placeholder="e.g., AP09 AB 1234" style={{ padding: 8 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Vehicle Code
          <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="e.g., 4T1" style={{ padding: 8 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Capacity (L)
          <input type="number" min={1} step={1} value={capacity} onChange={e=>setCapacity(e.target.value)} placeholder="e.g., 4000" style={{ padding: 8 }} />
        </label>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button className="btn" disabled={saving || !code || !capacity || !canCreateVehicles} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function VehicleRow({ token, unit, onUpdated, onDeleted, perms }) {
  const permsProvided = !!perms;
  const canEditVehiclesInfo = permsProvided ? !!perms?.actions?.['FuelOps.edit_vehicles_storage_info'] : true;
  const canDeleteVehiclesInfo = permsProvided ? !!perms?.actions?.['FuelOps.delete_vehicles_storage_info'] : true;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ vehicle_number: unit.vehicle_number || '', unit_code: unit.unit_code || '', capacity_liters: unit.capacity_liters || '', active: !!unit.active });
  async function save() {
    if (!canEditVehiclesInfo) { alert('Not allowed'); return; }
    try {
      const r = await fetch(`/api/fuel-ops/storage-units/${unit.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(form) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed to update');
      onUpdated && onUpdated(data); setEditing(false);
    } catch (e) { alert(e.message); }
  }
  async function doDelete() {
    if (!canDeleteVehiclesInfo) { alert('Not allowed'); return; }
    try {
      if (!window.confirm(`Delete ${unit.unit_code}? This cannot be undone.`)) return;
      const headers = { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
      const r = await fetch(`/api/fuel-ops/storage-units/${unit.id}`, { method: 'DELETE', headers });
      const j = await safeJson(r).catch(()=>null);
      if (!r.ok) {
        alert((j && j.error) || 'Delete failed');
        return;
      }
      if (typeof onDeleted === 'function') onDeleted(unit.id);
    } catch (e) { alert(String(e.message||e)); }
  }
  if (!editing) return (
    <tr>
      <td data-label="Code">{unit.unit_code}</td>
      <td data-label="Vehicle No">{unit.vehicle_number || unit.vehicle_no || '-'}</td>
      <td data-label="Capacity (L)">{unit.capacity_liters}</td>
      <td data-label="Status">{unit.active? 'Active':'Inactive'}</td>
      <td data-label="Actions"><div className="fo-actions">
        {canEditVehiclesInfo && (<button className="btn" onClick={()=>setEditing(true)}>Edit</button>)}
        {canDeleteVehiclesInfo && (<button className="btn ghost" onClick={doDelete}>Delete</button>)}
      </div></td>
    </tr>
  );
  return (
    <tr>
      <td data-label="Code"><input value={form.unit_code} onChange={e=>setForm({...form, unit_code:e.target.value})} style={{width:'100%',padding:6}} /></td>
      <td data-label="Vehicle No"><input value={form.vehicle_number} onChange={e=>setForm({...form, vehicle_number:e.target.value})} style={{width:'100%',padding:6}} /></td>
      <td data-label="Capacity (L)"><input type="number" min={1} step={1} value={form.capacity_liters} onChange={e=>setForm({...form, capacity_liters:e.target.value})} style={{width:'100%',padding:6}} /></td>
      <td data-label="Status">
        <select value={form.active? '1':'0'} onChange={e=>setForm({...form, active: e.target.value==='1'})} style={{padding:6}}>
          <option value="1">Active</option>
          <option value="0">Inactive</option>
        </select>
      </td>
      <td data-label="Actions"><div className="fo-actions">
        <button className="btn" onClick={save} disabled={!canEditVehiclesInfo}>Save</button>
        <button className="btn ghost" onClick={()=>{ setEditing(false); setForm({ vehicle_number: unit.vehicle_number || '', unit_code: unit.unit_code || '', capacity_liters: unit.capacity_liters || '', active: !!unit.active }); }}>Cancel</button>
      </div></td>
    </tr>
  );
}

export default function VehiclesStorageSection({ token, units, datums, setUnits, setDatums, perms }) {
  return (
    <>
      {(perms?.actions?.['FuelOps.create_vehicles_storage_info'] ?? true) && (
        <>
          <h3 style={{ margin: '12px 0', fontSize: 16 }}>Create Vehicle</h3>
          <VehicleCreate
            token={token}
            perms={perms}
            onCreated={(v)=> {
              // Route created unit to the correct list
              if (v && v.unit_type === 'DATUM') setDatums(xs => [...xs, v]);
              else setUnits(xs => [...xs, v]);
            }}
          />
        </>
      )}
      <div className="card" style={{ padding: 16, marginTop: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Vehicles</div>
        <div className="table-wrap fo-table-responsive">
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ textAlign:'left' }}>
                <th>Code</th><th>Vehicle No</th><th>Capacity (L)</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {units.map(u => (
                <VehicleRow
                  key={u.id}
                  token={token}
                  unit={u}
                  perms={perms}
                  onUpdated={(nu)=> setUnits(xs=> xs.map(x=>x.id===nu.id? nu : x))}
                  onDeleted={(id)=> setUnits(xs => xs.filter(x => String(x.id) !== String(id)))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
          <div className="card" style={{ padding: 16, marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>DATUMS and other storages</div>
            <div className="table-wrap fo-table-responsive">
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr style={{ textAlign:'left' }}>
                    <th>Code</th><th>Vehicle No</th><th>Capacity (L)</th><th>Status</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {datums.map(u => (
                    <VehicleRow
                      key={u.id}
                      token={token}
                      unit={u}
                      perms={perms}
                      onUpdated={(nu)=> setDatums(xs=> xs.map(x=>x.id===nu.id? nu : x))}
                      onDeleted={(id)=> setDatums(xs => xs.filter(x => String(x.id) !== String(id)))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
    </>
  );
}