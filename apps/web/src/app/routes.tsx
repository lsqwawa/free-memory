import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSelector } from 'react-redux';
import type { RootState } from './store';
import { AuthPage } from '../features/auth/AuthPage';
import { DocumentsPage } from '../features/documents/DocumentsPage';
import { PracticePage } from '../features/practice/PracticePage';
import { MistakesPage } from '../features/mistakes/MistakesPage';

/* ---- SVG Tab Icons ---- */

const IconAccount = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a6 6 0 0 1 12 0v1" />
  </svg>
);

const IconDocument = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M10 13H8" />
    <path d="M16 17H8" />
    <path d="M16 13h-2" />
  </svg>
);

const IconPractice = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
);

const IconStats = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" />
    <path d="M7 16l4-8 4 4 4-10" />
  </svg>
);

/* ---- Tab Link ---- */

function TabLink({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <NavLink className={({ isActive }) => `tab ${isActive ? 'active' : ''}`} to={to}>
      <span className="tab-icon">{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

/* ---- App Routes ---- */

export function AppRoutes() {
  const username = useSelector((state: RootState) => state.auth.username);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">记</span>
          <div className="brand-text">
            <span className="brand-name">畅记</span>
            <span className="brand-sub">便携记背工具</span>
          </div>
        </div>
        <span className="topbar-user">{username ?? '未登录'}</span>
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<Navigate to="/auth" replace />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/stats" element={<MistakesPage />} />
          <Route path="*" element={<Navigate to="/auth" replace />} />
        </Routes>
      </main>

      <nav className="tabbar">
        <TabLink to="/auth" label="账号" icon={<IconAccount />} />
        <TabLink to="/documents" label="资料" icon={<IconDocument />} />
        <TabLink to="/practice" label="练习" icon={<IconPractice />} />
        <TabLink to="/stats" label="统计" icon={<IconStats />} />
      </nav>
    </div>
  );
}
