import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { apiFetch } from '../../shared/api';
import type { RootState } from '../../app/store';

type RecentSession = {
  id: string;
  total_count: number;
  correct_count: number;
  started_at: string;
};

type StatsResponse = {
  documentCount: number;
  parsedDocumentCount: number;
  questionCount: number;
  blankCount: number;
  totalAttempts: number;
  accuracy: number;
  correctTimes: number;
  wrongTimes: number;
  recentSessions: RecentSession[];
};

export function MistakesPage() {
  const token = useSelector((s: RootState) => s.auth.token);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<StatsResponse>('/api/v1/stats');
        if (!cancelled) setStats(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载统计失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <section className="card stack">
      <header className="stack small">
        <span className="badge">学习统计</span>
        <h2>看整体掌握情况</h2>
        <p className="muted">这里展示当前账号的资料数、真题数、正确率，以及最近的真实作答记录。</p>
      </header>

      {!token && <p className="error">请先登录后查看统计。</p>}
      {loading && <p className="muted">正在加载统计数据...</p>}
      {error && <p className="error">{error}</p>}

      {stats && (
        <>
          <div className="stat-grid">
            <article className="card subtle stack small">
              <span className="muted">资料数</span>
              <strong className="stat-value">{stats.documentCount}</strong>
              <span className="muted">其中已解析 {stats.parsedDocumentCount} 份</span>
            </article>
            <article className="card subtle stack small">
              <span className="muted">真题数</span>
              <strong className="stat-value">{stats.questionCount}</strong>
              <span className="muted">可练习空位 {stats.blankCount} 个</span>
            </article>
            <article className="card subtle stack small">
              <span className="muted">总作答数</span>
              <strong className="stat-value">{stats.totalAttempts}</strong>
              <span className="muted">正确 {stats.correctTimes} / 错误 {stats.wrongTimes}</span>
            </article>
            <article className="card subtle stack small">
              <span className="muted">正确率</span>
              <strong className="stat-value">{stats.accuracy}%</strong>
              <span className="muted">基于已记录的作答数据</span>
            </article>
          </div>

          <section className="card subtle stack">
            <header className="row between">
              <strong>最近练习</strong>
              <span className="muted">{stats.recentSessions.length} 条记录</span>
            </header>
            {stats.recentSessions.length === 0 ? (
              <p className="muted">还没有真实作答记录，先去练习页提交一次批改吧。</p>
            ) : (
              <div className="stack">
                {stats.recentSessions.map((s) => (
                  <article className="card stack small" key={s.id}>
                    <div className="row between">
                      <span className="badge">单题练习</span>
                      <span className="muted">{new Date(s.started_at).toLocaleString()}</span>
                    </div>
                    <p className="muted">正确 {s.correct_count} / 共 {s.total_count}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {!loading && !error && !stats && token && (
        <p className="muted">暂无统计信息。</p>
      )}
    </section>
  );
}
