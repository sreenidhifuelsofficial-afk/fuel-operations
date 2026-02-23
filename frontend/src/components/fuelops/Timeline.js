import React, { useEffect, useMemo, useState } from 'react';
import SortIcon from '../SortIcon';
import { fmtDateInput, fmtDateInputValue, parseWallClockDate, formatTimeForInput, parseLiters3, safeJson } from './utils';

export default function Timeline({ token, dayOps, units, datums, onChanged, perms, allowXferOutActions = false, locked = false }) {
  const permsProvided = !!perms;
  const canEditAtDepot = permsProvided ? !!perms?.actions?.['FuelOps.edit_at_depot'] : true;
  const canDeleteAtDepot = permsProvided ? !!perms?.actions?.['FuelOps.delete_at_depot'] : true;
  const [editing, setEditing] = useState({ kind: null, id: null });
  const [form, setForm] = useState({ volume: '', toVehicle: '', toUnitId: '', time: '' });
  const [tableSort, setTableSort] = useState({ key: 'time', dir: 'asc' }); // key: 'time'|'type'

  useEffect(() => {
    if (!locked) return;
    setEditing({ kind: null, id: null });
    setForm({ volume: '', toVehicle: '', toUnitId: '', time: '' });
  }, [locked]);
  const list = useMemo(() => {
    const rows = [];
    // Loads intentionally excluded from timeline view (displayed separately above)
    (dayOps.sales||[]).forEach(r => rows.push({ id:r.id, kind:'SALE', ts:r.performed_at? parseWallClockDate(r.performed_at) : (r.sale_date? parseWallClockDate(r.sale_date) : null), data:r }));
    (dayOps.transfers_out||[]).forEach(r => {
      // Use transfer_date + transfer_time if available
      let ts = null;
      if (r.transfer_date && r.transfer_time) {
        ts = parseWallClockDate(`${fmtDateInputValue(r.transfer_date)} ${String(r.transfer_time).slice(0,8)}`);
      } else if (r.performed_at) {
        ts = parseWallClockDate(r.performed_at);
      } else if (r.transfer_date) {
        ts = parseWallClockDate(r.transfer_date);
      }
      rows.push({ id:r.id, kind:'XFER_OUT', ts, data:r });
    });
    (dayOps.transfers_in||[]).forEach(r => {
      let ts = null;
      if (r.transfer_date && r.transfer_time) {
        ts = parseWallClockDate(`${fmtDateInputValue(r.transfer_date)} ${String(r.transfer_time).slice(0,8)}`);
      } else if (r.performed_at) {
        ts = parseWallClockDate(r.performed_at);
      } else if (r.transfer_date) {
        ts = parseWallClockDate(r.transfer_date);
      }
      rows.push({ id:r.id, kind:'XFER_IN', ts, data:r });
    });
    (dayOps.testing||[]).forEach(r => rows.push({ id:r.id, kind:'TEST', ts:r.performed_at? parseWallClockDate(r.performed_at) : null, data:r }));
    const sorted = [...rows];
    if (tableSort.key === 'time') {
      sorted.sort((a,b) => {
        const va = a.ts?.getTime() || 0;
        const vb = b.ts?.getTime() || 0;
        return tableSort.dir === 'asc' ? (va - vb) : (vb - va);
      });
    } else if (tableSort.key === 'type') {
      sorted.sort((a,b) => {
        const cmp = a.kind.localeCompare(b.kind);
        if (cmp !== 0) return tableSort.dir === 'asc' ? cmp : -cmp;
        const va = a.ts?.getTime() || 0;
        const vb = b.ts?.getTime() || 0;
        return tableSort.dir === 'asc' ? (va - vb) : (vb - va);
      });
    }
    return sorted;
  }, [dayOps, tableSort.key, tableSort.dir]);

  async function del(kind, id) {
    if (locked) { alert('Locked until a Trip is created'); return; }
    if (!canDeleteAtDepot) { alert('Not allowed'); return; }
    if (kind === 'XFER_IN') { alert('Not allowed'); return; }
    if (kind === 'XFER_OUT' && !allowXferOutActions) { alert('Not allowed'); return; }
    const ok = window.confirm('Delete this record?');
    if (!ok) return;
    const headers = { Accept:'application/json' };
    const auth = localStorage.getItem('authToken');
    if (auth) headers.Authorization = 'Bearer ' + auth;
    let url;
    if (kind === 'TEST') {
      url = `/api/fuel-ops/transfers/testing/${id}`;
    } else if (kind === 'SALE') {
      url = `/api/fuel-ops/transfers/sales/${id}`;
    } else {
      url = `/api/fuel-ops/transfers/internal/${id}`;
    }
    const r = await fetch(url, { method:'DELETE', headers });
    const j = await safeJson(r);
    if (!r.ok) { alert(j.error || 'Delete failed'); return; }
    onChanged && onChanged();
  }

  async function saveEdit() {
    if (locked) { alert('Locked until a Trip is created'); return; }
    if (!canEditAtDepot) { alert('Not allowed'); return; }
    const { kind, id } = editing;
    if (kind === 'XFER_IN') { alert('Not allowed'); return; }
    if (kind === 'XFER_OUT' && !allowXferOutActions) { alert('Not allowed'); return; }
    const headers = { 'Content-Type':'application/json', Accept:'application/json' };
    const auth = localStorage.getItem('authToken');
    if (auth) headers.Authorization = 'Bearer ' + auth;
    if (kind === 'SALE') {
      const body = {};
      if (form.volume) {
        const v = parseLiters3(form.volume);
        if (v == null) { alert('Invalid volume'); return; }
        body.sale_volume_liters = v;
      }
      if (form.toVehicle) body.to_vehicle = form.toVehicle;
      if (form.time) body.performed_time = form.time; // HH:mm
      const r = await fetch(`/api/fuel-ops/transfers/sales/${id}`, { method:'PATCH', headers, body: JSON.stringify(body) });
      const j = await safeJson(r);
      if (!r.ok) { alert(j.error || 'Update failed'); return; }
    } else if (kind === 'XFER_OUT') {
      const body = {};
      if (form.volume) {
        const v = parseLiters3(form.volume);
        if (v == null) { alert('Invalid volume'); return; }
        body.transfer_volume_liters = v;
      }
      if (form.time) body.performed_time = form.time; // HH:mm
      const r = await fetch(`/api/fuel-ops/transfers/internal/${id}`, { method:'PATCH', headers, body: JSON.stringify(body) });
      const j = await safeJson(r);
      if (!r.ok) { alert(j.error || 'Update failed'); return; }
    }
    else if (kind === 'TEST') {
      const body = {};
      if (form.volume) {
        const v = parseLiters3(form.volume);
        if (v == null) { alert('Invalid volume'); return; }
        body.transfer_volume_liters = v;
      }
      if (form.time) body.performed_time = form.time; // HH:mm
      const r = await fetch(`/api/fuel-ops/transfers/testing/${id}`, { method:'PATCH', headers, body: JSON.stringify(body) });
      const j = await safeJson(r);
      if (!r.ok) { alert(j.error || 'Update failed'); return; }
    }
    setEditing({ kind:null, id:null }); setForm({ volume:'', toVehicle:'', toUnitId:'', time:'' });
    onChanged && onChanged();
  }

  return (
    <div className="table-wrap">
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead>
          <tr style={{ textAlign:'left' }}>
            <th
              style={{ cursor:'pointer' }}
              onClick={() => setTableSort(s => s.key==='time' ? { key:'time', dir: s.dir==='asc'?'desc':'asc' } : { key:'time', dir:'asc' })}
            >
              <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                Time
                <SortIcon dir={tableSort.key==='time'?tableSort.dir:undefined} active={tableSort.key==='time'} />
              </span>
            </th>
            <th
              style={{ cursor:'pointer' }}
              onClick={() => setTableSort(s => s.key==='type' ? { key:'type', dir: s.dir==='asc'?'desc':'asc' } : { key:'type', dir:'asc' })}
            >
              <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                Type
                <SortIcon dir={tableSort.key==='type'?tableSort.dir:undefined} active={tableSort.key==='type'} />
              </span>
            </th>
            <th>Details</th>
            <th>Volume (L)</th>
            <th style={{ width: 160 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {list.length===0 ? (
            <tr><td colSpan={5} style={{ color:'#6b7280', padding:8 }}>—</td></tr>
          ) : list.map(row => {
            // For internal transfers, prefer transfer_time string for display
            let t = '-';
            if (row.kind === 'XFER_OUT' || row.kind === 'XFER_IN') {
              const d = row.data;
              if (typeof d.transfer_time === 'string' && d.transfer_time) {
                // Use transfer_time directly (already in HH:mm format from backend)
                t = d.transfer_time;
              } else if (row.ts) {
                // Fallback to parsing the timestamp
                const hh = String(row.ts.getHours()).padStart(2, '0');
                const mm = String(row.ts.getMinutes()).padStart(2, '0');
                t = `${hh}:${mm}`;
              }
            } else if (row.kind === 'SALE') {
              const d = row.data;
              if (typeof d.performed_time === 'string' && d.performed_time) {
                // Use performed_time directly (already in HH:mm format from backend)
                t = d.performed_time;
              } else if (row.ts) {
                // Fallback to parsing the timestamp
                const hh = String(row.ts.getHours()).padStart(2, '0');
                const mm = String(row.ts.getMinutes()).padStart(2, '0');
                t = `${hh}:${mm}`;
              }
            } else {
              // TEST and other types
              if (row.ts) {
                const hh = String(row.ts.getHours()).padStart(2, '0');
                const mm = String(row.ts.getMinutes()).padStart(2, '0');
                t = `${hh}:${mm}`;
              }
            }
            if (editing.id === row.id && editing.kind === row.kind) {
              return (
                <tr key={row.kind+'-'+row.id}>
                  <td>
                    <input type="time" value={form.time} onChange={e=>setForm(f=>({...f, time:e.target.value}))} style={{ padding:6 }} />
                  </td>
                  <td>{row.kind}</td>
                  <td>
                    {row.kind==='SALE' && (
                      <div style={{ display:'flex', gap:8 }}>
                        <input placeholder="To Vehicle" value={form.toVehicle} onChange={e=>setForm(f=>({...f, toVehicle:e.target.value}))} style={{ padding:6 }} />
                        <input type="number" placeholder="Volume" value={form.volume} onChange={e=>setForm(f=>({...f, volume:e.target.value}))} style={{ padding:6, width:120 }} />
                      </div>
                    )}
                    {(row.kind==='XFER_OUT' || row.kind==='XFER_IN') && (
                      <div style={{ display:'flex', gap:8 }}>
                        <input type="number" placeholder="Volume" value={form.volume} onChange={e=>setForm(f=>({...f, volume:e.target.value}))} style={{ padding:6, width:120 }} />
                      </div>
                    )}
                    {row.kind==='TEST' && (
                      <div style={{ display:'flex', gap:8 }}>
                        <input type="number" placeholder="Volume" value={form.volume} onChange={e=>setForm(f=>({...f, volume:e.target.value}))} style={{ padding:6, width:120 }} />
                      </div>
                    )}
                    {row.kind==='LOAD' && (<span>Editing loads not supported</span>)}
                  </td>
                  <td>-</td>
                  <td style={{ display:'flex', gap:8 }}>
                    <button className="btn" onClick={saveEdit} disabled={locked || !canEditAtDepot}>Save</button>
                    <button className="btn ghost" onClick={()=>{ setEditing({ kind:null, id:null }); setForm({ volume:'', toVehicle:'', toUnitId:'', time:'' }); }}>Cancel</button>
                  </td>
                </tr>
              );
            }
            // non-editing row
            const d = row.data;
            let details = null;
            // Read volume from whichever shape the server returned (backwards compatibility)
            // prefer explicit *_liters names for sales/testing, and `transfer_volume` for internal transfers
            let volRaw = null;
            if (row.kind==='SALE') { details = (<span>{d.to_vehicle}</span>); volRaw = d.sale_volume_liters ?? d.sale_volume; }
            if (row.kind==='XFER_OUT') { details = (<span>To {d.to_unit_code}</span>); volRaw = d.transfer_volume ?? d.transfer_volume_liters ?? d.volume_liters; }
            if (row.kind==='XFER_IN') { details = (<span>From {d.from_unit_code}</span>); volRaw = d.transfer_volume ?? d.transfer_volume_liters ?? d.volume_liters; }
            if (row.kind==='TEST') { details = (<span>{d.to_vehicle ? `Testing · ${d.to_vehicle}` : 'Testing'}</span>); volRaw = d.transfer_volume_liters ?? d.transfer_volume ?? d.testing_volume_liters ?? d.testing_volume; }
            const vol = (volRaw != null) ? volRaw : '—';
            const xferOutTrip = row.kind === 'XFER_OUT' ? (Number(d && d.trip) || 0) : 0;
            const canActOnXferOut = row.kind === 'XFER_OUT' ? (allowXferOutActions && xferOutTrip > 0) : false;
            return (
              <tr key={row.kind+'-'+row.id}>
                <td>{t}</td>
                <td>{row.kind}</td>
                <td>{details}</td>
                <td>{vol}</td>
                <td style={{ display:'flex', gap:8 }}>
                  {!locked && row.kind !== 'LOAD' && row.kind !== 'XFER_IN' && (
                    (row.kind !== 'XFER_OUT' || canActOnXferOut) && (
                      <>
                        {canEditAtDepot && (
                          <button className="btn ghost" onClick={()=>{ const hh = row.ts? String(row.ts.getHours()).padStart(2,'0') : ''; const mm = row.ts? String(row.ts.getMinutes()).padStart(2,'0') : ''; const timeVal = d.performed_at ? formatTimeForInput(d.performed_at) : ((hh&&mm)? `${hh}:${mm}` : ''); setEditing({ kind:row.kind, id:row.id }); setForm({ volume: volRaw != null ? String(volRaw) : '', toVehicle: d.to_vehicle || '', toUnitId: d.to_unit_id ? String(d.to_unit_id) : '', time: timeVal }); }}>Edit</button>
                        )}
                        {canDeleteAtDepot && (
                          <button className="btn ghost" onClick={()=>del(row.kind, row.id)}>Delete</button>
                        )}
                      </>
                    )
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// eslint-disable-next-line no-unused-vars
function exportTimelineCsv(rows) {
  try {
    // eslint-disable-next-line no-unused-vars
    const auth = localStorage.getItem('authToken');
    const header = ['Time','Type','Details','Volume'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const tsStr = r.ts ? `${String(r.ts.getHours()).padStart(2,'0')}:${String(r.ts.getMinutes()).padStart(2,'0')}` : '';
      let details=''; let volume='';
      const d = r.data;
      if (r.kind==='SALE') { details = `${d.to_vehicle||''}`; volume = d.sale_volume_liters||''; }
      else if (r.kind==='XFER_OUT' || r.kind==='XFER_IN') { details = `${d.from_unit_code||''}->${d.to_unit_code||''}`; volume = d.transfer_volume_liters || d.transfer_volume || ''; }
      else if (r.kind==='TEST') { details = 'TESTING'; volume = d.transfer_volume_liters || ''; }
      const rowVals = [tsStr, r.kind, details, volume].map(v=> { const s=String(v||''); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; });
      lines.push(rowVals.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download=`timeline_${Date.now()}.csv`; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },800);
  } catch(e) { alert(String(e.message||e)); }
}
// eslint-disable-next-line no-unused-vars
function printTimeline(rows) {
  try {
    const html = `<!DOCTYPE html><html><head><title>Timeline</title><style>body{font-family:Arial;padding:16px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left} th{background:#f9fafb}</style></head><body><h3>Timeline</h3><table><thead><tr><th>Time</th><th>Type</th><th>Details</th><th>Volume (L)</th></tr></thead><tbody>${rows.map(r=>{const tsStr=r.ts?`${String(r.ts.getHours()).padStart(2,'0')}:${String(r.ts.getMinutes()).padStart(2,'0')}`:'';let details='';let volume='';const d=r.data;if(r.kind==='SALE'){details=d.to_vehicle||'';volume=d.sale_volume_liters||'';}else if(r.kind==='XFER_OUT'||r.kind==='XFER_IN'){details=`${d.from_unit_code||''}->${d.to_unit_code||''}`;volume=d.transfer_volume_liters||d.transfer_volume||'';}else if(r.kind==='TEST'){details='TESTING';volume=d.transfer_volume_liters||'';} return `<tr><td>${tsStr}</td><td>${r.kind}</td><td>${details}</td><td>${volume}</td></tr>`}).join('')}</tbody></table><script>window.print();</script></body></html>`;
    const w = window.open('', '_blank'); if (w){ w.document.write(html); w.document.close(); }
  } catch(e) { alert(String(e.message||e)); }
}
// Purchase (lot creation) section + list