import { FormEvent, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState, AppDispatch } from '../../app/store';
import { login, register } from './authSlice';
import { useNavigate } from 'react-router-dom';

export function AuthPage() {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const { loading, error, token } = useSelector((state: RootState) => state.auth);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      await dispatch(mode === 'login' ? login({ username, password }) : register({ username, password })).unwrap();
      setMessage(mode === 'login' ? '登录成功' : '注册成功');
      navigate('/documents', { replace: true });
    } catch {
      // error state handled in slice
    }
  };

  return (
    <section className="card stack">
      <header className="section-header">
        <span className="badge">账号</span>
        <h2>{mode === 'login' ? '登录畅记' : '注册新账号'}</h2>
        <p className="muted">登录后可上传 PDF、解析重点并生成真题。</p>
      </header>

      <div className="tabs">
        <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
        <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册</button>
      </div>

      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="2-64 个字符" autoComplete="username" />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        <button className="btn primary" disabled={loading} type="submit">
          {loading ? '提交中...' : mode === 'login' ? '登录' : '注册'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}
      {token && <p className="muted">当前已登录，可直接进入资料页上传 PDF。</p>}
    </section>
  );
}
