import React, { useEffect, useMemo, useState } from 'react';
import SortIcon from '../SortIcon';
import { parseWallClockDate, formatWallClockDateDisplay, formatWallClockTimeDisplay, formatWallClockDateTimeDisplay, safeJson } from './utils';

export default function PurchaseSection({ token, units, unitId, setUnitId, loadDate, setLoadDate, liters, setLiters, preview, message, setMessage, submitting, onCreateLot, setPreview, refreshStock, datums, purchaseTime, setPurchaseTime }) {
  const [listLoading, setListLoading] = useState(false);
  const [lotsList, setLotsList] = useState([]);
  const [filterUnit, setFilterUnit] = useState('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [lotsSort, setLotsSort] = useState({ key: 'created_at', dir: 'desc' });
  const [showConfirm, setShowConfirm] = useState(false);
  // For purchase display, restrict to trucks only
  const truckUnits = units;
  // Initialize filter default to ALL
  useEffect(() => { if (!filterUnit) setFilterUnit('ALL'); }, []);
  // Load list when filter or token changes
  useEffect(() => { (async () => { await reloadLots(); })(); }, [filterUnit, token]);
  async function reloadLots() {
    setListLoading(true);
    try {
      const base = '/api/fuel-ops/lots/list';
      const params = new URLSearchParams();
      params.set('load_type','PURCHASE');
      params.set('limit','500');
      if (!filterUnit || filterUnit === 'ALL') {
        params.set('unit_type','TRUCK');
      } else {
        params.set('unit_id', String(filterUnit));
      }
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      // Keep server default order; client-side header sorting will be applied below
      const url = `${base}?${params.toString()}`;
      const r = await fetch(url, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
      const data = await safeJson(r);
      setLotsList((data && data.items) ? data.items : []);
    } catch { setLotsList([]); } finally { setListLoading(false); }
  }
  // After create lot refresh list
  useEffect(() => { if (message && message.startsWith('Created')) { reloadLots(); try { if (typeof refreshStock==='function') refreshStock(); } catch {} } }, [message]);
  // Compose selected unit label for confirmation
  const selectedUnit = useMemo(() => {
    try {
      const all = [...(units||[]), ...(datums||[])];
      const row = all.find(u => String(u.id) === String(unitId));
      if (!row) return null;
      const kind = row.unit_type === 'DATUM' ? 'DATUM' : 'Tanker';
      const label = `${kind} · ${row.unit_code}${row.vehicle_number ? ` · ${row.vehicle_number}` : ''}`;
      return { ...row, label };
    } catch { return null; }
  }, [units, datums, unitId]);
  // Confirm handler invokes create only after user approval
  async function confirmCreate() {
    try {
      // Call upstream create without a real event
      await onCreateLot({ preventDefault: () => {} });
    } finally {
      setShowConfirm(false);
    }
  }
  return (
    <div className="card" style={{ padding: 16, maxWidth: 900 }}>
      <div className="fo-grid-2">
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Tanker / Storage
          <select value={unitId} onChange={e => setUnitId(e.target.value)} style={{ padding: 8 }}>
            {[...units, ...datums].map(u => (<option key={u.id} value={u.id}>{u.unit_type==='DATUM'?'DATUM':'Tanker'} · {u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}</option>))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Load date
          <input type="date" value={loadDate} onChange={e => setLoadDate(e.target.value)} style={{ padding: 8 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Loaded liters
          <input type="number" min={0} step={0.001} value={liters} onChange={e => setLiters(e.target.value)} placeholder="e.g., 3400.000" style={{ padding: 8 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Load time (optional)
          <input type="time" value={purchaseTime} onChange={e=> setPurchaseTime(e.target.value)} style={{ padding:8 }} />
        </label>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button className="btn" onClick={() => setShowConfirm(true)} disabled={submitting || !unitId || !loadDate || !liters}>{submitting ? 'Creating…' : 'Create Lot'}</button>
        </div>
      </div>
      {showConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div className="card" style={{ padding:16, width:420, background:'#fff', boxShadow:'0 10px 30px rgba(0,0,0,0.2)' }}>
            <div style={{ fontWeight:700, marginBottom:8 }}>Confirm Lot Creation</div>
            <div style={{ fontSize:13, color:'#374151', lineHeight:1.6 }}>
              <div><span style={{ color:'#6b7280' }}>Tanker / Storage:</span> <span style={{ fontWeight:600 }}>{selectedUnit ? selectedUnit.label : '-'}</span></div>
              <div><span style={{ color:'#6b7280' }}>Load date:</span> <span style={{ fontWeight:600 }}>{loadDate || '-'}</span></div>
              <div><span style={{ color:'#6b7280' }}>Loaded liters:</span> <span style={{ fontWeight:600 }}>{liters || '-'}</span></div>
              <div><span style={{ color:'#6b7280' }}>Load time:</span> <span style={{ fontWeight:600 }}>{purchaseTime ? purchaseTime : '—'}</span></div>
              {preview && preview.lot_code && (
                <div style={{ marginTop:6 }}><span style={{ color:'#6b7280' }}>Lot code (preview):</span> <span style={{ fontWeight:600 }}>{preview.lot_code}</span></div>
              )}
              {typeof preview?.seq_index === 'number' && (
                <div style={{ color:'#6b7280', fontSize:12 }}>Seq #{preview.seq_index}</div>
              )}
            </div>
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:12 }}>
              <button className="btn ghost" onClick={() => setShowConfirm(false)} disabled={submitting}>Cancel</button>
              <button className="btn" onClick={confirmCreate} disabled={submitting}>{submitting ? 'Creating…' : 'Confirm & Create'}</button>
            </div>
          </div>
        </div>
      )}
      {preview && (
        <div style={{ marginTop: 12, fontSize: 14 }}>
          Preview: <span style={{ fontWeight: 600 }}>{preview.lot_code}</span>
          {typeof preview.seq_index === 'number' && (<span style={{ color: '#6b7280' }}> · Seq #{preview.seq_index}</span>)}
        </div>
      )}
      {message && (<div style={{ marginTop: 12, color: message.startsWith('Created') ? '#065f46' : '#b91c1c' }}>{message}</div>)}
      <div style={{ marginTop: 12, color: '#6b7280', fontSize: 12 }}>Lot format: LOTDDMONYY[UnitCode][SeqLetters][Loaded]</div>
      <div style={{ marginTop:24, paddingTop:12, borderTop:'1px solid #eee' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:12 }}>
          <div style={{ fontWeight:600 }}>Recent lots</div>
          <div className="fo-filter-bar">
            <select value={filterUnit} onChange={e=>setFilterUnit(e.target.value)} style={{ padding:6 }}>
              <option value="ALL">All Tankers</option>
              {(truckUnits||[]).map(u => (<option key={u.id} value={u.id}>{u.unit_code}</option>))}
            </select>
            <input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} style={{ padding:6 }} placeholder="From" />
            <input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} style={{ padding:6 }} placeholder="To" />
            <button className="btn" disabled={listLoading} onClick={()=>{ reloadLots(); }} style={{ padding:'4px 10px', fontSize:12 }}>Apply</button>
            <button className="btn ghost" disabled={listLoading} onClick={()=>{ setFromDate(''); setToDate(''); reloadLots(); }} style={{ padding:'4px 10px', fontSize:12 }}>Refresh</button>
            <button className="btn ghost" disabled={listLoading} onClick={exportLotsCsv} style={{ padding:'4px 10px', fontSize:12 }}>Export CSV</button>
            <button className="btn ghost" disabled={listLoading} onClick={printLots} style={{ padding:'4px 10px', fontSize:12 }}>Print / PDF</button>
          </div>
        </div>
        <div className="table-wrap fo-table-responsive" style={{ height: 420, overflowY:'scroll', overflowX:'auto', scrollbarGutter: 'stable' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ textAlign:'left' }}>
                <th>Lot Code</th>
                <th>Unit Code</th>
                <th>Loaded (L)</th>
                <th>Used (L)</th>
                <th>Remaining (L)</th>
                <th>Stock Status</th>
                <th>Transferred To</th>
                <th>Load Type</th>
                <th
                  style={{ cursor:'pointer' }}
                  onClick={() => setLotsSort(s => s.key==='load_date' ? { key:'load_date', dir: s.dir==='asc'?'desc':'asc' } : { key:'load_date', dir:'asc' })}
                >
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                    Load Date
                    <SortIcon dir={lotsSort.key==='load_date'?lotsSort.dir:undefined} active={lotsSort.key==='load_date'} />
                  </span>
                </th>
                <th
                  style={{ cursor:'pointer' }}
                  onClick={() => setLotsSort(s => s.key==='load_time' ? { key:'load_time', dir: s.dir==='asc'?'desc':'asc' } : { key:'load_time', dir:'asc' })}
                >
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                    Load Time
                    <SortIcon dir={lotsSort.key==='load_time'?lotsSort.dir:undefined} active={lotsSort.key==='load_time'} />
                  </span>
                </th>
                <th
                  style={{ cursor:'pointer' }}
                  onClick={() => setLotsSort(s => s.key==='created_at' ? { key:'created_at', dir: s.dir==='asc'?'desc':'asc' } : { key:'created_at', dir:'asc' })}
                >
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                    Created
                    <SortIcon dir={lotsSort.key==='created_at'?lotsSort.dir:undefined} active={lotsSort.key==='created_at'} />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const sorted = [...(lotsList||[])].sort((a,b) => {
                  const dir = lotsSort.dir === 'asc' ? 1 : -1;
                  const k = lotsSort.key;
                  if (k === 'created_at') {
                    const va = a.created_at ? (parseWallClockDate(a.created_at)?.getTime() || 0) : 0;
                    const vb = b.created_at ? (parseWallClockDate(b.created_at)?.getTime() || 0) : 0;
                    return (va - vb) * dir;
                  }
                  if (k === 'load_date') {
                    const va = a.load_date ? (parseWallClockDate(a.load_date)?.setHours(0,0,0,0) || 0) : 0;
                    const vb = b.load_date ? (parseWallClockDate(b.load_date)?.setHours(0,0,0,0) || 0) : 0;
                    return (va - vb) * dir;
                  }
                  if (k === 'load_time') {
                    const toMinutes = (row) => {
                      const t = row.load_time ? parseWallClockDate(row.load_time) : (row.created_at ? parseWallClockDate(row.created_at) : null);
                      if (!t) return 0;
                      return (t.getHours()*60) + t.getMinutes();
                    };
                    const va = toMinutes(a);
                    const vb = toMinutes(b);
                    return (va - vb) * dir;
                  }
                  return 0;
                });
                if (sorted.length===0) return (<tr><td colSpan={12} style={{ padding:8, color:'#6b7280' }}>No lots</td></tr>);
                return sorted.map(l => {
                  let remaining = '';
                  if (l.loaded_liters != null && l.used_liters != null) {
                    const raw = l.loaded_liters - l.used_liters;
                    remaining = l.stock_status === 'SOLD' ? 0 : raw;
                  }
                  // eslint-disable-next-line no-unused-vars
                  const transferVolume = (l.stock_status === 'SOLD' && l.used_liters > l.loaded_liters) ? (l.used_liters - l.loaded_liters) : (l.transfer_volume_liters || 0);
                  const transferTo = l.transfer_to_unit_codes ? l.transfer_to_unit_codes : '-';
                  return (
                    <tr key={l.id || l.lot_code}>
                      <td data-label="Lot Code">
                        <div>{l.lot_code_initial || l.lot_code}</div>
                      </td>
                      <td data-label="Unit Code">{l.unit_code || '-'}</td>
                      <td data-label="Loaded (L)">{l.loaded_liters}</td>
                      <td data-label="Used (L)">{l.used_liters}</td>
                      <td data-label="Remaining (L)">{remaining}</td>
                      <td data-label="Stock Status">{l.stock_status || '-'}</td>
                      <td data-label="Transferred To">{transferTo}</td>
                      <td data-label="Load Type">{l.load_type || '-'}</td>
                      <td data-label="Load Date">{l.load_date ? formatWallClockDateDisplay(l.load_date) : '-'}</td>
                      <td data-label="Load Time">{l.load_time ? formatWallClockTimeDisplay(l.load_time) : (l.created_at ? formatWallClockTimeDisplay(l.created_at) : '-')}</td>
                      <td data-label="Created">{l.created_at ? formatWallClockDateTimeDisplay(l.created_at) : '-'}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function exportLotsCsv() {
  try {
    const auth = localStorage.getItem('authToken');
    const params = new URLSearchParams();
    params.set('load_type','PURCHASE');
    const fromDate = document.querySelector('input[type=date][placeholder="From"]')?.value;
    const toDate = document.querySelector('input[type=date][placeholder="To"]')?.value;
    // Use default server order for export; do not depend on any DOM select
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    // Keep created_sort consistent and simple
    params.set('created_sort', 'desc');
    const url = `/api/fuel-ops/lots/export?${params.toString()}`;
    fetch(url, { headers: { ...(auth?{ Authorization:'Bearer '+auth }: {}) } })
      .then(r => { if (!r.ok) throw new Error('Export failed'); return r.blob(); })
      .then(blob => { const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`lots_export_${Date.now()}.csv`; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },800); })
      .catch(e => alert(String(e.message||e)));
  } catch (e) { alert(String(e.message||e)); }
}
function printLots() {
  try {
    // Extract table HTML
    const table = document.querySelector('table');
    if (!table) { alert('Table not found'); return; }
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Lots</title><style>body{font-family:Arial;padding:16px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left} th{background:#f9fafb}</style></head><body>${table.outerHTML}<script>window.print();</script></body></html>`);
    w.document.close();
  } catch (e) { alert(String(e.message||e)); }
}
