import React, { useEffect, useMemo, useState } from 'react';

// This standalone Fuel Ops app only needs Fuel Ops permissions.
// Keep the same stored shape (tabs/actions JSON) but only manage FuelOps keys here.
const PERM_TAB = 'FuelOps';

// Logical list of FuelOps sub-tabs for UI grouping
const FUELOPS_SUBTABS = [
  { key: 'readings', label: 'Readings', canCreate: false, canEditDelete: false },
  { key: 'meter_checks', label: 'Fuel Meter Checks', canCreate: false, canEditDelete: false },
  { key: 'at_depot', label: 'At Depot', canCreate: false, canEditDelete: true },
  { key: 'day_logs', label: 'Day Logs', canCreate: false, canEditDelete: true },
  { key: 'vehicles_storage_info', label: 'Vehicles & Storage Info', canCreate: true, canEditDelete: true },
  { key: 'drivers', label: 'Drivers', canCreate: true, canEditDelete: true },
  { key: 'purchase', label: 'Purchase', canCreate: false, canEditDelete: false },
  { key: 'internal_transfers', label: 'Internal Transfers', canCreate: false, canEditDelete: false },
  { key: 'sales', label: 'Sales', canCreate: false, canEditDelete: false },
  { key: 'mini_stock', label: 'Mini Stock Indicator', canCreate: false, canEditDelete: false, isWidget: true },
];

function actionKey(action) {
  return `${PERM_TAB}.${action}`;
}

function getAllFuelOpsActionNames() {
  const names = [];
  for (const st of FUELOPS_SUBTABS) {
    names.push(`view_${st.key}`);
    if (st.canCreate) names.push(`create_${st.key}`);
    if (st.canEditDelete) {
      names.push(`edit_${st.key}`);
      names.push(`delete_${st.key}`);
    }
  }
  return names;
}

