import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { apiFetch } from '../../shared/api';
import type { RootState } from '../../app/store';

type Question = {
  questionId: string;
  stemHtml: string;
  stemText: string;
  blanks: { blankId: string; colorType: string; answerText: string }[];
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type QuestionsResponse = {
  documentId: string;
  title: string;
  pagination: Pagination;
  questions: Question[];
};

type SubmitResponse = {
  sessionId: string;
  total: number;
  correctCount: number;
  results: { blankId: string; correct: boolean; matchedRule: string; answerText: string }[];
};

export function PracticePage() {
  const token = useSelector((s: RootState) => s.auth.token);
  const [documentId, setDocumentId] = useState('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [index, setIndex] = useState(0);
  const [inputs, setInputs] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResponse | null>(null);

  const question = useMemo(() => questions[index], [questions, index]);

  const resetBlankState = (q?: Question) => {
    setInputs(q?.blanks.map(() => '') ?? []);
    setRevealed(false);
    setGraded(false);
    setSubmitResult(null);
  };

  const loadQuestions = async () => {
    if (!documentId || !token) return;
    setLoading(true);
    setError(null);
    try {
      // Load first page to get total count
      const first = await apiFetch<QuestionsResponse>(`/api/v1/documents/${documentId}/questions?page=1&pageSize=100`);
      let allQuestions = first.questions;

      // Load remaining pages if any
      if (first.pagination.totalPages > 1) {
        const remaining = await Promise.all(
          Array.from({ length: first.pagination.totalPages - 1 }, (_, i) =>
            apiFetch<QuestionsResponse>(`/api/v1/documents/${documentId}/questions?page=${i + 2}&pageSize=100`),
          ),
        );
        allQuestions = allQuestions.concat(remaining.flatMap((r) => r.questions));
      }

      setQuestions(allQuestions);
      setIndex(0);
      resetBlankState(allQuestions[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载题目失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    resetBlankState(question);
  }, [question]);

  const grade = async () => {
    if (!question || submitting) return;
    setRevealed(false);
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        questionId: question.questionId,
        answers: question.blanks.map((blank, i) => ({
          blankId: blank.blankId,
          userInput: (inputs[i] ?? '').trim(),
        })),
      };
      const res = await apiFetch<SubmitResponse>('/api/v1/practice/submit', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setSubmitResult(res);
      setGraded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交批改失败');
    } finally {
      setSubmitting(false);
    }
  };

  const next = () => {
    const nextIndex = index + 1;
    if (nextIndex >= questions.length) return;
    setIndex(nextIndex);
  };

  const correctCount = submitResult?.correctCount ?? 0;

  return (
    <section className="card stack">
      <header className="section-header">
        <span className="badge">练习模式</span>
        <h2>按文档练习真题</h2>
        <p className="muted">输入文档 ID 后加载已生成的真题，逐空回忆并提交批改。</p>
      </header>

      <div className="row row-stack-mobile">
        <label className="field-horize flex-1">
          <span>文档 ID</span>
          <input className="flex-1" value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="输入上传后返回的 documentId" />
        </label>
        <button className="btn primary" type="button" disabled={!documentId || loading} onClick={loadQuestions}>
          {loading ? '加载中...' : '加载题目'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!token && <p className="error">请先登录。</p>}

      {question ? (
        <div className="question-block">
          <span className="question-counter">{`第 ${index + 1} / ${questions.length} 题`}</span>
          <p className="stem">{question.stemText}</p>
          <div className="blank-grid">
            {question.blanks.map((blank, i) => {
              const resultItem = submitResult?.results.find((r) => r.blankId === blank.blankId);
              return (
                <label className="field" key={blank.blankId}>
                  <span className="blank-label">
                    <span className={`blank-dot ${blank.colorType === 'red' ? 'red' : 'blue'}`} />
                    空位 {i + 1}
                  </span>
                  <input
                    value={inputs[i] ?? ''}
                    onChange={(e) => setInputs((prev) => prev.map((old, idx) => (idx === i ? e.target.value : old)))}
                    placeholder="输入你的答案"
                  />
                  {graded && resultItem && (
                    <span className={resultItem.correct ? 'hint success' : 'hint error'}>
                      {resultItem.correct ? '✓ 正确' : `正确答案：${resultItem.answerText}`}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="row">
            <button className="btn" type="button" onClick={() => setRevealed((v) => !v)}>
              {revealed ? '隐藏参考' : '显示参考'}
            </button>
            <button className="btn primary" type="button" disabled={submitting} onClick={grade}>
              {submitting ? '提交中...' : '提交批改'}
            </button>
            <button className="btn" type="button" disabled={index >= questions.length - 1} onClick={next}>
              下一题
            </button>
          </div>

          {revealed && (
            <div className="answer-ref">
              <strong>参考答案：</strong>{question.blanks.map((b) => b.answerText).join(' · ')}
            </div>
          )}

          {graded && submitResult && (
            <div className="result-summary">
              <span className="result-score">{correctCount}/{submitResult.total}</span>
              <span className="muted">本次作答已记录，统计页会同步更新。</span>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">加载文档真题后即可开始练习。</p>
      )}
    </section>
  );
}
