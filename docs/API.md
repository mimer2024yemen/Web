# NewsHub Pro API

## Auth
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/auth/me`

## Dashboard
- `GET /api/v1/dashboard/stats`

## Sites
- `GET /api/v1/sites`
- `POST /api/v1/sites`
- `PUT /api/v1/sites/:id`
- `DELETE /api/v1/sites/:id`
- `POST /api/v1/sites/:id/test`

## Articles
- `GET /api/v1/articles`
- `POST /api/v1/articles`
- `PUT /api/v1/articles/:id`
- `DELETE /api/v1/articles/:id`
- `POST /api/v1/articles/:id/publish`
- `POST /api/v1/articles/:id/schedule`

## Media
- `GET /api/v1/media`
- `POST /api/v1/media/upload`

## Queue / Sync
- `GET /api/v1/queue`
- `POST /api/v1/queue/process`

## Users
- `GET /api/v1/users`
- `POST /api/v1/users`

## Webhooks
- `GET /api/v1/webhooks`
- `POST /api/v1/webhooks`
- `DELETE /api/v1/webhooks/:id`

## Settings / Logs
- `GET /api/v1/settings`
- `PUT /api/v1/settings/:key`
- `GET /api/v1/logs`
