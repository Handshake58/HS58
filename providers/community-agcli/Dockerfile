# Stage 1: Build agcli from source (no GitHub releases; deps need Rust 1.88+)
FROM rust:bookworm AS agcli-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
# agcli build.rs needs rustfmt and fetches chain metadata at build time
RUN rustup component add rustfmt
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
