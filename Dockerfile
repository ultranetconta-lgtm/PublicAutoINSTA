FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# Fly mounts a persistent volume at /data for schedules and uploaded media.
RUN rm -rf /app/backend/data /app/backend/uploads \
    && mkdir -p /data/uploads \
    && ln -s /data /app/backend/data \
    && ln -s /data/uploads /app/backend/uploads

EXPOSE 8080
CMD ["python3", "backend/server.py", "--host", "0.0.0.0", "--port", "8080"]
