import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { apiFetch } from '../../shared/api';
import type { RootState } from '../../app/store';

/* ---- Types ---- */

type DocumentItem = {
  id: string;
  title: string;
  status: string;
  errorMessage: string | null;
  questionCount: number;
  updatedAt: string;
};

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

type BlankItem = {
  blankId: string;
  originalText: string;
  answer: string;
};

type KnowledgePoint = {
  id: string;
  sectionTitle: string | null;
  contentText: string;
  contentHtml: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  orderIndex: number;
  isHighlight: boolean;
  blankCount: number;
  blanks: BlankItem[];
};

type KnowledgePointsResponse = {
  documentId: string;
  knowledgePoints: KnowledgePoint[];
};

/* ---- Status helpers ---- */

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  parsed: { label: '已解析', className: 'badge-status-parsed' },
  parsing: { label: '解析中', className: 'badge-status-parsing' },
  uploaded: { label: '解析中', className: 'badge-status-parsing' },
  queued: { label: '解析中', className: 'badge-status-parsing' },
  parse_failed: { label: '解析失败', className: 'badge-status-failed' },
};

function StatusBadge({ status }: { status: string }) {
  const info = STATUS_MAP[status] ?? { label: status, className: '' };
  return <span className={`badge ${info.className}`}>{info.label}</span>;
}

/* ---- Knowledge Point Card ---- */

