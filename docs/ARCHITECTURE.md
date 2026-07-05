# NewsHub Pro Architecture

- **Frontend:** React + Vite SPA with RTL Arabic UI and dashboard modules.
- **Backend:** Fastify API with JWT authentication, SQLite persistence for zero-config local startup, and WordPress publishing adapter.
- **Queue/Sync:** Scheduler-based processing with BullMQ-ready Redis hook.
- **Media:** Multipart upload with local storage pipeline and extensibility for S3/MinIO.
- **Ops:** Docker Compose, Nginx reverse proxy, CI workflow.
