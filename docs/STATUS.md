# Project Status

## Implemented now
- Vite + React RTL dashboard inspired by the uploaded mockup.
- Fastify backend with JWT login, refresh token flow, audit logs, settings, user management.
- Real persistence using SQLite for local development bootstrap.
- Site management with actual WordPress connection test endpoint.
- Article CRUD, scheduling metadata, queue processing, and WordPress publish adapter.
- Media upload endpoint and static serving.
- Swagger docs, Docker Compose, Nginx proxy, GitHub Actions CI, backup script.

## Still needed for full production completeness
- Production hosting credentials and real deployment target.
- Redis/BullMQ runtime wired as live distributed queue (compose exists, runtime integration is partially prepared but not exercised here).
- MinIO/S3 live object storage pipeline and image processing automation.
- Full role-permission matrix, 2FA, CSRF hardening, and encrypted secret vault.
- Advanced editors, templates, categories/tags mapping UI, reports export, notifications, and E2E coverage.
- Real WordPress media/category/tag synchronization for each site with per-site mapping UI.