export default function EmployeeControl({ token, currentUserRole = 'OWNER', currentUserId }) {
  const [users, setUsers] = useState([]); // all users except maybe owner for selection
  const [selectedUserId, setSelectedUserId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tabs, setTabs] = useState({});
  const [actions, setActions] = useState({});
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ username:'', email:'', full_name:'', phone:'', role:'EMPLOYEE', password:'', joining_date:'', status:'ACTIVE' });
  const [createMessage, setCreateMessage] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  // Password Updation sub-section
  const [pwdForUserId, setPwdForUserId] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [updateUser, setUpdateUser] = useState({ full_name:'', email:'', phone:'', username:'', role:'', joining_date:'', status:'' });
  const [updateMsg, setUpdateMsg] = useState('');
  const [updateLoading, setUpdateLoading] = useState(false);

  useEffect(() => {
    loadUsers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadUsers() {
    setLoading(true); setMessage('');
    try {
      const r = await fetch('/api/users', { headers: { Authorization: 'Bearer '+token }});
      const data = await r.json();
      if (r.ok) {
        const list = Array.isArray(data) ? data : [];
        setUsers(list);
      } else {
        setMessage(data.error || 'Failed to load users');
      }
    } catch (e) {
      setMessage(e.message);
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (selectedUserId) {
      loadPermissions(selectedUserId);
      const u = users.find(x => String(x.id) === String(selectedUserId));
      if (u) {
        setUpdateUser({
          full_name: u.full_name || '',
          email: u.email || '',
          phone: u.phone || '',
          username: u.username || '',
          role: u.role || 'EMPLOYEE',
          joining_date: (u.joining_date ? String(u.joining_date).slice(0,10) : ''),
          status: u.status || 'ACTIVE'
        });
      }
    }
  }, [selectedUserId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  async function loadPermissions(uid) {
    setLoading(true); setMessage('');
    try {
      const r = await fetch(`/api/users/${uid}/permissions`, { headers: { Authorization: 'Bearer '+token }});
      const data = await r.json();
      if (r.ok) {
        setTabs(data.tabs || {});
        setActions(data.actions || {});
      } else {
        setMessage(data.error || 'Failed to load permissions');
      }
    } catch (e) {
      setMessage(e.message);
    } finally { setLoading(false); }
  }

  function toggleTab(tabKey) {
    setTabs(prev => {
      const next = { ...prev, [tabKey]: !prev[tabKey] };
      // If turning OFF a tab, clear its actions
      if (!next[tabKey]) {
        setActions(prevA => {
          const na = { ...prevA };
          if (tabKey === PERM_TAB) {
            getAllFuelOpsActionNames().forEach(a => { na[actionKey(a)] = false; });
          }
          return na;
        });
      }
      return next;
    });
  }

  function toggleAction(entity, actionName) {
    // Only toggle if the entity tab is enabled
    if (!tabs[entity]) return;
    const key = `${entity}.${actionName}`;
    setActions(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function setFuelOpsEnabled(value) {
    setTabs(prev => ({ ...prev, [PERM_TAB]: !!value }));
    if (!value) {
      setActions(prev => {
        const next = { ...prev };
        getAllFuelOpsActionNames().forEach(a => { next[actionKey(a)] = false; });
        return next;
      });
    }
  }

  function setAllFuelOpsViews(value) {
    if (!tabs[PERM_TAB]) return;
    setActions(prev => {
      const next = { ...prev };
      for (const st of FUELOPS_SUBTABS) {
        next[actionKey(`view_${st.key}`)] = !!value;
      }
      return next;
    });
  }

  function setAllFuelOpsActions(value) {
    if (!tabs[PERM_TAB]) return;
    setActions(prev => {
      const next = { ...prev };
      getAllFuelOpsActionNames().forEach(a => {
        next[actionKey(a)] = !!value;
      });
      return next;
    });
  }

  async function save() {
    if (!selectedUserId) return;
    setSaving(true); setMessage('');
    try {
      const fullTabs = { [PERM_TAB]: !!tabs[PERM_TAB] };
      const tabOn = !!fullTabs[PERM_TAB];
      const fullActions = {};
      getAllFuelOpsActionNames().forEach(a => {
        const k = actionKey(a);
        fullActions[k] = tabOn && !!actions[k];
      });
      const r = await fetch(`/api/users/${selectedUserId}/permissions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token },
        body: JSON.stringify({ tabs: fullTabs, actions: fullActions, merge: true })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      setMessage('Saved');
    } catch (e) {
      setMessage(e.message);
    } finally { setSaving(false); }
  }

  async function createEmployee() {
    setCreateMessage('');
    setCreateLoading(true);
    await createEmployeeInternal({ token, newUser, setMessage: setCreateMessage, loadUsers, setSelectedUserId, setNewUser });
    setCreateLoading(false);
  }

  const selectableUsers = useMemo(() => {
    // For Permissions section, keep current rules; but Password Updation needs self too.
    // We'll include self here so both dropdowns (Permissions/Password) see consistent choices,
    // and rely on backend rules to block forbidden operations.
    // eslint-disable-next-line no-self-assign
    let list = users;
    if (currentUserRole === 'ADMIN') {
      // Admin can see all; keep self included for self password change
      list = list;
    } else if (currentUserRole === 'OWNER') {
      // Owner: exclude admins
      list = list.filter(u => u.role !== 'ADMIN');
    }
    return list;
  }, [users, currentUserRole]);

  const selectedUser = useMemo(() => users.find(u => String(u.id) === String(selectedUserId)), [users, selectedUserId]);

  return (
    <div style={{padding:'24px 8px', maxWidth:1000, margin:'0 auto'}}>
  <h2 style={{margin:'0 0 16px'}}>{currentUserRole === 'ADMIN' ? 'User Control' : 'Employee Control'}</h2>
      {/* Create Employee */}
      <div style={{border:'1px solid #e5e7eb', borderRadius:10, padding:16, background:'#fafafa', marginBottom:16}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <h3 style={{margin:0, fontSize:16}}>
            {currentUserRole === 'ADMIN' ? 'Create User (Owner/Admin/Employee)' : 'Create Employee (Owner/Employee)'}
          </h3>
          <button onClick={()=>setCreating(v=>!v)} style={miniBtn}>{creating ? 'Hide' : 'Show'}</button>
        </div>
        {creating && (
          <div style={{marginTop:12, display:'grid', gridTemplateColumns:'repeat(3, minmax(0,1fr))', gap:12}}>
            {/* Full name */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Full name</label>
              <input value={newUser.full_name} onChange={e=>setNewUser({...newUser, full_name:e.target.value})} style={inputStyle} />
            </div>
            {/* Email */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Email</label>
              <input type="email" value={newUser.email} onChange={e=>setNewUser({...newUser, email:e.target.value})} style={inputStyle} />
            </div>
            {/* Phone */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Phone</label>
              <input value={newUser.phone} onChange={e=>setNewUser({...newUser, phone:e.target.value})} style={inputStyle} />
            </div>
            {/* Role */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Role</label>
              <select value={newUser.role} onChange={e=>setNewUser({...newUser, role:e.target.value})} style={inputStyle}>
                {currentUserRole === 'ADMIN' ? (
                  <>
                    <option value="EMPLOYEE">EMPLOYEE</option>
                    <option value="ADMIN">ADMIN</option>
                    <option value="OWNER">OWNER</option>
                  </>
                ) : (
                  <>
                    <option value="EMPLOYEE">EMPLOYEE</option>
                    <option value="OWNER">OWNER</option>
                  </>
                )}
              </select>
            </div>
            {/* Username */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Username</label>
              <input value={newUser.username} onChange={e=>setNewUser({...newUser, username:e.target.value})} style={inputStyle} />
            </div>
            {/* Password */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Initial password</label>
              <input type="password" value={newUser.password} onChange={e=>setNewUser({...newUser, password:e.target.value})} style={inputStyle} />
            </div>
            {/* Joining Date */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Joining date</label>
              <input type="date" value={newUser.joining_date} onChange={e=>setNewUser({...newUser, joining_date:e.target.value})} style={inputStyle} />
            </div>
            {/* Status */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Status</label>
              <select value={newUser.status} onChange={e=>setNewUser({...newUser, status:e.target.value})} style={inputStyle}>
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
                <option value="ON_LEAVE">ON_LEAVE</option>
                <option value="SUSPENDED">SUSPENDED</option>
              </select>
            </div>
            <div style={{gridColumn:'1/-1', display:'flex', gap:8, alignItems:'center'}}>
              <button disabled={createLoading} onClick={createEmployee} className="btn" style={{...miniBtn, background:'#111', color:'#fff'}}>{createLoading ? 'Creating...' : 'Create'}</button>
              <div style={{fontSize:12, color:'#6b7280'}}>New users must change password on first login.</div>
              {createMessage && <div style={{marginLeft:8, fontSize:12, color: createMessage.toLowerCase().includes('fail') || createMessage.toLowerCase().includes('error') ? 'crimson' : 'green'}}>{createMessage}</div>}
            </div>
          </div>
        )}
      </div>
      <div style={{display:'flex', gap:16, flexWrap:'wrap', alignItems:'center'}}>
        <div>
          <label style={{fontSize:12, fontWeight:600, display:'block', marginBottom:4}}>Employee</label>
          <select value={selectedUserId} onChange={e=>setSelectedUserId(e.target.value)} style={selStyle}>
            <option value="">Select an employee…</option>
            {selectableUsers.map(u => (
              <option key={u.id} value={String(u.id)}>{(u.full_name || u.username || u.email)} ({u.role})</option>
            ))}
          </select>
        </div>
        <div style={{fontSize:12,color:'#555'}}>{loading ? 'Loading...' : selectedUser ? `Editing permissions for ${selectedUser.email}` : 'Select an employee.'}</div>
        {/* Edit Status for Admin/Owner */}
        {selectedUser && (
          <div style={{display:'flex', alignItems:'center', gap:8, marginLeft:8, padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff'}}>
            <label style={{fontSize:12, fontWeight:600}}>Status</label>
            <select
              value={selectedUser.status || 'ACTIVE'}
              onChange={e => setUsers(prev => prev.map(u => u.id===selectedUser.id ? { ...u, status: e.target.value } : u))}
              style={selStyle}
            >
              <option value="ACTIVE">ACTIVE</option>
              <option value="INACTIVE">INACTIVE</option>
              <option value="ON_LEAVE">ON_LEAVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
            </select>
            <button className="btn" style={miniBtnStrong} disabled={statusSaving}
              onClick={async ()=>{
                if (!selectedUserId) return;
                setStatusMsg(''); setStatusSaving(true);
                try {
                  const r = await fetch(`/api/users/${selectedUserId}`, {
                    method:'PATCH',
                    headers: { 'Content-Type':'application/json', Authorization:'Bearer '+token },
                    body: JSON.stringify({ status: (users.find(u => u.id===selectedUserId)?.status) || 'ACTIVE' })
                  });
                  const data = await r.json();
                  if (!r.ok) throw new Error(data.error || 'Failed to update status');
                  // Refresh list to normalize
                  await loadUsers();
                  setStatusMsg('Status updated');
                } catch (e) {
                  setStatusMsg(e.message);
                } finally { setStatusSaving(false); }
              }}
            >{statusSaving?'Saving…':'Save Status'}</button>
            {statusMsg && <span style={{fontSize:12, color: statusMsg.toLowerCase().includes('updated') ? 'green' : 'crimson'}}>{statusMsg}</span>}
          </div>
        )}
        <div style={{marginLeft:'auto', display:'flex', flexWrap:'wrap', gap:8}}>
          <button onClick={()=>setFuelOpsEnabled(true)} className="btn" style={miniBtnStrong}>Enable Fuel Ops</button>
          <button onClick={()=>setFuelOpsEnabled(false)} className="btn" style={miniBtn}>Disable Fuel Ops</button>
          <button onClick={()=>setAllFuelOpsViews(true)} className="btn" style={miniBtnStrong} disabled={!tabs[PERM_TAB]}>All Views</button>
          <button onClick={()=>setAllFuelOpsViews(false)} className="btn" style={miniBtn} disabled={!tabs[PERM_TAB]}>Clear Views</button>
          <button onClick={()=>setAllFuelOpsActions(true)} className="btn" style={miniBtnStrong} disabled={!tabs[PERM_TAB]}>All Actions</button>
          <button onClick={()=>setAllFuelOpsActions(false)} className="btn" style={miniBtn} disabled={!tabs[PERM_TAB]}>Clear Actions</button>
        </div>
      </div>
      <div style={{marginTop:24, display:'grid', gridTemplateColumns:'1fr', gap:16}}>
        <div>
          {/* Update User Data panel (mirrors create UI) */}
          {selectedUser && (
            <div style={{border:'1px solid #e5e7eb', borderRadius:10, padding:16, background:'#fafafa', marginBottom:16}}>
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
                <h3 style={{margin:0, fontSize:16}}>Update User Data</h3>
              </div>
              <div style={{marginTop:12, display:'grid', gridTemplateColumns:'repeat(3, minmax(0,1fr))', gap:12}}>
                <div style={fieldWrap}>
                  <label style={labelStyle}>Full name</label>
                  <input value={updateUser.full_name} onChange={e=>setUpdateUser({...updateUser, full_name:e.target.value})} style={inputStyle} />
                </div>
                <div style={fieldWrap}>
                  <label style={labelStyle}>Email</label>
                  <input type="email" value={updateUser.email} onChange={e=>setUpdateUser({...updateUser, email:e.target.value})} style={inputStyle} />
                </div>
                <div style={fieldWrap}>
                  <label style={labelStyle}>Phone</label>
                  <input value={updateUser.phone} onChange={e=>setUpdateUser({...updateUser, phone:e.target.value})} style={inputStyle} />
                </div>
                <div style={fieldWrap}>
                  <label style={labelStyle}>Role</label>
                  <select value={updateUser.role} onChange={e=>setUpdateUser({...updateUser, role:e.target.value})} style={inputStyle}>
                    {currentUserRole === 'ADMIN' ? (
                      <>
                        <option value="EMPLOYEE">EMPLOYEE</option>
                        <option value="ADMIN">ADMIN</option>
                        <option value="OWNER">OWNER</option>
                      </>
                    ) : (
                      <>
                        <option value="EMPLOYEE">EMPLOYEE</option>
                        <option value="OWNER">OWNER</option>
                      </>
                    )}
                  </select>
                </div>
                <div style={fieldWrap}>
                  <label style={labelStyle}>Username</label>
                  <input value={updateUser.username} onChange={e=>setUpdateUser({...updateUser, username:e.target.value})} style={inputStyle} />
                </div>
                <div style={fieldWrap}>
                  <label style={labelStyle}>Joining date</label>
                  <input type="date" value={updateUser.joining_date} onChange={e=>setUpdateUser({...updateUser, joining_date:e.target.value})} style={inputStyle} />
                </div>
                <div style={fieldWrap}>
                  <label style={labelStyle}>Status</label>
                  <select value={updateUser.status} onChange={e=>setUpdateUser({...updateUser, status:e.target.value})} style={inputStyle}>
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="INACTIVE">INACTIVE</option>
                    <option value="ON_LEAVE">ON_LEAVE</option>
                    <option value="SUSPENDED">SUSPENDED</option>
                  </select>
                </div>
                <div style={{gridColumn:'1/-1', display:'flex', gap:8, alignItems:'center'}}>
                  <button className="btn" style={{...miniBtnStrong, padding:'10px 16px'}} disabled={updateLoading}
                    onClick={async ()=>{
                      if (!selectedUserId) return;
                      setUpdateMsg(''); setUpdateLoading(true);
                      try {
                        const payload = {
                          full_name: updateUser.full_name || null,
                          email: updateUser.email || null,
                          phone: updateUser.phone || null,
                          username: updateUser.username || null,
                          role: updateUser.role || null,
                          joining_date: updateUser.joining_date || null,
                          status: updateUser.status || null
                        };
                        const res = await fetch(`/api/users/${selectedUserId}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type':'application/json', Authorization: 'Bearer '+token },
                          body: JSON.stringify(payload)
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Failed to update user');
                        await loadUsers();
                        setUpdateMsg('Updated');
                      } catch (e) {
                        setUpdateMsg(e.message);
                      } finally {
                        setUpdateLoading(false);
                      }
                    }}
                  >{updateLoading?'Updating…':'Update'}</button>
                  {updateMsg && <div style={{fontSize:12, color: updateMsg.toLowerCase().includes('updated') || updateMsg==='Updated' ? 'green' : 'crimson'}}>{updateMsg}</div>}
                </div>
              </div>
            </div>
          )}

          <h3 style={subhead}>Fuel Ops Access</h3>
          <div style={{border:'1px solid #e5e7eb', borderRadius:12, background:'#fff', padding:14}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12}}>
              <div>
                <div style={{fontWeight:700}}>Fuel Ops</div>
                <div style={{fontSize:12, color:'#6b7280', marginTop:2}}>Turn on the main tab, then choose sub-tabs & actions.</div>
              </div>
              <PillToggle
                label={tabs[PERM_TAB] ? 'Enabled' : 'Disabled'}
                checked={!!tabs[PERM_TAB]}
                onChange={() => toggleTab(PERM_TAB)}
              />
            </div>

            <div style={{marginTop:14, display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:10, opacity: tabs[PERM_TAB] ? 1 : 0.55}}>
              {FUELOPS_SUBTABS.map(st => {
                const viewK = actionKey(`view_${st.key}`);
                const createK = actionKey(`create_${st.key}`);
                const editK = actionKey(`edit_${st.key}`);
                const delK = actionKey(`delete_${st.key}`);
                const tabEnabled = !!tabs[PERM_TAB];
                const viewOn = !!actions[viewK];
                const disabledAll = !tabEnabled;
                const disabledSecondary = disabledAll || !viewOn;
                return (
                  <div key={st.key} style={{border:'1px solid #eef2f7', borderRadius:12, padding:12, background:'#fafafa'}}>
                    <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12}}>
                      <div style={{fontWeight:700, fontSize:13}}>{st.label}</div>
                      <PillToggle
                        label="View"
                        checked={viewOn}
                        disabled={disabledAll}
                        onChange={() => toggleAction(PERM_TAB, `view_${st.key}`)}
                      />
                    </div>

                    <div style={{marginTop:10, display:'flex', flexWrap:'wrap', gap:8}}>
                      {st.canCreate && (
                        <PillToggle
                          label="Create"
                          checked={!!actions[createK]}
                          disabled={disabledSecondary}
                          onChange={() => toggleAction(PERM_TAB, `create_${st.key}`)}
                        />
                      )}
                      {st.canEditDelete && (
                        <>
                          <PillToggle
                            label="Edit"
                            checked={!!actions[editK]}
                            disabled={disabledSecondary}
                            onChange={() => toggleAction(PERM_TAB, `edit_${st.key}`)}
                          />
                          <PillToggle
                            label="Delete"
                            checked={!!actions[delK]}
                            disabled={disabledSecondary}
                            onChange={() => toggleAction(PERM_TAB, `delete_${st.key}`)}
                          />
                        </>
                      )}
                      {!st.canCreate && !st.canEditDelete && (
                        <span style={{fontSize:12, color:'#9ca3af'}}>View only</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div style={{marginTop:32, display:'flex', alignItems:'center', gap:16}}>
        <button disabled={saving || !selectedUserId} onClick={save} style={{background:'#111',color:'#fff',border:'none',padding:'10px 22px',borderRadius:8,cursor:'pointer'}}>{saving? 'Saving...' : 'Save Permissions'}</button>
        {message && <span style={{fontSize:13, color: message==='Saved' ? 'green' : 'crimson'}}>{message}</span>}
      </div>

      {/* Password Updation sub-tab */}
      <div style={{border:'1px solid #e5e7eb', borderRadius:10, padding:16, background:'#fafafa', marginTop:24}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <h3 style={{margin:0, fontSize:16}}>Password Updation</h3>
        </div>
        <div style={{marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
          <div style={fieldWrap}>
            <label style={labelStyle}>Employee</label>
            <select value={pwdForUserId} onChange={e=>setPwdForUserId(e.target.value)} style={selStyle}>
              <option value="">Select an employee…</option>
              {selectableUsers.map(u => (
                <option key={u.id} value={String(u.id)}>{(u.full_name || u.username || u.email)} ({u.role})</option>
              ))}
            </select>
          </div>
          <div style={fieldWrap}>
            <label style={labelStyle}>New password</label>
            <input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} style={inputStyle} placeholder="Enter new password" />
          </div>
          <div style={{gridColumn:'1/-1', display:'flex', gap:8, alignItems:'center'}}>
            <button className="btn" style={{...miniBtnStrong, padding:'10px 16px'}} disabled={pwdLoading || !pwdForUserId || !newPassword}
              onClick={async ()=>{
                setPwdMsg(''); setPwdLoading(true);
                try {
                  const res = await fetch(`/api/users/${pwdForUserId}/password-reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token },
                    body: JSON.stringify({ newPassword })
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Failed to update password');
                  setPwdMsg('Password updated successfully');
                  setNewPassword('');
                } catch (e) {
                  setPwdMsg(e.message);
                } finally { setPwdLoading(false); }
              }}
            >{pwdLoading ? 'Updating…' : 'Update Password'}</button>
            {pwdMsg && <div style={{fontSize:12, color: pwdMsg.toLowerCase().includes('success') ? 'green' : 'crimson'}}>{pwdMsg}</div>}
          </div>
        </div>
      </div>
      <p style={{marginTop:32,fontSize:12,color:'#666',lineHeight:1.4}}>
        Note: These toggles are stored but enforcement across all routes/UI is partial in this phase.
        Extend client conditionals and backend authorization checks to fully honor each action.
      </p>
    </div>
  );
}

const selStyle = { padding:'8px 12px', borderRadius:8, border:'1px solid #ccc', minWidth:250 };
const subhead = { margin:'0 0 12px', fontSize:16 };
const miniBtn = { background:'#e2e8f0', border:'1px solid #9ca3af', padding:'8px 12px', borderRadius:6, cursor:'pointer', fontSize:12, color:'#111', fontWeight:600 };
const miniBtnStrong = { ...miniBtn, background:'#111827', border:'1px solid #111827', color:'#fff' };
const inputStyle = { padding:'8px 10px', border:'1px solid #d1d5db', borderRadius:8, width:'100%' };
const fieldWrap = { display:'flex', flexDirection:'column', gap:6 };
const labelStyle = { fontSize:12, fontWeight:600 };

function PillToggle({ label, checked, disabled, onChange }) {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 999,
    border: '1px solid',
    fontSize: 12,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    userSelect: 'none',
  };
  const on = {
    background: '#111827',
    color: '#fff',
    borderColor: '#111827',
  };
  const off = {
    background: '#fff',
    color: '#111827',
    borderColor: '#e5e7eb',
  };
  const dis = {
    opacity: 0.55,
  };
  return (
    <label style={{ ...base, ...(checked ? on : off), ...(disabled ? dis : {}) }}>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={!!disabled}
        onChange={onChange}
        style={{ display: 'none' }}
      />
      <span>{label}</span>
    </label>
  );
}

async function createEmployeeInternal({ token, newUser, setMessage, loadUsers, setSelectedUserId, setNewUser }) {
  try {
    if (!newUser.username && !newUser.email) {
      setMessage('Username or email is required');
      return;
    }
    if (!newUser.password) {
      setMessage('Initial password is required');
      return;
    }
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token },
      body: JSON.stringify({
        username: newUser.username || undefined,
        email: newUser.email || undefined,
        full_name: newUser.full_name || undefined,
        phone: newUser.phone || undefined,
        role: newUser.role || 'EMPLOYEE',
        password: newUser.password,
        joining_date: newUser.joining_date || undefined,
        status: newUser.status || 'ACTIVE'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create user');
    await loadUsers();
    setSelectedUserId(String(data.id));
  setNewUser({ username:'', email:'', full_name:'', phone:'', role:'EMPLOYEE', password:'', joining_date:'', status:'ACTIVE' });
  const hint = ` (${data.role}) login using username "${data.username || ''}"${data.email ? ` or email "${data.email}"` : ''}.`;
  setMessage('User created successfully.' + hint);
  } catch (e) {
    setMessage(e.message);
  }
}
