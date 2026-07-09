# AI Legal Search Architecture

## Frontend
- React + Vite RTL interface focused on legal search and legal chat.
- Main legal query composer, conversation history, document library, and direct file upload flow.
- Citations panel for each assistant answer.

## Backend
- Fastify API optimized for private legal RAG workflows.
- SQLite persistence for documents, extracted chunks, conversations, and messages.
- FTS5 full-text legal search across article chunks.
- Optional OpenAI-compatible answer generation layer.

## Ingestion Pipeline
1. Upload legal file.
2. Extract text from PDF / DOCX / TXT / MD / JSON.
3. Detect legal articles such as `المادة (X)`.
4. Split into searchable chunks.
5. Store chunks and search index.

## Storage
- Metadata and chat persistence: SQLite.
- File binaries: local storage by default.
- Optional Supabase Storage bucket for production file hosting.

## Deployment
- Dockerized frontend and backend.
- Nginx reverse proxy.
- Ready for external deployment on VPS / Render / Railway / Coolify / Dokploy.
