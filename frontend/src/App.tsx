import './App.css';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type User = { id: string; name: string; email: string; role: string };
type AuthState = { accessToken: string; refreshToken: string; user: User } | null;
type Site = { id: string; name: string; type: string; base_url: string; username?: string; status: string; notes?: string; config?: Record<string, unknown> };
type Article = { id: string; title: string; slug: string; summary?: string; content: string; author?: string; seo_title?: string; seo_description?: string; status: string; schedule_at?: string | null; targetSiteIds: string[]; };
type DashboardStats = { stats: { articles: number; published: number; sites: number; media: number; queuePending: number; failed: number }; chart: Array<{ day: string; total: number }> };

autoSeed();

function autoSeed() {
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
}

const api = axios.create({ baseURL: '/api/v1' });

const navItems = [
  ['dashboard', 'لوحة التحكم'],
  ['articles', 'إدارة الأخبار'],
  ['sites', 'إدارة المواقع'],
  ['media', 'الوسائط'],
  ['queue', 'المزامنة والطابور'],
  ['users', 'المستخدمون'],
  ['webhooks', 'الويب هوكس'],
  ['settings', 'الإعدادات'],
  ['logs', 'السجل'],
] as const;

export default function App() {
  const [auth, setAuth] = useState<AuthState>(() => {
    const raw = localStorage.getItem('newshub_auth');
    return raw ? JSON.parse(raw) : null;
  });
  const [view, setView] = useState<(typeof navItems)[number][0]>('dashboard');

  useEffect(() => {
    if (auth?.accessToken) {
      api.defaults.headers.common.Authorization = `Bearer ${auth.accessToken}`;
      localStorage.setItem('newshub_auth', JSON.stringify(auth));
    } else {
      delete api.defaults.headers.common.Authorization;
      localStorage.removeItem('newshub_auth');
    }
  }, [auth]);

  if (!auth) return <LoginScreen onSuccess={setAuth} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-badge">N</div>
          <div>
            <h1>NewsHub Pro</h1>
            <p>منصة الإدارة المركزية</p>
          </div>
        </div>
        <div className="notice">تم تحويل النموذج المرفوع إلى لوحة تحكم React + Vite مع API حقيقي.</div>
        <div className="nav-list">
          {navItems.map(([key, label]) => (
            <button key={key} className={`nav-item ${view === key ? 'active' : ''}`} onClick={() => setView(key)}>{label}</button>
          ))}
        </div>
        <div className="footer-note">المستخدم الحالي: {auth.user.name}<br />{auth.user.email}</div>
        <button className="btn danger" style={{ marginTop: 16, width: '100%' }} onClick={() => setAuth(null)}>تسجيل الخروج</button>
      </aside>
      <main className="main">
        <DashboardHeader currentView={view} />
        <ContentArea view={view} auth={auth} />
      </main>
    </div>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: (auth: AuthState) => void }) {
  const [email, setEmail] = useState('admin@newshub.local');
  const [password, setPassword] = useState('Admin@123456');
  const [error, setError] = useState('');

  const login = useMutation({
    mutationFn: async () => (await api.post('/auth/login', { email, password })).data,
    onSuccess: (data) => onSuccess(data),
    onError: () => setError('فشل تسجيل الدخول. تأكد من تشغيل الـ API أو من بيانات الاعتماد.'),
  });

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand">
          <div className="brand-badge">N</div>
          <div>
            <h1>NewsHub Pro</h1>
            <p>منصة ربط ونشر وإدارة الأخبار على المواقع</p>
          </div>
        </div>
        <div className="notice">تم تهيئة حساب المدير الافتراضي تلقائياً لتجربة المشروع محلياً.</div>
        <div className="form-grid">
          <div className="field full">
            <label>البريد الإلكتروني</label>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field full">
            <label>كلمة المرور</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        {error ? <p style={{ color: '#fecaca' }}>{error}</p> : null}
        <button className="btn primary" onClick={() => login.mutate()} disabled={login.isPending}>
          {login.isPending ? 'جارٍ التحقق...' : 'تسجيل الدخول'}
        </button>
      </div>
    </div>
  );
}

function DashboardHeader({ currentView }: { currentView: string }) {
  const titles: Record<string, string> = {
    dashboard: 'لوحة التحكم', articles: 'إدارة الأخبار', sites: 'إدارة المواقع', media: 'إدارة الوسائط', queue: 'المزامنة والطابور', users: 'إدارة المستخدمين', settings: 'إعدادات النظام', logs: 'سجل العمليات', webhooks: 'إدارة Webhooks',
  };
  return (
    <div className="topbar">
      <div>
        <h2>{titles[currentView]}</h2>
        <p>واجهة RTL عربية، متصلة بواجهة API فعلية، ومهيأة للتوسع والنشر متعدد المواقع.</p>
      </div>
      <div className="actions">
        <a className="btn ghost" href="/docs" target="_blank" rel="noreferrer">Swagger API</a>
        <button className="btn">تحديث</button>
      </div>
    </div>
  );
}

