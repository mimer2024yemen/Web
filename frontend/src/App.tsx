import './App.css';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type AppConfig = {
  appName: string;
  jurisdiction: string;
  aiEnabled: boolean;
  storageMode: string;
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

const api = axios.create({ baseURL: '/api/v1' });

document.documentElement.lang = 'ar';
document.documentElement.dir = 'rtl';

function formatDate(value?: string) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('ar-YE');
  } catch {
    return value;
  }
}

export default function App() {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<string>('');
  const [question, setQuestion] = useState('');
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadQuestion, setUploadQuestion] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [error, setError] = useState('');

  const config = useQuery<AppConfig>({ queryKey: ['app-config'], queryFn: async () => (await api.get('/app/config')).data });
  const conversations = useQuery<{ items: ConversationItem[] }>({ queryKey: ['conversations'], queryFn: async () => (await api.get('/conversations')).data });
  const documents = useQuery<{ items: DocumentItem[] }>({ queryKey: ['documents'], queryFn: async () => (await api.get('/documents')).data });
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

  const askMutation = useMutation({
    mutationFn: async () => (await api.post<AskResponse>('/ask', {
      question,
      conversationId: activeConversationId || undefined,
      documentIds: selectedDocumentIds.length ? selectedDocumentIds : undefined,
    })).data,
    onSuccess: async (data) => {
      setQuestion('');
      setActiveConversationId(data.conversationId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', data.conversationId] }),
      ]);
      setError('');
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? 'تعذر توليد الإجابة القانونية'),
  });

  const newConversationMutation = useMutation({
    mutationFn: async () => (await api.post('/conversations', { title: 'محادثة قانونية جديدة' })).data,
    onSuccess: async (data) => {
      setActiveConversationId(data.item.id);
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
    onError: (err: any) => setError(err?.response?.data?.message ?? 'فشل رفع الملف أو تحليله'),
  });

  const activeMessages = activeConversation.data?.messages ?? [];
  const selectedDocuments = useMemo(() => {
    const map = new Set(selectedDocumentIds);
    return (documents.data?.items ?? []).filter((item) => map.has(item.id));
  }, [documents.data?.items, selectedDocumentIds]);

  return (
    <div className="legal-shell">
      <aside className="sidebar">
        <div className="brand-card">
          <div className="brand-icon">⚖</div>
          <div>
            <h1>{config.data?.appName ?? 'AI Legal Search'}</h1>
            <p>محرك بحث واستشارة قانونية ذكي</p>
          </div>
        </div>

        <button className="primary-btn full" onClick={() => newConversationMutation.mutate()}>
          محادثة قانونية جديدة
        </button>

        <section className="side-section">
          <div className="section-title">المحادثات المحفوظة</div>
          <div className="conversation-list">
            {(conversations.data?.items ?? []).map((item) => (
              <button
                key={item.id}
                className={`conversation-chip ${activeConversationId === item.id ? 'active' : ''}`}
                onClick={() => setActiveConversationId(item.id)}
              >
                <strong>{item.title}</strong>
                <span>{item.messageCount} رسالة</span>
              </button>
            ))}
            {!conversations.data?.items?.length && <div className="empty-note">لا توجد محادثات بعد</div>}
          </div>
        </section>

        <section className="side-section">
          <div className="section-title">الوثائق القانونية</div>
          <div className="document-list compact">
            {(documents.data?.items ?? []).map((doc) => {
              const active = selectedDocumentIds.includes(doc.id);
              return (
                <button
                  key={doc.id}
                  className={`document-chip ${active ? 'active' : ''}`}
                  onClick={() => setSelectedDocumentIds((current) => active ? current.filter((id) => id !== doc.id) : [...current, doc.id])}
                >
                  <strong>{doc.title}</strong>
                  <span>{doc.articleCount || doc.chunkCount} مادة/مقطع</span>
                </button>
              );
            })}
            {!documents.data?.items?.length && <div className="empty-note">ارفع أول قانون أو لائحة للبدء</div>}
          </div>
        </section>
      </aside>

      <main className="main-content">
        <header className="hero-card">
          <div>
            <div className="eyebrow">{config.data?.jurisdiction ?? 'اليمن'} · قاعدة قانونية خاصة · مصادر موثقة</div>
            <h2>ابحث داخل القوانين، ارفع الملفات، واحصل على إجابة قانونية منظمة مع المواد والمراجع</h2>
            <p>
              يفهم السؤال، يبحث داخل المستندات المرفوعة، ويعرض المواد ذات العلاقة مع شرح قانوني واضح.
            </p>
          </div>
          <div className="hero-stats">
            <div><strong>{documents.data?.items?.length ?? 0}</strong><span>وثيقة</span></div>
            <div><strong>{conversations.data?.items?.length ?? 0}</strong><span>محادثة</span></div>
            <div><strong>{config.data?.aiEnabled ? 'AI' : 'RAG'}</strong><span>نمط الإجابة</span></div>
          </div>
        </header>

        <section className="workspace-grid">
          <div className="chat-card">
            <div className="card-header">
              <div>
                <h3>{activeConversation.data?.title || 'المساعد القانوني'}</h3>
                <p>اسأل مباشرة مثل: ما حقوق العامل عند الفصل التعسفي</p>
              </div>
              <div className="filter-pills">
                {selectedDocuments.length ? selectedDocuments.map((doc) => (
                  <span key={doc.id} className="pill active">{doc.title}</span>
                )) : <span className="pill">البحث في جميع الوثائق</span>}
              </div>
            </div>

            <div className="messages">
              {!activeMessages.length && (
                <div className="welcome-state">
                  <div className="welcome-icon">⚖</div>
                  <h3>ابدأ سؤالك القانوني الآن</h3>
                  <p>ارفع نظاماً أو قانوناً ثم اطرح السؤال، أو اسأل مباشرة للبحث في جميع الملفات المتاحة.</p>
                </div>
              )}
              {activeMessages.map((message) => (
                <article key={message.id} className={`message-bubble ${message.role}`}>
                  <div className="message-role">{message.role === 'user' ? 'أنت' : 'المساعد القانوني'}</div>
                  <div className="message-text">{message.content}</div>
                  {message.role === 'assistant' && message.citations?.length ? (
                    <div className="sources-box">
                      <div className="sources-title">المصادر والمواد المستخدمة</div>
                      <div className="sources-grid">
                        {message.citations.map((citation, index) => (
                          <div key={`${message.id}-${index}`} className="source-card">
                            <strong>{citation.title}</strong>
                            <span>{citation.articleNo ? `المادة ${citation.articleNo}` : (citation.sourceLabel || 'مقطع قانوني')}</span>
                            <p>{citation.excerpt}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>

            <div className="composer">
              <textarea
                className="composer-input"
                placeholder="اكتب السؤال القانوني هنا..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <div className="composer-actions">
                <button
                  className="primary-btn"
                  disabled={!question.trim() || askMutation.isPending}
                  onClick={() => askMutation.mutate()}
                >
                  {askMutation.isPending ? 'جارٍ التحليل...' : 'إرسال السؤال'}
                </button>
                <button className="ghost-btn" onClick={() => setQuestion('ما حقوق العامل عند الفصل التعسفي؟')}>
                  مثال سريع
                </button>
              </div>
              {error ? <div className="error-box">{error}</div> : null}
            </div>
          </div>

          <div className="side-panel">
            <section className="panel-card upload-card">
              <div className="card-header vertical">
                <div>
                  <h3>رفع ملف قانوني</h3>
                  <p>PDF أو Word أو نص، مع إمكانية سؤاله مباشرة بعد الرفع</p>
                </div>
              </div>
              <div className="form-stack">
                <input id="file-input" className="input" type="file" accept=".pdf,.txt,.md,.doc,.docx,.json" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
                <input className="input" placeholder="عنوان الوثيقة القانوني" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} />
                <textarea className="input textarea" placeholder="سؤال مباشر على الملف بعد الرفع" value={uploadQuestion} onChange={(e) => setUploadQuestion(e.target.value)} />
                <button className="primary-btn" disabled={!uploadFile || uploadMutation.isPending} onClick={() => uploadMutation.mutate()}>
                  {uploadMutation.isPending ? 'جارٍ الرفع والتحليل...' : 'رفع وتحليل الوثيقة'}
                </button>
              </div>
            </section>

            <section className="panel-card">
              <div className="card-header vertical">
                <div>
                  <h3>مكتبة الوثائق</h3>
                  <p>اختر وثيقة أو أكثر لتقييد البحث داخلها</p>
                </div>
              </div>
              <div className="document-list">
                {(documents.data?.items ?? []).map((doc) => {
                  const active = selectedDocumentIds.includes(doc.id);
                  return (
                    <div key={doc.id} className={`doc-card ${active ? 'active' : ''}`}>
                      <div className="doc-head">
                        <div>
                          <strong>{doc.title}</strong>
                          <span>{doc.fileName}</span>
                        </div>
                        <button className="ghost-btn small" onClick={() => setSelectedDocumentIds((current) => active ? current.filter((id) => id !== doc.id) : [...current, doc.id])}>
                          {active ? 'إزالة' : 'تحديد'}
                        </button>
                      </div>
                      <p>{doc.summary}</p>
                      <div className="doc-meta">
                        <span>{doc.articleCount} مادة</span>
                        <span>{doc.chunkCount} مقطع</span>
                        <span>{formatDate(doc.updatedAt)}</span>
                      </div>
                    </div>
                  );
                })}
                {!documents.data?.items?.length && <div className="empty-note">لا توجد وثائق محفوظة بعد</div>}
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
