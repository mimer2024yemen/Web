# NewsHub Pro

منصة عربية لإدارة الأخبار وربطها بعدة مواقع WordPress مع لوحة تحكم RTL وواجهة API فعلية.

## ما الذي تم بناؤه
- **Frontend:** React + Vite SPA عربية مع لوحة تحكم وإدارة أخبار ومواقع ووسائط وطابور ومستخدمين وويب هوكس وأمان وإعدادات وسجل.
- **Backend:** Fastify API مع JWT وRefresh Token وصلاحيات متقدمة و2FA وسجل تدقيق وتشفير أسرار وإدارة مستخدمين.
- **Publishing:** عميل WordPress REST API لاختبار الاتصال ومزامنة التصنيفات والوسوم ورفع الصورة البارزة ونشر المقالات.
- **Ops:** Docker Compose + Nginx + Healthchecks + CI + تخزين محلي أو S3/MinIO + Redis queue.

## التشغيل المحلي
```bash
npm install
npm run build
npm test
npm --workspace backend run start
```
- الواجهة عبر Nginx/Compose أو أثناء التطوير عبر Vite.
- الـ API: `http://localhost:4000`
- Swagger: `http://localhost:4000/docs`

## بيانات الدخول الافتراضية
- البريد: `admin@newshub.local`
- كلمة المرور: `Admin@123456`

## متغيرات البيئة الأساسية
انسخ `.env.example` وعدّل القيم السرية وبيانات مواقع WordPress والبيئة الإنتاجية.

## أوامر مهمة
```bash
npm run build
npm test
docker compose up --build -d
```

## هيكل المشروع
- `frontend/` واجهة المستخدم
- `backend/` واجهة API وقاعدة البيانات المحلية
- `docs/` التوثيق والحالة الحالية
- `nginx/` إعدادات البروكسي

## المتبقي للإطلاق الحي
راجع `docs/STATUS.md` لمعرفة العناصر الخارجية المطلوبة للإطلاق الحي الفعلي مثل بيانات الاستضافة وبيانات مواقع WordPress الفعلية.
