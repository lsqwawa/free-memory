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

  const statCards = stats
    ? [
        { label: '资料数', value: stats.documentCount, detail: `已解析 ${stats.parsedDocumentCount} 份` },
        { label: '真题数', value: stats.questionCount, detail: `可练习 ${stats.blankCount} 空` },
        { label: '总作答', value: stats.totalAttempts, detail: `正确 ${stats.correctTimes} / 错误 ${stats.wrongTimes}` },
        { label: '正确率', value: `${stats.accuracy}%`, detail: '基于已记录数据' },
      ]
    : [];

  return (
    <section className="card stack">
      <header className="section-header">
        <span className="badge">学习统计</span>
        <h2>看整体掌握情况</h2>
        <p className="muted">当前账号的资料数、真题数、正确率，以及最近的作答记录。</p>
      </header>

      {!token && <p className="error">请先登录后查看统计。</p>}
      {loading && <p className="muted loading-pulse">正在加载统计数据...</p>}
      {error && <p className="error">{error}</p>}

      {stats && (
        <>
          <div className="stat-grid">
            {statCards.map((card, idx) => (
              <article className="card subtle stack small" key={card.label} style={{ animationDelay: `${idx * 0.08}s` }}>
                <span className="stat-label">{card.label}</span>
                <strong className="stat-value">{card.value}</strong>
                <span className="stat-detail">{card.detail}</span>
              </article>
            ))}
          </div>

          <section className="card subtle stack">
            <header className="row between">
              <strong>最近练习</strong>
              <span className="muted">{stats.recentSessions.length} 条记录</span>
            </header>
            {stats.recentSessions.length === 0 ? (
              <p className="muted">还没有作答记录，先去练习页提交一次批改吧。</p>
            ) : (
              <div className="stack small">
                {stats.recentSessions.map((s) => (
                  <div className="session-item" key={s.id}>
                    <div className="stack small" style={{ gap: '4px' }}>
                      <span className="badge">单题练习</span>
                      <span className="muted" style={{ fontSize: '12px' }}>
                        {new Date(s.started_at).toLocaleString()}
                      </span>
                    </div>
                    <span className="stat-label">
                      正确 <strong style={{ color: 'var(--accent)' }}>{s.correct_count}</strong> / 共 {s.total_count}
                    </span>
                  </div>
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
