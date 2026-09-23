FROM rust:slim-bookworm AS builder

WORKDIR /app
COPY backend /app/backend
RUN cargo build --manifest-path backend/Cargo.toml --release

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app
COPY --from=builder /app/backend/target/release/api_publicacao_backend /usr/local/bin/planner-backend

# Fly mounts its persistent volume here; keep the existing JSON/upload paths compatible.
RUN rm -rf /app/backend/data /app/backend/uploads \
    && mkdir -p /data/uploads \
    && ln -s /data /app/backend/data \
    && ln -s /data/uploads /app/backend/uploads

ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/usr/local/bin/planner-backend"]
