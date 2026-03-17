# Stage 1: Build agcli from source (no GitHub releases available; needs Rust 1.85+ for edition2024)
FROM rust:1.86-bookworm AS agcli-builder
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/unconst/agcli.git .
RUN cargo build --release
# Binary at /build/target/release/agcli

# Stage 2: Node app + agcli binary
FROM node:20-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=agcli-builder /build/target/release/agcli /usr/local/bin/agcli
RUN chmod +x /usr/local/bin/agcli

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