function KnowledgePointCard({
  kp,
  onUpdate,
  onDelete,
  onBlankCountChange,
}: {
  kp: KnowledgePoint;
  onUpdate: (id: string, data: Partial<KnowledgePoint>) => void;
  onDelete: (id: string) => void;
  onBlankCountChange?: (id: string, delta: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(kp.sectionTitle || '');
  const [editContent, setEditContent] = useState(kp.contentText);
  const [saving, setSaving] = useState(false);
  const [localBlanks, setLocalBlanks] = useState<BlankItem[]>(kp.blanks ?? []);
  const [generatingBlanks, setGeneratingBlanks] = useState(false);

  // Sync blanks when kp changes
  if (JSON.stringify(kp.blanks) !== JSON.stringify(localBlanks) && !generatingBlanks) {
    setLocalBlanks(kp.blanks ?? []);
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch(`/api/v1/knowledge-points/${kp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sectionTitle: editTitle,
          contentText: editContent,
          contentHtml: `<p>${editContent}</p>`,
        }),
      });
      onUpdate(kp.id, { sectionTitle: editTitle, contentText: editContent });
      setEditing(false);
    } catch {
      // keep editing mode
    } finally {
      setSaving(false);
    }
  };

  const handleToggleHighlight = async () => {
    try {
      await apiFetch(`/api/v1/knowledge-points/${kp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isHighlight: !kp.isHighlight }),
      });
      onUpdate(kp.id, { isHighlight: !kp.isHighlight });
    } catch {
      // ignore
    }
  };

  const handleDeleteClick = async () => {
    if (!window.confirm('确定删除该知识点？关联的题目也会一并删除，此操作不可恢复。')) return;
    onDelete(kp.id);
  };

  const handleDeleteBlank = async (blankId: string) => {
    try {
      await apiFetch(`/api/v1/blanks/${blankId}`, { method: 'DELETE' });
      setLocalBlanks((prev) => prev.filter((b) => b.blankId !== blankId));
      onBlankCountChange?.(kp.id, -1);
    } catch {
      // ignore
    }
  };

  const handleGenerateBlanks = async () => {
    setGeneratingBlanks(true);
    try {
      const res = await apiFetch<{ blankSlotCount: number; questionCount: number }>(
        `/api/v1/knowledge-points/${kp.id}/generate-blanks`,
        { method: 'POST' },
      );
      // Reload blanks from server
      onUpdate(kp.id, { blankCount: res.blankSlotCount });
      // Trigger a re-fetch by updating with empty data - parent will reload
      window.location.reload();
    } catch {
      // ignore
    } finally {
      setGeneratingBlanks(false);
    }
  };

  return (
    <article className={`card subtle stack small kp-card ${kp.isHighlight ? 'kp-highlight' : ''}`}>
      <header className="row between" style={{ alignItems: 'center' }}>
        <div className="row" style={{ gap: '6px', alignItems: 'center', flex: 1, minWidth: 0 }}>
          {kp.isHighlight && <span className="badge badge-star">★ 重点</span>}
          {kp.pageFrom && <span className="muted" style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>P{kp.pageFrom}</span>}
          {editing ? (
            <input
              className="kp-title-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="知识点标题"
            />
          ) : (
            <strong className="kp-title">{kp.sectionTitle || '未命名知识点'}</strong>
          )}
        </div>
        <div className="row" style={{ gap: '4px', flexShrink: 0 }}>
          <button className="icon-btn" title={kp.isHighlight ? '取消重点' : '标记为重点'} onClick={handleToggleHighlight}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill={kp.isHighlight ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
          {editing ? (
            <>
              <button className="icon-btn" title="保存" onClick={handleSave} disabled={saving}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button className="icon-btn" title="取消" onClick={() => { setEditing(false); setEditTitle(kp.sectionTitle || ''); setEditContent(kp.contentText); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <button className="icon-btn" title="编辑" onClick={() => setEditing(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              <button className="icon-btn icon-btn-danger" title="删除" onClick={handleDeleteClick}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </>
          )}
        </div>
      </header>

      {editing ? (
        <textarea
          className="kp-content-textarea"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          rows={4}
        />
      ) : (
        <p className="kp-content">{kp.contentText}</p>
      )}

      {/* Blanks section */}
      <div className="kp-blanks-section">
        <div className="row between" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: '12px' }}>
            填空项（{localBlanks.length} 个空位）
          </span>
          <button
            className="btn btn-sm"
            onClick={handleGenerateBlanks}
            disabled={generatingBlanks}
            type="button"
          >
            {generatingBlanks ? '生成中..' : '🔄 自动生成填空'}
          </button>
        </div>
        {localBlanks.length > 0 ? (
          <div className="kp-blank-chips">
            {localBlanks.map((blank) => (
              <span className="kp-blank-chip" key={blank.blankId}>
                <code>{blank.originalText}</code>
                <button
                  className="kp-blank-remove"
                  onClick={() => handleDeleteBlank(blank.blankId)}
                  title="删除此填空项"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className="muted" style={{ fontSize: '12px' }}>暂无填空项，点击上方按钮自动生成</span>
        )}
      </div>
    </article>
  );
}

/* ---- Document Item ---- */

function DocumentItem({
  doc,
  onCopyId,
  onReparse,
  onDelete,
  onViewDetail,
}: {
  doc: DocumentItem;
  onCopyId: (id: string) => void;
  onReparse: (id: string) => void;
  onDelete: (id: string) => void;
  onViewDetail: (id: string) => void;
}) {
  const isParsing = doc.status === 'parsing' || doc.status === 'uploaded' || doc.status === 'queued';

  return (
    <div className="doc-list-item" onClick={() => onViewDetail(doc.id)}>
      <div className="doc-info">
        <strong className="doc-title">{doc.title || '未命名文档'}</strong>
        <div className="doc-meta">
          <StatusBadge status={doc.status} />
          {doc.status === 'parsed' && (
            <span className="muted">{doc.questionCount} 题</span>
          )}
          {doc.status === 'parse_failed' && doc.errorMessage && (
            <span className="error" style={{ fontSize: '12px' }}>{doc.errorMessage}</span>
          )}
        </div>
      </div>
      <div className="doc-actions" onClick={(e) => e.stopPropagation()}>
        {doc.status === 'parse_failed' && (
          <button
            className="icon-btn"
            title="重新解析"
            onClick={() => onReparse(doc.id)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        )}
        {isParsing && (
          <span className="loading-pulse" style={{ fontSize: '14px' }}>⏳</span>
        )}
        <button
          className="icon-btn"
          title="复制文档 ID"
          onClick={() => onCopyId(doc.id)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button
          className="icon-btn icon-btn-danger"
          title="删除文档"
          onClick={() => onDelete(doc.id)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ---- Document Detail (with Knowledge Points editing) ---- */

function DocumentDetail({
  docId,
  onBack,
}: {
  docId: string;
  onBack: () => void;
}) {
  const token = useSelector((s: RootState) => s.auth.token);
  const [knowledgePoints, setKnowledgePoints] = useState<KnowledgePoint[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'points' | 'questions'>('points');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);

  // Load knowledge points
  useEffect(() => {
    if (!docId || !token) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<KnowledgePointsResponse>(
          `/api/v1/documents/${docId}/knowledge-points`,
        );
        if (!cancelled) {
          setKnowledgePoints(res.knowledgePoints);
          setTitle(''); // will be set from questions or left empty
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载知识点失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [docId, token]);

  // Load questions when switching to questions view
  useEffect(() => {
    if (viewMode !== 'questions' || !docId || !token) return;
    let cancelled = false;
    const load = async () => {
      setQuestionsLoading(true);
      try {
        const first = await apiFetch<QuestionsResponse>(
          `/api/v1/documents/${docId}/questions?page=1&pageSize=100`,
        );
        let allQuestions = first.questions;
        setTitle(first.title);

        if (first.pagination.totalPages > 1) {
          const remaining = await Promise.all(
            Array.from({ length: first.pagination.totalPages - 1 }, (_, i) =>
              apiFetch<QuestionsResponse>(`/api/v1/documents/${docId}/questions?page=${i + 2}&pageSize=100`),
            ),
          );
          allQuestions = allQuestions.concat(remaining.flatMap((r) => r.questions));
        }

        if (!cancelled) setQuestions(allQuestions);
      } catch {
        // handled by main error state
      } finally {
        if (!cancelled) setQuestionsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [viewMode, docId, token]);

  const handleUpdateKp = useCallback((id: string, data: Partial<KnowledgePoint>) => {
    setKnowledgePoints((prev) =>
      prev.map((kp) => (kp.id === id ? { ...kp, ...data } : kp)),
    );
  }, []);

  const handleDeleteKp = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/v1/knowledge-points/${id}`, { method: 'DELETE' });
      setKnowledgePoints((prev) => prev.filter((kp) => kp.id !== id));
    } catch {
      // ignore
    }
  }, []);

  const highlightCount = knowledgePoints.filter((kp) => kp.isHighlight).length;

  return (
    <section className="card stack">
      <header className="row between" style={{ alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: '4px' }}>
          <span className="badge">文档详情</span>
          <h2 style={{ margin: 0, fontSize: '18px' }}>{title || '知识点管理'}</h2>
        </div>
        <button className="btn" type="button" onClick={onBack}>
          ← 返回列表
        </button>
      </header>

      {/* View mode toggle */}
      <div className="row" style={{ gap: '8px' }}>
        <button
          className={`btn ${viewMode === 'points' ? 'primary' : ''}`}
          onClick={() => setViewMode('points')}
          type="button"
        >
          知识点管理 ({knowledgePoints.length})
        </button>
        <button
          className={`btn ${viewMode === 'questions' ? 'primary' : ''}`}
          onClick={() => setViewMode('questions')}
          type="button"
        >
          填空题 ({knowledgePoints.reduce((sum, kp) => sum + kp.blankCount, 0)})
        </button>
      </div>

      {loading && <p className="muted loading-pulse">正在加载...</p>}
      {error && <p className="error">{error}</p>}

      {/* Knowledge Points View */}
      {viewMode === 'points' && !loading && !error && (
        <>
          {knowledgePoints.length === 0 && (
            <p className="muted">暂无知识点，该文档可能尚未完成解析。</p>
          )}
          {knowledgePoints.length > 0 && (
            <>
              <div className="row" style={{ gap: '12px' }}>
                <span className="muted">共 {knowledgePoints.length} 个知识点</span>
                {highlightCount > 0 && (
                  <span className="badge badge-star">★ {highlightCount} 个重点</span>
                )}
              </div>
              <div className="stack">
                {knowledgePoints.map((kp) => (
                  <KnowledgePointCard
                    key={kp.id}
                    kp={kp}
                    onUpdate={handleUpdateKp}
                    onDelete={handleDeleteKp}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Questions View */}
      {viewMode === 'questions' && (
        <>
          {questionsLoading && <p className="muted loading-pulse">正在加载题目...</p>}
          {!questionsLoading && questions.length === 0 && (
            <p className="muted">暂无题目。</p>
          )}
          {questions.length > 0 && (
            <div className="stack">
              <span className="muted">共 {questions.length} 道真题</span>
              {questions.map((q, idx) => (
                <article className="card subtle stack small" key={q.questionId} style={{ animationDelay: `${idx * 0.06}s` }}>
                  <p className="stem">{q.stemText}</p>
                  <div className="row">
                    {q.blanks.map((b) => (
                      <span className="badge badge-red" key={b.blankId}>
                        重点：{b.answerText}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ---- Main Page ---- */

export function DocumentsPage() {
  const token = useSelector((s: RootState) => s.auth.token);

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const uploadDisabled = useMemo(() => !token || !file || uploading, [token, file, uploading]);
  // Upload tab state
  type UploadTab = 'pdf' | 'text' | 'image';
  const [activeTab, setActiveTab] = useState<UploadTab>('pdf');

  // Text input state
  const [textContent, setTextContent] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const textSubmitDisabled = useMemo(() => !token || textContent.trim().length < 10 || uploading, [token, textContent, uploading]);

  // Image upload state
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageTitle, setImageTitle] = useState('');
  const imageSubmitDisabled = useMemo(() => !token || !imageFile || uploading, [token, imageFile, uploading]);

  // Document list state
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Detail view state
  const [detailDocId, setDetailDocId] = useState<string | null>(null);

  // Copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /* ---- Load document list ---- */

  const loadDocuments = useCallback(async () => {
    if (!token) return;
    setListLoading(true);
    setListError(null);
    try {
      const res = await apiFetch<{ documents: DocumentItem[] }>('/api/v1/documents');
      setDocuments(res.documents);
    } catch (err) {
      setListError(err instanceof Error ? err.message : '加载文档列表失败');
    } finally {
      setListLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  /* ---- Upload ---- */

  const submitUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !token) return;
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('pdf', file);
      if (title.trim()) form.append('title', title.trim());
      const res = await apiFetch<UploadResponse>('/api/v1/documents/upload', {
        method: 'POST',
        body: form,
      });
      if (res.status === 'parsed' && res.questionCount != null) {
        setMessage(`上传完成：${res.questionCount} 道真题，${res.blankSlotCount ?? 0} 个重点空位。`);
      } else {
        setMessage('上传成功，文档正在后台解析中，请稍候..');
      }
      setFile(null);
      setTitle('');
      loadDocuments();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };


  const submitText = async (e: FormEvent) => {
    e.preventDefault();
    if (!textContent.trim() || !token) return;
    setUploading(true);
    setMessage(null);
    try {
      const res = await apiFetch<UploadResponse>('/api/v1/documents/text', {
        method: 'POST',
        body: JSON.stringify({ title: textTitle.trim() || undefined, textContent: textContent.trim() }),
      });
      if (res.status === 'parsed' && res.questionCount != null) {
        setMessage(`文本解析完成：${res.questionCount} 道真题，${res.blankSlotCount ?? 0} 个重点空位。`);
      } else {
        setMessage('文本提交成功，正在解析中，请稍候..');
      }
      setTextContent('');
      setTextTitle('');
      loadDocuments();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '文本提交失败');
    } finally {
      setUploading(false);
    }
  };

  const submitImage = async (e: FormEvent) => {
    e.preventDefault();
    if (!imageFile || !token) return;
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('image', imageFile);
      if (imageTitle.trim()) form.append('title', imageTitle.trim());
      const res = await apiFetch<UploadResponse>('/api/v1/documents/image', {
        method: 'POST',
        body: form,
      });
      if (res.status === 'parsed' && res.questionCount != null) {
        setMessage(`图片识别完成：${res.questionCount} 道真题，${res.blankSlotCount ?? 0} 个重点空位。`);
      } else {
        setMessage('图片上传成功，正在OCR识别中，请稍候..');
      }
      setImageFile(null);
      setImageTitle('');
      loadDocuments();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '图片上传失败');
    } finally {
      setUploading(false);
    }
  };

  /* ---- Actions ---- */

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      const input = document.createElement('input');
      input.value = id;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const handleReparse = async (id: string) => {
    try {
      await apiFetch(`/api/v1/documents/${id}/reparse`, { method: 'POST' });
      loadDocuments();
    } catch (err) {
      setListError(err instanceof Error ? err.message : '重新解析失败');
    }
  };

  const handleDelete = async (id: string) => {
    const doc = documents.find((d) => d.id === id);
    const docTitle = doc?.title || '未命名文档';
    if (!window.confirm(`确定要删除《${docTitle}》吗？此操作不可恢复。`)) return;
    try {
      await apiFetch(`/api/v1/documents/${id}`, { method: 'DELETE' });
      loadDocuments();
    } catch (err) {
      setListError(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleViewDetail = (id: string) => {
    setDetailDocId(id);
  };

  /* ---- Render ---- */

  if (detailDocId) {
    return <DocumentDetail docId={detailDocId} onBack={() => setDetailDocId(null)} />;
  }

  return (
    <section className="card stack">
      <header className="section-header">
        <span className="badge">资料库</span>
        <h2>添加学习资料</h2>
        <p className="muted">支持 PDF 上传、文本输入、图片识别三种方式，系统会自动提取知识点并生成填空真题。</p>
      </header>

      <div className="upload-tabs">
        <button className={`upload-tab ${activeTab === 'pdf' ? 'active' : ''}`} onClick={() => { setActiveTab('pdf'); setMessage(null); }}>📄 PDF 上传</button>
        <button className={`upload-tab ${activeTab === 'text' ? 'active' : ''}`} onClick={() => { setActiveTab('text'); setMessage(null); }}>📝 文本输入</button>
        <button className={`upload-tab ${activeTab === 'image' ? 'active' : ''}`} onClick={() => { setActiveTab('image'); setMessage(null); }}>🖼️ 图片识别</button>
      </div>

      {activeTab === 'pdf' && (
        <form className="stack" onSubmit={submitUpload}>
          <label className="field">
            <span>文档标题（可选，不填写默认使用文件名称）</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="输入资料名称" />
          </label>
          <label className="upload-area">
            <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="upload-box">
              <span className="upload-icon">{file ? '📄' : '📁'}</span>
              <strong>{file ? file.name : '点击或拖拽 PDF 到此区域'}</strong>
              <span className="upload-hint">最大 20MB，仅支持 PDF</span>
            </div>
          </label>
          <button className="btn primary" disabled={uploadDisabled} type="submit">
            {uploading ? '上传中..' : '上传并生成真题'}
          </button>
        </form>
      )}

      {activeTab === 'text' && (
        <form className="stack" onSubmit={submitText}>
          <label className="field">
            <span>资料标题（可选）</span>
            <input value={textTitle} onChange={(e) => setTextTitle(e.target.value)} placeholder="输入资料名称" />
          </label>
          <label className="field">
            <span>粘贴或输入学习内容</span>
            <textarea
              className="text-input-area"
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="在此粘贴或输入备考知识点内容，支持带序号的条目格式（如 1. 2. 3.）..."
              rows={10}
            />
            <span className="muted" style={{ fontSize: '12px' }}>{textContent.length} 字符</span>
          </label>
          <button className="btn primary" disabled={textSubmitDisabled} type="submit">
            {uploading ? '解析中..' : '提交并生成真题'}
          </button>
        </form>
      )}

      {activeTab === 'image' && (
        <form className="stack" onSubmit={submitImage}>
          <label className="field">
            <span>资料标题（可选）</span>
            <input value={imageTitle} onChange={(e) => setImageTitle(e.target.value)} placeholder="输入资料名称" />
          </label>
          <label className="upload-area">
            <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
            <div className="upload-box">
              <span className="upload-icon">{imageFile ? '🖼️' : '📷'}</span>
              <strong>{imageFile ? imageFile.name : '点击或拖拽图片到此区域'}</strong>
              <span className="upload-hint">最大 10MB，支持 JPG/PNG/WEBP，AI 会识别图片中的文字</span>
            </div>
          </label>
          <button className="btn primary" disabled={imageSubmitDisabled} type="submit">
            {uploading ? '识别中..' : '上传并识别真题'}
          </button>
        </form>
      )}

      {message && <p className={message.includes('完成') || message.includes('成功') ? 'success' : 'error'}>{message}</p>}
      {!token && <p className="error">请先登录后再添加资料。</p>}

      <section className="card subtle stack">
        <header className="row between">
          <strong>我的资料（点击查看详情）</strong>
          <span className="muted">
            {listLoading ? '加载中..' : `${documents.length} 份资料`}
          </span>
        </header>

        {listError && <p className="error">{listError}</p>}

        {!listLoading && documents.length === 0 && (
          <p className="muted">暂无资料，请添加学习资料。</p>
        )}

        <div className="stack small">
          {documents.map((doc) => (
            <DocumentItem
              key={doc.id}
              doc={doc}
              onCopyId={handleCopyId}
              onReparse={handleReparse}
              onDelete={handleDelete}
              onViewDetail={handleViewDetail}
            />
          ))}
        </div>

        {copiedId && (
          <p className="success">已复制文档 ID：{copiedId}</p>
        )}
      </section>
    </section>
  );
}