function ContentArea({ view, auth }: { view: string; auth: NonNullable<AuthState> }) {
  const queryClient = useQueryClient();
  const stats = useQuery<DashboardStats>({ queryKey: ['dashboard'], queryFn: async () => (await api.get('/dashboard/stats')).data });
  const sites = useQuery<{ items: Site[] }>({ queryKey: ['sites'], queryFn: async () => (await api.get('/sites')).data });
  const articles = useQuery<{ items: Article[] }>({ queryKey: ['articles'], queryFn: async () => (await api.get('/articles')).data });
  const media = useQuery<{ items: Array<Record<string, unknown>> }>({ queryKey: ['media'], queryFn: async () => (await api.get('/media')).data });
  const queue = useQuery<{ items: Array<Record<string, unknown>> }>({ queryKey: ['queue'], queryFn: async () => (await api.get('/queue')).data });
  const logs = useQuery<{ syncLogs: Array<Record<string, unknown>>; auditLogs: Array<Record<string, unknown>> }>({ queryKey: ['logs'], queryFn: async () => (await api.get('/logs')).data });
  const users = useQuery<{ items: Array<Record<string, unknown>> }>({ queryKey: ['users'], queryFn: async () => (await api.get('/users')).data });
  const settings = useQuery<{ items: Array<{ key: string; value: Record<string, unknown> }> }>({ queryKey: ['settings'], queryFn: async () => (await api.get('/settings')).data });
  const webhooks = useQuery<{ items: Array<Record<string, unknown>> }>({ queryKey: ['webhooks'], queryFn: async () => (await api.get('/webhooks')).data });

  const refreshAll = () => ['dashboard', 'sites', 'articles', 'media', 'queue', 'logs', 'users', 'settings', 'webhooks'].forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));

  const processQueue = useMutation({ mutationFn: async () => (await api.post('/queue/process')).data, onSuccess: refreshAll });

  const page = useMemo(() => {
    switch (view) {
      case 'articles':
        return <ArticlesSection sites={sites.data?.items ?? []} items={articles.data?.items ?? []} onRefresh={refreshAll} />;
      case 'sites':
        return <SitesSection items={sites.data?.items ?? []} onRefresh={refreshAll} />;
      case 'media':
        return <MediaSection items={media.data?.items ?? []} onRefresh={refreshAll} />;
      case 'queue':
        return <QueueSection items={queue.data?.items ?? []} onProcess={() => processQueue.mutate()} busy={processQueue.isPending} />;
      case 'users':
        return <UsersSection items={users.data?.items ?? []} onRefresh={refreshAll} />;
      case 'webhooks':
        return <WebhooksSection items={webhooks.data?.items ?? []} onRefresh={refreshAll} />;
      case 'settings':
        return <SettingsSection items={settings.data?.items ?? []} onRefresh={refreshAll} />;
      case 'logs':
        return <LogsSection data={logs.data} />;
      default:
        return <DashboardSection stats={stats.data} sites={sites.data?.items ?? []} articles={articles.data?.items ?? []} auth={auth.user} />;
    }
  }, [view, stats.data, sites.data?.items, articles.data?.items, auth, media.data?.items, queue.data?.items, processQueue.isPending, users.data?.items, webhooks.data?.items, settings.data?.items, logs.data]);

  return page;
}

