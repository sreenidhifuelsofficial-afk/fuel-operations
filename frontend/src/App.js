import './App.css';
import Login from './components/Login';
import EmployeeControl from './components/EmployeeControl';
import Profile from './components/Profile';
import FuelOps from './components/FuelOps';
import { useState, useEffect, useMemo, useRef } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  // Derive active top-level tab from URL path
  const tab = useMemo(() => {
    const p = location.pathname;
    if (p.startsWith('/profile')) return 'Profile';
    if (p.startsWith('/employee-control')) return 'EmployeeControl';
    if (p.startsWith('/fuelops')) return 'FuelOps';
    return 'FuelOps';
  }, [location.pathname]);
  const [permissions, setPermissions] = useState(null); // { tabs, actions }
  const [user, setUser] = useState(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const idleTimerRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  const IDLE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (!token) { setLoadingUser(false); return; }
    fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token }})
      .then(r => r.json())
      .then(data => {
        if (data && data.id) setUser(data);
      })
      .catch(()=>{})
      .finally(()=> setLoadingUser(false));
  }, []);

  // Load permissions for current user when applicable
  useEffect(() => {
    let aborted = false;
    async function loadPerm() {
      if (!user) return;
      // Permissions are an EMPLOYEE-scoped UI gating mechanism.
      // Owners/Admins are treated as full-access by role.
      if (user.role === 'EMPLOYEE') {
        const token = localStorage.getItem('authToken');
        try {
          const r = await fetch(`/api/users/${user.id}/permissions`, { headers: { Authorization: 'Bearer '+token }});
          if (r.ok) {
            const data = await r.json();
            if (!aborted) setPermissions({ tabs: data.tabs || {}, actions: data.actions || {} });
          } else if (!aborted) {
            setPermissions({ tabs: {}, actions: {} });
          }
        } catch {
          if (!aborted) setPermissions({ tabs: {}, actions: {} });
        }
      } else {
        setPermissions(null);
      }
    }
    loadPerm();
    return () => { aborted = true; };
  }, [user?.id, user?.role]);

  // Redirect root to /fuelops on first load
  useEffect(() => {
    if (location.pathname === '/') navigate('/fuelops', { replace: true });
  }, []);

  // Compute visible tabs based on user role and permissions
  const visibleTabs = useMemo(() => {
    const baseTabs = [
      { key: 'Profile', label: 'Profile' },
      { key: 'FuelOps', label: 'Fuel Ops' },
    ];
    if (user && (user.role === 'OWNER' || user.role === 'ADMIN')) {
      baseTabs.push({ key: 'EmployeeControl', label: 'User Control' });
    }
    if (user && user.role === 'EMPLOYEE' && permissions) {
      const tabKeys = Object.keys(permissions.tabs || {});
      if (tabKeys.length > 0) {
        // Gate FuelOps by permissions as well; keep Profile and EmployeeControl always visible
        return baseTabs.filter(t => t.key === 'EmployeeControl' || t.key === 'Profile' || permissions.tabs[t.key]);
      }
    }
    return baseTabs;
  }, [user, permissions]);

  // Ensure current tab is allowed; if not, navigate to first visible
  useEffect(() => {
    if (!visibleTabs.find(t => t.key === tab) && visibleTabs.length) {
      const routes = { FuelOps: '/fuelops', Profile: '/profile', EmployeeControl: '/employee-control' };
      navigate(routes[visibleTabs[0].key] || '/fuelops', { replace: true });
    }
  }, [visibleTabs, tab]);

  // Idle auto-logout after 10 minutes without interaction
  useEffect(() => {
    if (!user) return;
    const onActivity = () => { lastActivityRef.current = Date.now(); };
    const events = ['mousemove','keydown','click','scroll','touchstart','visibilitychange'];
    events.forEach(ev => window.addEventListener(ev, onActivity, { passive: true }));
    idleTimerRef.current = setInterval(() => {
      const now = Date.now();
      if (now - lastActivityRef.current > IDLE_LIMIT_MS) {
        logout(true);
      }
    }, 30000); // check every 30s
    return () => {
      events.forEach(ev => window.removeEventListener(ev, onActivity));
      if (idleTimerRef.current) { clearInterval(idleTimerRef.current); idleTimerRef.current = null; }
    };
  }, [user]);

  function logout(isAuto=false) {
    localStorage.removeItem('authToken');
    setUser(null);
    navigate('/fuelops', { replace: true });
    if (isAuto) {
      try {
        // Optional: a toast or alert can be shown here, keeping minimal side effects
        console.log('Logged out due to inactivity');
      } catch {}
    }
  }
  if (loadingUser) {
    return <div style={{padding:'60px', textAlign:'center', color:'#555'}}>Loading...</div>;
  }

  if (!user) {
    return <Login onAuthed={(u)=> setUser(u)} />;
  }

  return (
    <>
      <header>
        <div className="wrap" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'12px', flexWrap:'wrap'}}>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <img src="/assets/branding/logo.png" alt="Sreenidhi Fuels" width="32" height="32" style={{borderRadius:'50%', objectFit:'cover'}} onError={(e)=>{ e.currentTarget.style.display='none'; }} />
            <div style={{fontWeight:700,fontSize:'20px'}}>Fuel Ops</div>
          </div>
          {/* Mobile menu toggle */}
          <button
            className="nav-toggle"
            aria-controls="nav"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(v => !v)}
            title={navOpen ? 'Close menu' : 'Open menu'}
          >
            {/* simple hamburger */}
            <span style={{display:'inline-block', width:20, height:2, background:'#111', position:'relative'}}>
              <span style={{content:'""', position:'absolute', left:0, right:0, top:-6, height:2, background:'#111'}}></span>
              <span style={{content:'""', position:'absolute', left:0, right:0, top:6, height:2, background:'#111'}}></span>
            </span>
          </button>
          <nav className={"nav" + (navOpen ? ' open' : '')} id="nav" style={{display:'flex', alignItems:'center', gap:8}}>
            {visibleTabs.map(t => (
              <button
                key={t.key}
                className={tab === t.key ? 'nav-btn active' : 'nav-btn'}
                style={{marginRight:8,background:tab===t.key?'#111':'#f5f5f5',color:tab===t.key?'#fff':'#222',border:'none',borderRadius:20,padding:'8px 18px',fontWeight:500,cursor:'pointer'}}
                onClick={() => {
                  const routes = { FuelOps: '/fuelops', Profile: '/profile', EmployeeControl: '/employee-control' };
                  navigate(routes[t.key] || '/fuelops');
                }}
              >
                {t.label}
              </button>
            ))}
            <div style={{marginLeft:16, fontSize:12, color:'#555'}}>{user.email} ({user.role})</div>
            <button onClick={logout} style={{marginLeft:8, background:'#f43f5e', color:'#fff', border:'none', borderRadius:20, padding:'6px 14px', cursor:'pointer'}}>Logout</button>
          </nav>
        </div>
      </header>
      <main className="wrap" id="main">
        <Routes>
          <Route path="/fuelops/*" element={<FuelOps perms={user?.role === 'EMPLOYEE' ? permissions : null} />} />
          <Route path="/profile" element={<Profile token={localStorage.getItem('authToken')} />} />
          {(user?.role === 'OWNER' || user?.role === 'ADMIN') && (
            <Route path="/employee-control" element={<EmployeeControl token={localStorage.getItem('authToken')} currentUserRole={user.role} currentUserId={user.id} />} />
          )}
          <Route path="*" element={<Navigate to="/fuelops" replace />} />
        </Routes>
      </main>
      <div id="toast" className="toast" style={{display:'none'}}></div>
    </>
  );
}

export default App;