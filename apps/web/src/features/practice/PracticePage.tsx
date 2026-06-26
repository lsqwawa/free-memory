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

type QuestionsResponse = {
  documentId: string;
  title: string;
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
      const res = await apiFetch<QuestionsResponse>(`/api/v1/documents/${documentId}/questions`);
      setQuestions(res.questions);
      setIndex(0);
      resetBlankState(res.questions[0]);
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
      <header className="stack small">
        <span className="badge">练习模式</span>
        <h2>按文档练习真题</h2>
        <p className="muted">输入文档 ID 后加载已生成的真题，再逐空回忆并提交真实批改。</p>
      </header>

      <div className="row">
        <label className="field grow">
          <span>文档 ID</span>
          <input value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="输入 /documents 上传后返回的 documentId" />
        </label>
        <button className="btn primary" type="button" disabled={!documentId || loading} onClick={loadQuestions}>{loading ? '加载中...' : '加载题目'}</button>
      </div>

      {error && <p className="error">{error}</p>}
      {!token && <p className="error">请先登录。</p>}

      {question ? (
        <div className="question-block">
          <p className="muted">{`第 ${index + 1} / ${questions.length} 题`}</p>
          <p className="stem">{question.stemText}</p>
          <div className="blank-grid">
            {question.blanks.map((blank, i) => {
              const resultItem = submitResult?.results.find((r) => r.blankId === blank.blankId);
              return (
                <label className="field" key={blank.blankId}>
                  <span>空位 {i + 1}（{blank.colorType === 'red' ? '红色重点' : '蓝色重点'}）</span>
                  <input
                    value={inputs[i] ?? ''}
                    onChange={(e) => setInputs((prev) => prev.map((old, idx) => (idx === i ? e.target.value : old)))}
                    placeholder="输入你的答案"
                  />
                  {graded && resultItem && (
                    <span className={resultItem.correct ? 'hint success' : 'hint error'}>
                      {resultItem.correct ? '回答正确' : `正确答案：${resultItem.answerText}`}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="row">
            <button className="btn" type="button" onClick={() => setRevealed((v) => !v)}>{revealed ? '隐藏参考' : '显示参考'}</button>
            <button className="btn primary" type="button" disabled={submitting} onClick={grade}>{submitting ? '提交中...' : '提交批改'}</button>
            <button className="btn" type="button" disabled={index >= questions.length - 1} onClick={next}>下一题</button>
          </div>

          {revealed && (
            <div className="card subtle">
              <p><strong>参考答案：</strong>{question.blanks.map((b) => b.answerText).join(' | ')}</p>
            </div>
          )}

          {graded && submitResult && (
            <div className="card subtle stack small">
              <p className="muted">本题结果：{correctCount}/{submitResult.total} 正确</p>
              <span className="muted">本次作答已写入后台，统计页会同步更新。</span>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">加载文档真题后即可开始练习。</p>
      )}
    </section>
  );
}