function DashboardSection({ stats, sites, articles, auth }: { stats?: DashboardStats; sites: Site[]; articles: Article[]; auth: User }) {
  const statCards = [
    ['الأخبار', stats?.stats.articles ?? 0], ['المنشور', stats?.stats.published ?? 0], ['المواقع', stats?.stats.sites ?? 0], ['الوسائط', stats?.stats.media ?? 0], ['الطابور', stats?.stats.queuePending ?? 0], ['الأخطاء', stats?.stats.failed ?? 0],
  ];
  return (
    <div className="grid">
      <div className="kpis">
        <div className="kpi">مرحباً {auth.name}</div>
        <div className="kpi">عدد المواقع المرتبطة: {sites.length}</div>
        <div className="kpi">جاهزية النظام: API + Queue + Auth + Media</div>
      </div>
      <div className="grid stats">
        {statCards.map(([label, value]) => <div className="card" key={label}><div className="stat-label">{label}</div><div className="stat-value">{value}</div></div>)}
      </div>
      <div className="two-col">
        <div className="card" style={{ minHeight: 340 }}>
          <h3>حركة إنشاء الأخبار</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={stats?.chart ?? []}>
              <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false} />
              <XAxis dataKey="day" stroke="#94a3b8" />
              <YAxis stroke="#94a3b8" />
              <Tooltip />
              <Bar dataKey="total" fill="#3b82f6" radius={[12, 12, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h3>أحدث الأخبار</h3>
          {articles.length ? articles.slice(0, 6).map((article) => (
            <div key={article.id} style={{ padding: '12px 0', borderBottom: '1px solid rgba(148,163,184,.12)' }}>
              <div style={{ fontWeight: 700 }}>{article.title}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '.92rem' }}>{article.slug}</div>
            </div>
          )) : <div className="empty">لا توجد أخبار بعد</div>}
        </div>
      </div>
    </div>
  );
}

function SitesSection({ items, onRefresh }: { items: Site[]; onRefresh: () => void }) {
  const [form, setForm] = useState({ name: '', type: 'wordpress', baseUrl: '', username: '', appPassword: '', notes: '' });
  const save = useMutation({ mutationFn: async () => (await api.post('/sites', form)).data, onSuccess: () => { setForm({ name: '', type: 'wordpress', baseUrl: '', username: '', appPassword: '', notes: '' }); onRefresh(); } });
  const testConnection = useMutation({ mutationFn: async (id: string) => (await api.post(`/sites/${id}/test`)).data, onSuccess: onRefresh });
  return (
    <div className="grid two-col">
      <div className="card">
        <h3>إضافة موقع جديد</h3>
        <div className="form-grid">
          {[
            ['name', 'اسم الموقع'], ['baseUrl', 'رابط الموقع'], ['username', 'اسم مستخدم WordPress'], ['appPassword', 'Application Password'],
          ].map(([key, label]) => <div className="field" key={key}><label>{label}</label><input className="input" value={(form as any)[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></div>)}
          <div className="field full"><label>ملاحظات</label><textarea className="textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>حفظ واختبار لاحقاً</button>
      </div>
      <div className="card table-wrap">
        <h3>المواقع المرتبطة</h3>
        <table>
          <thead><tr><th>الموقع</th><th>النوع</th><th>الحالة</th><th>إجراء</th></tr></thead>
          <tbody>
            {items.map((site) => <tr key={site.id}><td><strong>{site.name}</strong><div style={{ color: 'var(--text-muted)' }}>{site.base_url}</div></td><td>{site.type}</td><td><span className={`badge ${site.status === 'connected' ? 'success' : site.status === 'failed' ? 'danger' : 'warning'}`}>{site.status}</span></td><td><button className="btn" onClick={() => testConnection.mutate(site.id)}>اختبار</button></td></tr>)}
          </tbody>
        </table>
        {!items.length && <div className="empty">لم تتم إضافة مواقع بعد</div>}
      </div>
    </div>
  );
}

function ArticlesSection({ items, sites, onRefresh }: { items: Article[]; sites: Site[]; onRefresh: () => void }) {
  const [form, setForm] = useState({ title: '', summary: '', content: '', author: '', seoTitle: '', seoDescription: '', slug: '', scheduleAt: '', targetSiteIds: [] as string[] });
  const create = useMutation({ mutationFn: async () => (await api.post('/articles', form)).data, onSuccess: () => { setForm({ title: '', summary: '', content: '', author: '', seoTitle: '', seoDescription: '', slug: '', scheduleAt: '', targetSiteIds: [] }); onRefresh(); } });
  const publish = useMutation({ mutationFn: async (id: string) => (await api.post(`/articles/${id}/publish`, {})).data, onSuccess: onRefresh });
  return (
    <div className="grid two-col">
      <div className="card">
        <h3>إنشاء خبر جديد</h3>
        <div className="form-grid">
          <div className="field full"><label>العنوان</label><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          <div className="field full"><label>الملخص</label><textarea className="textarea" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></div>
          <div className="field full"><label>المحتوى</label><textarea className="textarea" style={{ minHeight: 220 }} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} /></div>
          <div className="field"><label>الكاتب</label><input className="input" value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} /></div>
          <div className="field"><label>الرابط المختصر</label><input className="input" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></div>
          <div className="field"><label>عنوان SEO</label><input className="input" value={form.seoTitle} onChange={(e) => setForm({ ...form, seoTitle: e.target.value })} /></div>
          <div className="field"><label>الوصف التعريفي</label><input className="input" value={form.seoDescription} onChange={(e) => setForm({ ...form, seoDescription: e.target.value })} /></div>
          <div className="field full"><label>المواقع المستهدفة</label><select className="select" multiple value={form.targetSiteIds} onChange={(e) => setForm({ ...form, targetSiteIds: Array.from(e.target.selectedOptions).map((option) => option.value) })}>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></div>
          <div className="field full"><label>وقت الجدولة (اختياري)</label><input className="input" type="datetime-local" value={form.scheduleAt} onChange={(e) => setForm({ ...form, scheduleAt: e.target.value ? new Date(e.target.value).toISOString() : '' })} /></div>
        </div>
        <button className="btn primary" onClick={() => create.mutate()} disabled={create.isPending}>حفظ الخبر</button>
      </div>
      <div className="card table-wrap">
        <h3>قائمة الأخبار</h3>
        <table>
          <thead><tr><th>الخبر</th><th>الحالة</th><th>المواقع</th><th>إجراء</th></tr></thead>
          <tbody>
            {items.map((article) => <tr key={article.id}><td><strong>{article.title}</strong><div style={{ color: 'var(--text-muted)' }}>{article.slug}</div></td><td><span className={`badge ${article.status === 'published' ? 'success' : article.status === 'scheduled' ? 'warning' : ''}`}>{article.status}</span></td><td>{article.targetSiteIds?.length ?? 0}</td><td><button className="btn success" onClick={() => publish.mutate(article.id)}>نشر الآن</button></td></tr>)}
          </tbody>
        </table>
        {!items.length && <div className="empty">ابدأ بإنشاء أول خبر</div>}
      </div>
    </div>
  );
}

