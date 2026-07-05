# NewsHub Pro

منصة عربية لإدارة الأخبار وربطها بعدة مواقع مع لوحة تحكم RTL وواجهة API فعلية.

## ما الذي تم بناؤه
- **Frontend:** React + Vite SPA عربية مع لوحة تحكم وإدارة أخبار ومواقع ووسائط وطابور ومستخدمين وإعدادات وسجل.
- **Backend:** Fastify API مع JWT وRefresh Token وSwagger ورفع ملفات وسجلات تدقيق ومزامنة.
- **Publishing:** عميل WordPress REST API لاختبار الاتصال ونشر المقالات.
- **Ops:** Docker Compose + Nginx + GitHub Actions + Backup script.

## التشغيل المحلي
```bash
npm install
npm run dev
```
- الواجهة: `http://localhost:5173`
- الـ API: `http://localhost:4000`
- Swagger: `http://localhost:4000/docs`

## بيانات الدخول الافتراضية
- البريد: `admin@newshub.local`
- كلمة المرور: `Admin@123456`

## أوامر مهمة
```bash
npm run build
npm test
npm run backup
```

## هيكل المشروع
- `frontend/` واجهة المستخدم
- `backend/` واجهة API وقاعدة البيانات المحلية
- `docs/` التوثيق
- `nginx/` إعدادات البروكسي

## ملاحظات
- تم اعتماد SQLite لتشغيل محلي سريع بدون تعقيد.
- ملفات `docker-compose.yml` و `nginx/nginx.conf` جاهزة كبداية للبنية الإنتاجية.
- الحالة الحالية والناقص موضحة في `docs/STATUS.md`.
