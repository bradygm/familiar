# The learning model is TypeScript shared by every build of Familiar, so it is
# compiled here rather than committed as generated JavaScript. Keeping the
# build in the image means `docker compose up --build` stays the only command a
# local user needs.
FROM node:22-slim AS core
WORKDIR /core
COPY core/package.json core/package-lock.json ./
RUN npm ci
COPY core/tsconfig.json ./
COPY core/src ./src
RUN npm run build


FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt
COPY backend /app/backend
COPY frontend /app/frontend
COPY --from=core /frontend/vendor/core /app/frontend/vendor/core
# Included so a Docker-only user can restore a backup without a host Python.
COPY tools /app/tools

RUN mkdir -p /app/app-data
EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
