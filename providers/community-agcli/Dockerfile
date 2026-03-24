# Stage 1: Build agcli from source (no GitHub releases; deps need Rust 1.88+)
FROM rust:bookworm AS agcli-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
# agcli build.rs needs rustfmt and fetches chain metadata at build time
RUN rustup component add rustfmt
WORKDIR /build
RUN git clone --depth 1 https://github.com/Crimsonyx412/agcli.git .
# Patch: stub out get_coldkey_swap_scheduled (upstream chain metadata broke this function)
RUN awk '/pub async fn get_coldkey_swap_scheduled/ { \
      print "    pub async fn get_coldkey_swap_scheduled(&self, _ss58: &str) -> Result<Option<(u64, String)>> { Ok(None) }"; \
      skip=1; depth=1; next } \
    skip { for(i=1;i<=length($0);i++){c=substr($0,i,1);if(c=="{")depth++;if(c=="}")depth--} \
      if(depth<=0)skip=0; next } \
    {print}' src/chain/queries.rs > /tmp/patched.rs && mv /tmp/patched.rs src/chain/queries.rs
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