function MediaSection({ items, onRefresh }: { items: Array<Record<string, unknown>>; onRefresh: () => void }) {
  const upload = async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    await api.post('/media/upload', formData);
    onRefresh();
  };
  return (
    <div className="grid two-col">
      <div className="card">
        <h3>رفع ملفات</h3>
        <input className="input" type="file" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <p className="footer-note">الرفع يعمل فعلياً ويحفظ الملفات داخل backend/uploads مع endpoint مباشر.</p>
      </div>
      <div className="card table-wrap">
        <h3>مكتبة الوسائط</h3>
        <table>
          <thead><tr><th>الملف</th><th>الحجم</th><th>الرابط</th></tr></thead>
          <tbody>
            {items.map((file) => <tr key={String(file.id)}><td>{String(file.original_name)}</td><td>{Math.round(Number(file.size ?? 0) / 1024)} KB</td><td><a href={String(file.public_url)} target="_blank" rel="noreferrer">فتح</a></td></tr>)}
          </tbody>
        </table>
        {!items.length && <div className="empty">لا توجد ملفات بعد</div>}
      </div>
    </div>
  );
}

function QueueSection({ items, onProcess, busy }: { items: Array<Record<string, unknown>>; onProcess: () => void; busy: boolean }) {
  return (
    <div className="card table-wrap">
      <div className="topbar" style={{ marginBottom: 12 }}>
        <div><h2 style={{ fontSize: '1.3rem' }}>الطابور والمزامنة</h2></div>
        <button className="btn primary" onClick={onProcess} disabled={busy}>{busy ? 'جارٍ التنفيذ...' : 'معالجة الطابور'}</button>
      </div>
      <table>
        <thead><tr><th>المهمة</th><th>الحالة</th><th>المحاولات</th><th>آخر خطأ</th></tr></thead>
        <tbody>{items.map((job) => <tr key={String(job.id)}><td>{String(job.article_id)} / {String(job.site_id ?? 'all')}</td><td><span className={`badge ${String(job.status) === 'done' ? 'success' : String(job.status) === 'failed' ? 'danger' : 'warning'}`}>{String(job.status)}</span></td><td>{String(job.attempts ?? 0)}</td><td>{String(job.last_error ?? '-')}</td></tr>)}</tbody>
      </table>
      {!items.length && <div className="empty">لا توجد مهام حالية</div>}
    </div>
  );
}

