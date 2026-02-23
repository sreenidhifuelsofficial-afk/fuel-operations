import React, { useEffect, useMemo, useState } from 'react';
import { fmtDateInput, parseWallClockDate, formatWallClockDateDisplay, formatWallClockDateTimeDisplay, round3, safeJson } from './utils';

export default function AuditSection({ token, units, datums }) {
  const allUnits = useMemo(() => ([...(units || []), ...(datums || [])]).filter(u => u.unit_type === 'TRUCK' || u.unit_type === 'DATUM'), [units, datums]);

  const initialFrom = useMemo(() => {
    try {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return fmtDateInput(d);
    } catch {
      return '';
    }
  }, []);
  const initialTo = useMemo(() => fmtDateInput(new Date()), []);

  const [draft, setDraft] = useState(() => ({
    fromDate: initialFrom,
    toDate: initialTo,
    unitId: '',
    action: 'ALL',
    entityType: 'ALL',
    tab: 'ALL',
  }));
  const [applied, setApplied] = useState(() => ({ ...draft }));
  const [reloadSeq, setReloadSeq] = useState(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);

  function buildQuery(filters) {
    const qs = new URLSearchParams();
    if (filters?.unitId) qs.set('unit_id', filters.unitId);
    if (filters?.fromDate) qs.set('op_from', filters.fromDate);
    if (filters?.toDate) qs.set('op_to', filters.toDate);
    if (filters?.action && filters.action !== 'ALL') qs.set('action', filters.action);
    if (filters?.entityType && filters.entityType !== 'ALL') qs.set('entity_type', filters.entityType);
    if (filters?.tab && filters.tab !== 'ALL') qs.set('tab', filters.tab);
    // Always include payloads; the UI renders a summarized diff.
    qs.set('include_payload', 'true');
    qs.set('limit', '500');
    return { qs: qs.toString() };
  }

  function valToText(v) {
    if (v == null) return '-';
    if (typeof v === 'number') return String(round3(v));
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Date) return formatWallClockDateTimeDisplay(v);
    const s = String(v);
    // Pretty-print wall-clock timestamps when possible.
    const dt = parseWallClockDate(s);
    if (dt) return formatWallClockDateTimeDisplay(dt);
    return s;
  }

  function diffPairs(oldObj, newObj, keys) {
    const o = oldObj && typeof oldObj === 'object' ? oldObj : {};
    const n = newObj && typeof newObj === 'object' ? newObj : {};
    const out = [];
    for (const k of keys) {
      const ov = o[k];
      const nv = n[k];
      // Use JSON stringify for stable compare across numbers/strings/null.
      if (JSON.stringify(ov) === JSON.stringify(nv)) continue;
      out.push(`${k}: ${valToText(ov)} - ${valToText(nv)}`);
    }
    return out;
  }

  function isProbablyDateLike(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (!t) return false;
    // yyyy-mm-dd ...
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return true;
    // dd/mm/yyyy ...
    if (/^\d{2}\/\d{2}\/\d{4}/.test(t)) return true;
    return false;
  }

  function actionLabel(row) {
    const section = row?.section || '';
    const action = row?.action || '';
    const entity = row?.entity_type || '';

    if (section === 'Opening Reading' || section === 'Closing Reading') {
      return `UPDATE ${section}`;
    }
    if (section === 'Sales & Transfers') {
      const kind = entity === 'SALE' ? 'Sale' : (entity === 'INTERNAL_TRANSFER' ? 'Transfer' : entity || '');
      return kind ? `${action} ${kind}` : (action || '-');
    }

    if (section === 'Freeze' && entity === 'TRIP') {
      return action ? `${action} Trip` : '-';
    }
    return action || '-';
  }

  function changesSummary(row) {
    const section = row?.section || '';
    if (section === 'Freeze') {
      const reason = row?.reason || row?.payload_new?.unfrozen_reason || row?.payload_new?.frozen_reason || row?.payload_old?.unfrozen_reason || row?.payload_old?.frozen_reason;
      return reason ? `reason: ${valToText(reason)}` : '';
    }
    if (section === 'Opening Reading' || section === 'Closing Reading') return '';

    const action = row?.action || '';
    const entity = row?.entity_type || '';
    const oldP = row?.payload_old;
    const newP = row?.payload_new;

    if (entity === 'SALE') {
      const keys = ['to_vehicle', 'sale_volume_liters', 'driver_name', 'activity', 'sale_date', 'performed_at', 'trip'];
      if (action === 'UPDATE') return diffPairs(oldP, newP, keys).join('; ');
      const src = action === 'DELETE' ? oldP : newP;
      if (!src || typeof src !== 'object') return '';
      const parts = [];
      if (src.to_vehicle) parts.push(`to_vehicle: ${valToText(src.to_vehicle)}`);
      if (src.sale_volume_liters != null) parts.push(`liters: ${valToText(src.sale_volume_liters)}`);
      if (src.driver_name) parts.push(`driver: ${valToText(src.driver_name)}`);
      if (src.activity) parts.push(`activity: ${valToText(src.activity)}`);
      if (src.performed_at) parts.push(`time: ${valToText(src.performed_at)}`);
      return parts.join('; ');
    }

    if (entity === 'INTERNAL_TRANSFER') {
      const keys = ['activity', 'transfer_volume', 'transfer_volume_liters', 'from_unit_code', 'to_unit_code', 'transfer_date', 'performed_at', 'driver_name'];
      if (action === 'UPDATE') return diffPairs(oldP, newP, keys).join('; ');
      const src = action === 'DELETE' ? oldP : newP;
      if (!src || typeof src !== 'object') return '';
      const vol = src.transfer_volume_liters != null ? src.transfer_volume_liters : src.transfer_volume;
      const fromCodeRaw = (typeof src.from_unit_code === 'string' && !isProbablyDateLike(src.from_unit_code)) ? src.from_unit_code : null;
      const toCodeRaw = (typeof src.to_unit_code === 'string' && !isProbablyDateLike(src.to_unit_code)) ? src.to_unit_code : null;
      const fromCode = fromCodeRaw || (src.from_unit_id != null ? unitCodeOnly(src.from_unit_id) : null);
      const toCode = toCodeRaw || (src.to_unit_id != null ? unitCodeOnly(src.to_unit_id) : null);

      const lines = [];
      if (fromCode || toCode) lines.push(`from: ${valToText(fromCode)}  to: ${valToText(toCode)};`);
      if (vol != null) lines.push(`liters: ${valToText(vol)};`);
      if (src.activity) lines.push(`activity: ${valToText(src.activity)}`);
      return lines.join('\n');
    }

    // Fallback: show amount_liters if present, else nothing.
    if (row?.amount_liters != null) return `liters: ${valToText(row.amount_liters)}`;
    return '';
  }

  function readingsSummary(row) {
    const section = row?.section || '';
    const oldP = row?.payload_old;
    const newP = row?.payload_new;

    if (section === 'Sales & Transfers') {
      const o = (oldP && typeof oldP === 'object' ? oldP.trip_opening_liters : null) ?? (newP && typeof newP === 'object' ? newP.trip_opening_liters : null);
      const cOld = oldP && typeof oldP === 'object' ? oldP.trip_closing_liters : null;
      const cNew = newP && typeof newP === 'object' ? newP.trip_closing_liters : null;
      if (o == null && cOld == null && cNew == null) return '';
      const parts = [];
      if (o != null) parts.push(`opening reading: ${valToText(o)}`);
      if (cOld != null || cNew != null) parts.push(`old closing reading: ${valToText(cOld)} â†’ new closing reading: ${valToText(cNew)}`);
      return parts.join('; ');
    }

    if (section === 'Opening Reading') {
      const oL = oldP && typeof oldP === 'object' ? oldP.opening_liters : null;
      const nL = newP && typeof newP === 'object' ? newP.opening_liters : null;
      const oT = oldP && typeof oldP === 'object' ? oldP.opening_at : null;
      const nT = newP && typeof newP === 'object' ? newP.opening_at : null;
      const parts = [];
      parts.push(`opening reading: ${valToText(oL)} â†’ ${valToText(nL)}`);
      if (JSON.stringify(oT) !== JSON.stringify(nT)) parts.push(`opening time: ${valToText(oT)} â†’ ${valToText(nT)}`);
      return parts.join('; ');
    }
    if (section === 'Closing Reading') {
      const oL = oldP && typeof oldP === 'object' ? oldP.closing_liters : null;
      const nL = newP && typeof newP === 'object' ? newP.closing_liters : null;
      const oT = oldP && typeof oldP === 'object' ? oldP.closing_at : null;
      const nT = newP && typeof newP === 'object' ? newP.closing_at : null;
      const parts = [];
      parts.push(`old closing reading: ${valToText(oL)} â†’ new closing reading: ${valToText(nL)}`);
      if (JSON.stringify(oT) !== JSON.stringify(nT)) parts.push(`closing time: ${valToText(oT)} â†’ ${valToText(nT)}`);
      return parts.join('; ');
    }
    return '';
  }

  useEffect(() => {
    if (!token) { setItems([]); setError(''); return; }
    let aborted = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const { qs } = buildQuery(applied);
        const r = await fetch(`/api/fuel-ops/audit?${qs}`, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
        const data = await safeJson(r);
        if (!r.ok) throw new Error((data && data.error) || 'Failed to load audit');
        if (aborted) return;
        const raw = (data && Array.isArray(data.items)) ? data.items : [];
        setItems(raw);
      } catch (e) {
        if (!aborted) {
          setItems([]);
          setError(String(e.message || e));
        }
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => { aborted = true; };
  }, [token, applied, reloadSeq]);

  const unitLabel = useMemo(() => {
    const m = new Map();
    for (const u of allUnits) m.set(String(u.id), u);
    return (id) => {
      if (id == null) return '-';
      const u = m.get(String(id));
      if (!u) return String(id);
      const code = u.unit_code || String(u.id);
      const num = u.vehicle_number || u.vehicle_no || '';
      return num ? `${code} · ${num}` : code;
    };
  }, [allUnits]);

  const unitCodeOnly = useMemo(() => {
    const m = new Map();
    for (const u of allUnits) m.set(String(u.id), u);
    return (id) => {
      if (id == null) return '-';
      const u = m.get(String(id));
      if (!u) return String(id);
      return u.unit_code || String(u.id);
    };
  }, [allUnits]);

  return (
    <div className="card" style={{ padding: 16, maxWidth: 1200 }}>
      <div style={{ fontSize: 12, color: '#374151', marginBottom: 12 }}>
        Audit is admin-only. It shows post-unfreeze actions for Opening/Closing readings and Sales/Transfers.
      </div>

      <div className="fo-grid-auto">
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          From Date
          <input type="date" value={draft.fromDate} onChange={e => setDraft(s => ({ ...s, fromDate: e.target.value }))} style={{ padding: 8 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          To Date
          <input type="date" value={draft.toDate} onChange={e => setDraft(s => ({ ...s, toDate: e.target.value }))} style={{ padding: 8 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Unit
          <select value={draft.unitId} onChange={e => setDraft(s => ({ ...s, unitId: e.target.value }))} style={{ padding: 8 }}>
            <option value="">All</option>
            {allUnits.map(u => (
              <option key={u.id} value={u.id}>{u.unit_code}{u.unit_type === 'DATUM' ? ' (DATUM)' : ''}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Action
          <select value={draft.action} onChange={e => setDraft(s => ({ ...s, action: e.target.value }))} style={{ padding: 8 }}>
            <option value="ALL">All</option>
            <option value="CREATE">CREATE</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
            <option value="FREEZE">FREEZE</option>
            <option value="UNFREEZE">UNFREEZE</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Entity
          <select value={draft.entityType} onChange={e => setDraft(s => ({ ...s, entityType: e.target.value }))} style={{ padding: 8 }}>
            <option value="ALL">All</option>
            <option value="TRIP">TRIP</option>
            <option value="INTERNAL_TRANSFER">INTERNAL_TRANSFER</option>
            <option value="SALE">SALE</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Tab
          <select value={draft.tab} onChange={e => setDraft(s => ({ ...s, tab: e.target.value }))} style={{ padding: 8 }}>
            <option value="ALL">All</option>
            <option value="At Depot">At Depot</option>
          </select>
        </label>
      </div>

      <div className="fo-filter-bar" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => { setApplied({ ...draft }); }} disabled={loading}>Apply</button>
        <button className="btn ghost" onClick={() => setReloadSeq(s => s + 1)} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {error && (
        <div style={{ marginTop: 10, color: '#b91c1c' }}>{error}</div>
      )}

      <div style={{ marginTop: 14 }}>
        <div className="table-wrap fo-table-responsive" style={{ height: 520, overflowY:'scroll', overflowX:'auto', scrollbarGutter: 'stable' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>When</th>
                <th>Performed by</th>
                <th>Vehicle</th>
                <th>Trip No</th>
                <th>Action</th>
                <th>Changes</th>
                <th>Opening and Closing reading changes</th>
              </tr>
            </thead>
            <tbody>
              {(items || []).length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 8, color: '#6b7280' }}>{loading ? 'Loading…' : 'No records'}</td></tr>
              ) : (
                items.map(row => {
                  const when = row.created_at;
                  const whenText = when ? formatWallClockDateTimeDisplay(when) : '-';
                  const opDate = row.op_date || row.opDate || row.date || '';
                  const unitText = row.unit_id != null ? unitLabel(row.unit_id) : '-';
                  const tripPart = row.trip_no != null ? `Trip ${row.trip_no}` : (row.trip_id != null ? `Trip ${row.trip_id}` : '-');
                  const dayPart = opDate ? formatWallClockDateDisplay(opDate) : '-';
                  const tripText = tripPart && tripPart !== '-' ? `${tripPart} · ${dayPart}` : dayPart;
                  const actText = actionLabel(row);
                  const changes = changesSummary(row);
                  const readings = readingsSummary(row);
                  return (
                    <tr key={row.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td data-label="When" style={{ padding: '6px 8px' }}>{whenText}</td>
                      <td data-label="Performed by" style={{ padding: '6px 8px' }}>{row.performed_by || '-'}</td>
                      <td data-label="Vehicle" style={{ padding: '6px 8px' }}>{unitText}</td>
                      <td data-label="Trip No" style={{ padding: '6px 8px' }}>{tripText}</td>
                      <td data-label="Action" style={{ padding: '6px 8px' }}>{actText}</td>
                      <td data-label="Changes" style={{ padding: '6px 8px', maxWidth: 520 }}>
                        {changes ? <div style={{ whiteSpace: 'pre-line' }}>{changes}</div> : <span style={{ color: '#6b7280', fontSize: 12 }}>—</span>}
                      </td>
                      <td data-label="Readings" style={{ padding: '6px 8px', maxWidth: 420 }}>
                        {readings ? <div style={{ whiteSpace: 'pre-line' }}>{readings}</div> : <span style={{ color: '#6b7280', fontSize: 12 }}>—</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
