import './App.css';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type AppConfig = {
  appName: string;
  jurisdiction: string;
  aiEnabled: boolean;
  externalAiEnabled?: boolean;
  storageMode: string;
  analysisMode?: 'hybrid-ai' | 'local-rag';
};

type DocumentItem = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  size: number;
  sourceType: string;
  storageProvider: string;
  sourceUrl: string;
  summary: string;
  articleCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

type ConversationItem = {
  id: string;
  title: string;
  lastQuestion?: string;
  lastMessage?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

type Citation = {
  documentId: string;
  title: string;
  fileName: string;
  articleNo?: string | null;
  articleTitle?: string | null;
  sourceLabel?: string | null;
  excerpt: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  createdAt: string;
};

type ConversationDetail = {
  id: string;
  title: string;
  lastQuestion?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

type AskResponse = {
  conversationId: string;
  answer: string;
  citations: Citation[];
  usedAi: boolean;
  hitsConsidered: number;
};

type SearchResultItem = Citation & {
  score: number;
};

type SearchPreview = {
  items: SearchResultItem[];
  answerPreview?: string;
  citations?: Citation[];
  usedAi?: boolean;
  hitsConsidered?: number;
};

const api = axios.create({ baseURL: '/api/v1' });

const quickPrompts = [
  'ما هي إجراءات إثبات ملكية أرض في القانون اليمني؟',
  'ما حقوق العامل عند الفصل التعسفي وفق قانون العمل اليمني؟',
  'كيف أرفع دعوى مدنية أمام المحكمة المختصة في اليمن؟',
  'ما الفرق بين العقد العرفي والعقد الرسمي من حيث الحجية والإثبات؟',
];

const followUpPrompts = [
  'ما المستندات التي يجب تجهيزها لهذه القضية؟',
  'ما الدفوع التي قد يتمسك بها الطرف الآخر؟',
  'ما الخطوات الإجرائية التالية والأولوية بينها؟',
];

document.documentElement.lang = 'ar';
document.documentElement.dir = 'rtl';

function formatCompactDate(value?: string) {
  if (!value) return 'الآن';
  try {
    return new Date(value).toLocaleTimeString('ar-YE', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return value;
  }
}

function truncate(value: string, max = 60) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export default function App() {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<string>('');
  const [question, setQuestion] = useState('');
  const [debouncedQuestion, setDebouncedQuestion] = useState('');
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadQuestion, setUploadQuestion] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});

  const config = useQuery<AppConfig>({
    queryKey: ['app-config'],
    queryFn: async () => (await api.get('/app/config')).data,
  });

  const conversations = useQuery<{ items: ConversationItem[] }>({
    queryKey: ['conversations'],
    queryFn: async () => (await api.get('/conversations')).data,
  });

  const documents = useQuery<{ items: DocumentItem[] }>({
    queryKey: ['documents'],
    queryFn: async () => (await api.get('/documents')).data,
  });

  const activeConversation = useQuery<ConversationDetail>({
    queryKey: ['conversation', activeConversationId],
    enabled: Boolean(activeConversationId),
    queryFn: async () => (await api.get(`/conversations/${activeConversationId}`)).data,
  });

  useEffect(() => {
    if (!activeConversationId && conversations.data?.items?.length) {
      setActiveConversationId(conversations.data.items[0].id);
    }
  }, [activeConversationId, conversations.data?.items]);

  useEffect(() => {
    const appName = config.data?.appName?.trim();
    if (appName) document.title = appName;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) {
      meta.setAttribute('content', 'منصة استشارة وبحث قانوني مدعومة بالذكاء الاصطناعي لتحليل الأسئلة القانونية والبحث داخل الوثائق والمصادر اليمنية المرفوعة.');
    }
  }, [config.data?.appName]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuestion(question.trim()), 320);
    return () => window.clearTimeout(timer);
  }, [question]);

  const askMutation = useMutation({
    mutationFn: async (payload?: { question?: string }) => {
      const outgoingQuestion = (payload?.question ?? question).trim();
      if (!outgoingQuestion) throw new Error('اكتب السؤال القانوني أولاً');
      return (await api.post<AskResponse>('/ask', {
        question: outgoingQuestion,
        conversationId: activeConversationId || undefined,
        documentIds: selectedDocumentIds.length ? selectedDocumentIds : undefined,
      })).data;
    },
    onSuccess: async (data) => {
      setQuestion('');
      setDebouncedQuestion('');
      setActiveConversationId(data.conversationId);
      setSidebarOpen(false);
      setExpandedSources((current) => ({ ...current, [data.conversationId]: true }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', data.conversationId] }),
      ]);
      setError('');
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? err?.message ?? 'تعذر توليد الإجابة القانونية'),
  });

  const newConversationMutation = useMutation({
    mutationFn: async () => (await api.post('/conversations', { title: 'محادثة قانونية جديدة' })).data,
    onSuccess: async (data) => {
      setActiveConversationId(data.item.id);
      setSidebarOpen(false);
      setQuestion('');
      setDebouncedQuestion('');
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!uploadFile) throw new Error('اختر ملفاً أولاً');
      const form = new FormData();
      form.append('file', uploadFile);
      if (uploadTitle.trim()) form.append('title', uploadTitle.trim());
      if (uploadQuestion.trim()) form.append('question', uploadQuestion.trim());
      return (await api.post('/documents/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } })).data;
    },
    onSuccess: async (data) => {
      setUploadFile(null);
      setUploadTitle('');
      setUploadQuestion('');
      const input = document.getElementById('file-input') as HTMLInputElement | null;
      if (input) input.value = '';
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
      if (data?.answer?.conversationId) {
        setActiveConversationId(data.answer.conversationId);
        await queryClient.invalidateQueries({ queryKey: ['conversation', data.answer.conversationId] });
      }
      setError('');
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? err?.message ?? 'فشل رفع الملف أو تحليله'),
  });

  const searchPreview = useQuery<SearchPreview>({
    queryKey: ['search-preview', debouncedQuestion, selectedDocumentIds.join(',')],
    enabled: debouncedQuestion.length >= 3,
    queryFn: async () => (await api.post('/search', {
      query: debouncedQuestion,
      documentIds: selectedDocumentIds.length ? selectedDocumentIds : undefined,
    })).data,
    staleTime: 15_000,
  });

  const activeMessages = activeConversation.data?.messages ?? [];

  const selectedDocuments = useMemo(() => {
    const map = new Set(selectedDocumentIds);
    return (documents.data?.items ?? []).filter((item) => map.has(item.id));
  }, [documents.data?.items, selectedDocumentIds]);

  const latestAssistantMessageId = [...activeMessages].reverse().find((message) => message.role === 'assistant')?.id;
  const assistantModeLabel = config.data?.analysisMode === 'hybrid-ai'
    ? 'تحليل قانوني متقدم متصل'
    : 'المحلل القانوني المحلي مفعل';
  const showLiveSearch = debouncedQuestion.length >= 3 && !askMutation.isPending;

  const handlePresetQuestion = (text: string) => {
    setQuestion(text);
    askMutation.mutate({ question: text });
  };

  const toggleSourceBlock = (messageId: string) => {
    setExpandedSources((current) => ({
      ...current,
      [messageId]: !(current[messageId] ?? true),
    }));
  };

  return (
    <div className="app-container shell-theme">
      <div className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed-mobile'}`}>
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="brand-icon">⚖</div>
            <div className="brand-text">
              <h1>{config.data?.appName ?? 'AI Legal Search Yemen'}</h1>
              <p>مستشار قانوني ذكي شبيه بتجربة ChatGPT مع بحث موثّق</p>
            </div>
          </div>

          <button className="new-chat-btn" onClick={() => newConversationMutation.mutate()}>
            <span>＋</span>
            <span>{newConversationMutation.isPending ? 'جارٍ الإنشاء...' : 'محادثة قانونية جديدة'}</span>
          </button>
        </div>

        <div className="conversations-list">
          <div className="conv-section-title">المحادثات</div>
          {(conversations.data?.items ?? []).map((item) => (
            <button
              key={item.id}
              className={`conv-item ${activeConversationId === item.id ? 'active' : ''}`}
              onClick={() => {
                setActiveConversationId(item.id);
                setSidebarOpen(false);
              }}
            >
              <span className="conv-item-icon">💬</span>
              <span className="conv-item-text">
                <strong>{truncate(item.title, 42)}</strong>
                <small>{item.messageCount} رسالة</small>
              </span>
            </button>
          ))}
          {!conversations.data?.items?.length && <div className="empty-note">لا توجد محادثات محفوظة بعد</div>}

          <div className="conv-section-title documents-title">مصادر البحث</div>
          {(documents.data?.items ?? []).map((doc) => {
            const active = selectedDocumentIds.includes(doc.id);
            return (
              <button
                key={doc.id}
                className={`document-tile ${active ? 'active' : ''}`}
                onClick={() => setSelectedDocumentIds((current) => active ? current.filter((id) => id !== doc.id) : [...current, doc.id])}
              >
                <div className="document-tile-top">
                  <strong>{truncate(doc.title, 34)}</strong>
                  <span>{active ? 'محدد' : 'عام'}</span>
                </div>
                <p>{truncate(doc.summary || doc.fileName, 82)}</p>
              </button>
            );
          })}
          {!documents.data?.items?.length && <div className="empty-note">ارفع وثائقك القانونية ليبدأ التحليل الذكي عليها</div>}
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-footer-btn" type="button">
            <span>📚</span>
            <span>{documents.data?.items?.length ?? 0} وثيقة مفهرسة</span>
          </button>
          <button className="sidebar-footer-btn" type="button">
            <span>🤖</span>
            <span>{assistantModeLabel}</span>
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="chat-header">
          <button className="toggle-sidebar-btn" onClick={() => setSidebarOpen((value) => !value)}>☰</button>

          <div className="header-info">
            <h2>{activeConversation.data?.title || config.data?.appName || 'المستشار القانوني الذكي'}</h2>
            <div className="header-status">
              <span className="status-dot" />
              <span>
                {config.data?.jurisdiction ?? 'اليمن'} · {assistantModeLabel}
              </span>
            </div>
          </div>

          <div className="header-actions">
            <div className="header-chip">
              <strong>{documents.data?.items?.length ?? 0}</strong>
              <span>وثيقة</span>
            </div>
            <div className="header-chip">
              <strong>{conversations.data?.items?.length ?? 0}</strong>
              <span>محادثة</span>
            </div>
            <div className="header-chip accent-chip">
              <strong>{searchPreview.data?.hitsConsidered ?? 0}</strong>
              <span>نتيجة فورية</span>
            </div>
          </div>
        </header>

        <div className="messages-container">
          <div className="messages-inner">
            {!activeMessages.length && (
              <div className="welcome-screen">
                <div className="welcome-icon">⚖</div>
                <h3>مستشارك القانوني الذكي لفهم الوقائع وبناء الرأي القانوني</h3>
                <p>
                  اطرح سؤالك كما تشرحه لمحامٍ يمني، أو ارفع عقداً أو حكماً أو لائحة، وسيتم تحليل الوقائع والمواد ذات الصلة وتقديم توصية عملية واضحة مع عرض المصادر المعتمدة.
                </p>

                {!!selectedDocuments.length && (
                  <div className="selected-docs-strip">
                    {selectedDocuments.map((doc) => (
                      <span key={doc.id} className="selected-doc-chip">{doc.title}</span>
                    ))}
                  </div>
                )}

                <div className="welcome-cards">
                  {quickPrompts.map((item, index) => (
                    <button key={item} className="welcome-card" onClick={() => handlePresetQuestion(item)}>
                      <div className="welcome-card-icon">{['🏛', '📋', '📜', '📝'][index] ?? '⚖'}</div>
                      <div>
                        <strong>{truncate(item, 48)}</strong>
                        <p>تحليل مباشر مع ربط الوقائع بالنصوص القانونية ونتائج بحث فورية من المواد ذات الصلة</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeMessages.map((message) => {
              const isAssistant = message.role === 'assistant';
              const sourcesOpen = expandedSources[message.id] ?? true;
              const showFollowups = isAssistant && message.id === latestAssistantMessageId;

              return (
                <article key={message.id} className={`message-row ${message.role}`}>
                  <div className="message-avatar">{message.role === 'user' ? '👤' : '⚖'}</div>
                  <div className="message-content">
                    <div className="message-sender">{message.role === 'user' ? 'أنت' : 'المستشار القانوني الذكي'}</div>
                    <div className={`message-bubble ${message.role}`}>
                      <div className="message-text">{message.content}</div>
                    </div>
                    <div className="message-time">{formatCompactDate(message.createdAt)}</div>

                    {isAssistant && message.citations?.length ? (
                      <div className={`sources-section ${sourcesOpen ? 'visible' : ''}`}>
                        <button className="sources-toggle" onClick={() => toggleSourceBlock(message.id)}>
                          <span>المصادر والمواد المعتمدة ({message.citations.length})</span>
                          <span className={`arrow ${sourcesOpen ? 'open' : ''}`}>▼</span>
                        </button>
                        {sourcesOpen && (
                          <div className="sources-list">
                            {message.citations.map((citation, index) => (
                              <div key={`${message.id}-${index}`} className="source-card">
                                <span className="source-card-icon">📘</span>
                                <div className="source-card-info">
                                  <div className="source-card-title">{citation.title}</div>
                                  <div className="source-card-meta">
                                    {citation.articleNo ? `المادة ${citation.articleNo}` : (citation.sourceLabel || 'مقطع قانوني')}
                                  </div>
                                  <p>{citation.excerpt}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}

                    {showFollowups ? (
                      <div className="followup-section visible">
                        <div className="followup-label">يمكنك أيضاً أن تسأل:</div>
                        <div className="followup-chips">
                          {followUpPrompts.map((prompt) => (
                            <button key={prompt} className="followup-chip" onClick={() => setQuestion(prompt)}>
                              {prompt}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="input-area">
          <div className="input-area-inner">
            {!!selectedDocuments.length && (
              <div className="file-preview-bar selected-docs-mode">
                {selectedDocuments.map((doc) => (
                  <div key={doc.id} className="file-preview-chip">
                    <span>📚 {doc.title}</span>
                    <button type="button" className="file-preview-chip-remove" onClick={() => setSelectedDocumentIds((current) => current.filter((id) => id !== doc.id))}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {uploadFile && (
              <div className="file-preview-bar">
                <div className="file-preview-chip wide">
                  <span>📎 {uploadFile.name}</span>
                  <button type="button" className="file-preview-chip-remove" onClick={() => {
                    setUploadFile(null);
                    const input = document.getElementById('file-input') as HTMLInputElement | null;
                    if (input) input.value = '';
                  }}>✕</button>
                </div>
              </div>
            )}

            {uploadFile && (
              <div className="upload-inline-panel">
                <input className="mini-input" placeholder="عنوان الملف القانوني" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} />
                <textarea className="mini-input mini-textarea" placeholder="سؤال مباشر على الملف بعد رفعه" value={uploadQuestion} onChange={(e) => setUploadQuestion(e.target.value)} />
                <button className="ghost-inline-btn" disabled={uploadMutation.isPending} onClick={() => uploadMutation.mutate()}>
                  {uploadMutation.isPending ? 'جارٍ الرفع والتحليل...' : 'رفع وتحليل الملف'}
                </button>
              </div>
            )}

            {showLiveSearch && (
              <div className="live-search-panel">
                <div className="live-search-header">
                  <div>
                    <strong>نتيجة فورية من محرك البحث القانوني</strong>
                    <span className="live-search-subtitle">يعرض النصوص الأقرب قبل إرسال السؤال كمحادثة كاملة</span>
                  </div>
                  <span className="live-search-status">
                    {searchPreview.isFetching ? 'جارٍ فحص المصادر...' : `${searchPreview.data?.items?.length ?? 0} مصدر مطابق`}
                  </span>
                </div>

                {searchPreview.data?.answerPreview ? (
                  <div className="live-search-answer">{searchPreview.data.answerPreview}</div>
                ) : null}

                {!searchPreview.isFetching && !searchPreview.data?.items?.length ? (
                  <div className="live-search-empty">
                    لم أجد حتى الآن مواد قريبة بما يكفي داخل الوثائق الحالية. يمكنك توسيع السؤال أو رفع قانون / عقد / لائحة مرتبطة بالموضوع.
                  </div>
                ) : null}

                {!!searchPreview.data?.citations?.length && (
                  <div className="sources-list live-search-grid">
                    {searchPreview.data.citations.slice(0, 3).map((citation, index) => (
                      <button
                        key={`${citation.documentId}-${index}`}
                        type="button"
                        className="source-card source-card-action"
                        onClick={() => setSelectedDocumentIds((current) => current.includes(citation.documentId) ? current : [...current, citation.documentId])}
                      >
                        <span className="source-card-icon">📘</span>
                        <div className="source-card-info">
                          <div className="source-card-title">{citation.title}</div>
                          <div className="source-card-meta">{citation.articleNo ? `المادة ${citation.articleNo}` : (citation.sourceLabel || 'مقطع قانوني')}</div>
                          <p>{citation.excerpt}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="input-wrapper">
              <div className="input-actions-left">
                <label className="input-action-btn" title="إرفاق ملف">
                  📎
                  <input
                    id="file-input"
                    type="file"
                    accept=".pdf,.txt,.md,.doc,.docx,.json"
                    onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>

              <textarea
                id="messageInput"
                rows={1}
                placeholder="اكتب سؤالك القانوني هنا..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    askMutation.mutate({});
                  }
                }}
              />

              <button className="send-btn" id="sendBtn" disabled={!question.trim() || askMutation.isPending} onClick={() => askMutation.mutate({})}>
                {askMutation.isPending ? '...' : '➤'}
              </button>
            </div>

            <div className="input-hint">
              <span>يعالج الوقائع أولاً ثم يربطها بالنصوص والمواد ذات الصلة مع معاينة فورية للمواد الأقرب</span>
              <span>
                {config.data?.externalAiEnabled
                  ? 'مزود التحليل المتقدم متصل ويعمل فوق البحث القانوني الموثق'
                  : 'المحلل المحلي يعمل باحترافية ويمكن تعزيز الصياغة أكثر عند ربط مزود ذكاء اصطناعي خارجي'}
              </span>
            </div>
            {error ? <div className="error-box">{error}</div> : null}
          </div>
        </div>
      </main>
    </div>
  );
}
