import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSelector } from 'react-redux';
import type { RootState } from './store';
import { AuthPage } from '../features/auth/AuthPage';
import { DocumentsPage } from '../features/documents/DocumentsPage';
import { PracticePage } from '../features/practice/PracticePage';
import { MistakesPage } from '../features/mistakes/MistakesPage';

function TabLink({ to, label, icon }: { to: string; label: string; icon: string }) {
  return (
    <NavLink className={({ isActive }) => `tab ${isActive ? 'active' : ''}`} to={to}>
      <span className="tab-icon">{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

export function AppRoutes() {
  const username = useSelector((state: RootState) => state.auth.username);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">记</span>
          <div>
            <strong>FreeMemory</strong>
            <span className="muted">便携记背工具</span>
          </div>
        </div>
        <span className="muted">{username ?? '未登录'}</span>
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
        <TabLink to="/auth" label="账号" icon="👤" />
        <TabLink to="/documents" label="资料" icon="📄" />
        <TabLink to="/practice" label="练习" icon="✍️" />
        <TabLink to="/stats" label="统计" icon="📊" />
      </nav>
    </div>
  );
}
