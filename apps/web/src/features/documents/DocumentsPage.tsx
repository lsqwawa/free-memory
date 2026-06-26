import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { apiFetch } from '../../shared/api';
import type { RootState } from '../../app/store';

type UploadResponse = {
  documentId: string;
  status: string;
  knowledgePointCount?: number;
  blankSlotCount?: number;
  questionCount?: number;
};

type Question = {
  questionId: string;
  stemHtml: string;
  stemText: string;
  blanks: { blankId: string; colorType: string }[];
};

export function DocumentsPage() {
  const token = useSelector((s: RootState) => s.auth.token);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastDocId, setLastDocId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionLoading, setQuestionLoading] = useState(false);
  const disabled = useMemo(() => !token || !file || loading, [token, file, loading]);

  useEffect(() => {
    if (!lastDocId || !token) return;
    let cancelled = false;
    const load = async () => {
      setQuestionLoading(true);
      try {
        const res = await apiFetch<{ documentId: string; title: string; questions: Question[] }>(
          `/api/v1/documents/${lastDocId}/questions`
        );
        if (!cancelled) setQuestions(res.questions);
      } catch (err) {
        if (!cancelled) setMessage(err instanceof Error ? err.message : '加载真题失败');
      } finally {
        if (!cancelled) setQuestionLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [lastDocId, token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setMessage(null);
    setQuestions([]);
    try {
      const form = new FormData();
      form.append('file', file);
      if (title) form.append('title', title);
      const res = await apiFetch<UploadResponse>('/api/v1/documents/upload', {
        method: 'POST',
        body: form,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      setLastDocId(res.documentId);
      setMessage(`解析完成：${res.questionCount ?? 0} 道真题、${res.blankSlotCount ?? 0} 个重点空位。`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '上传失败';
      setMessage(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card stack">
      <header className="stack small">
        <span className="badge">资料库</span>
        <h2>上传 PDF</h2>
        <p className="muted">上传后系统会自动识别红蓝重点，并生成可练习的填空真题。</p>
      </header>

      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>文档标题（可选）</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="输入资料名称" />
        </label>
        <label className="upload-area">
          <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="upload-box">
            <strong>{file ? file.name : '点击或拖拽 PDF 到此区域'}</strong>
            <span className="muted">最大 20MB，仅支持 PDF</span>
          </div>
        </label>
        <button className="btn primary" disabled={disabled} type="submit">{loading ? '解析中...' : '上传并生成真题'}</button>
      </form>

      {message && <p className={message.startsWith('解析完成') ? 'success' : 'error'}>{message}</p>}
      {!token && <p className="error">请先登录后再上传资料。</p>}

      {lastDocId && (
        <section className="card subtle stack">
          <header className="row between">
            <strong>最新生成的真题</strong>
            <span className="muted">{questionLoading ? '加载中...' : `${questions.length} 题`}</span>
          </header>
          {questions.length === 0 && !questionLoading && <p className="muted">暂无题目，先上传一份带红蓝重点的 PDF。</p>}
          <div className="stack">
            {questions.map((q) => (
              <article className="card stack small" key={q.questionId}>
                <p className="stem">{q.stemText}</p>
                <div className="row">
                  {q.blanks.map((b, idx) => (
                    <span className={`badge ${b.colorType === 'red' ? 'badge-red' : 'badge-blue'}`} key={b.blankId}>
                      空位 {idx + 1}：{b.colorType === 'red' ? '红色重点' : '蓝色重点'}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