function UsersSection({ items, onRefresh }: { items: Array<Record<string, unknown>>; onRefresh: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'editor' });
  const create = useMutation({ mutationFn: async () => (await api.post('/users', form)).data, onSuccess: () => { setForm({ name: '', email: '', password: '', role: 'editor' }); onRefresh(); } });
  return (
    <div className="grid two-col">
      <div className="card">
        <h3>إضافة مستخدم</h3>
        <div className="form-grid">
          {[['name', 'الاسم الكامل'], ['email', 'البريد الإلكتروني'], ['password', 'كلمة المرور']].map(([key, label]) => <div className="field full" key={key}><label>{label}</label><input className="input" type={key === 'password' ? 'password' : 'text'} value={(form as any)[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></div>)}
        </div>
        <button className="btn primary" onClick={() => create.mutate()}>إضافة المستخدم</button>
      </div>
      <div className="card table-wrap">
        <h3>المستخدمون</h3>
        <table>
          <thead><tr><th>الاسم</th><th>البريد</th><th>الدور</th></tr></thead>
          <tbody>{items.map((user) => <tr key={String(user.id)}><td>{String(user.name)}</td><td>{String(user.email)}</td><td>{String(user.role)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function WebhooksSection({ items, onRefresh }: { items: Array<Record<string, unknown>>; onRefresh: () => void }) {
  const [form, setForm] = useState({ name: '', targetUrl: '', events: 'article.published,site.connected' });
  const create = useMutation({ mutationFn: async () => (await api.post('/webhooks', { name: form.name, targetUrl: form.targetUrl, events: form.events.split(',').map((x) => x.trim()) })).data, onSuccess: () => { setForm({ name: '', targetUrl: '', events: 'article.published,site.connected' }); onRefresh(); } });
  return (
    <div className="grid two-col">
      <div className="card">
        <h3>Webhook جديد</h3>
        <div className="form-grid">
          <div className="field full"><label>الاسم</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field full"><label>الرابط الهدف</label><input className="input" value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} /></div>
          <div className="field full"><label>الأحداث</label><input className="input" value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} /></div>
        </div>
        <button className="btn primary" onClick={() => create.mutate()}>إنشاء</button>
      </div>
      <div className="card table-wrap">
        <h3>القائمة الحالية</h3>
        <table>
          <thead><tr><th>الاسم</th><th>الرابط</th><th>الأحداث</th></tr></thead>
          <tbody>{items.map((hook) => <tr key={String(hook.id)}><td>{String(hook.name)}</td><td>{String(hook.target_url)}</td><td>{Array.isArray(hook.events) ? (hook.events as string[]).join(', ') : ''}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsSection({ items, onRefresh }: { items: Array<{ key: string; value: Record<string, unknown> }>; onRefresh: () => void }) {
  const [selected, setSelected] = useState('branding');
  const value = items.find((item) => item.key === selected)?.value ?? {};
  const [jsonText, setJsonText] = useState('{}');
  useEffect(() => setJsonText(JSON.stringify(value, null, 2)), [selected, items]);
  const save = useMutation({ mutationFn: async () => (await api.put(`/settings/${selected}`, JSON.parse(jsonText))).data, onSuccess: onRefresh });
  return (
    <div className="grid two-col">
      <div className="card">
        <h3>المجموعات</h3>
        {items.map((item) => <button key={item.key} className={`nav-item ${selected === item.key ? 'active' : ''}`} onClick={() => setSelected(item.key)}>{item.key}</button>)}
      </div>
      <div className="card">
        <h3>تحرير {selected}</h3>
        <textarea className="textarea" style={{ minHeight: 320 }} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
        <button className="btn primary" onClick={() => save.mutate()}>حفظ</button>
      </div>
    </div>
  );
}

function LogsSection({ data }: { data?: { syncLogs: Array<Record<string, unknown>>; auditLogs: Array<Record<string, unknown>> } }) {
  return (
    <div className="grid two-col">
      <div className="card table-wrap">
        <h3>سجل المزامنة</h3>
        <table>
          <thead><tr><th>الكيان</th><th>الحالة</th><th>الرسالة</th></tr></thead>
          <tbody>{data?.syncLogs?.map((log) => <tr key={String(log.id)}><td>{String(log.entity_type)} / {String(log.entity_id)}</td><td>{String(log.status)}</td><td>{String(log.message)}</td></tr>)}</tbody>
        </table>
        {!data?.syncLogs?.length && <div className="empty">لا توجد سجلات مزامنة بعد</div>}
      </div>
      <div className="card table-wrap">
        <h3>سجل التدقيق</h3>
        <table>
          <thead><tr><th>الإجراء</th><th>النوع</th><th>المعرف</th></tr></thead>
          <tbody>{data?.auditLogs?.map((log) => <tr key={String(log.id)}><td>{String(log.action)}</td><td>{String(log.entity_type)}</td><td>{String(log.entity_id ?? '-')}</td></tr>)}</tbody>
        </table>
        {!data?.auditLogs?.length && <div className="empty">لا توجد سجلات تدقيق بعد</div>}
      </div>
    </div>
  );
}
