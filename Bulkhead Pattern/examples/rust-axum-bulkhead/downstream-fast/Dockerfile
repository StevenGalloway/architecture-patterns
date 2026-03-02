FROM rust:1.78 as build
WORKDIR /app
COPY Cargo.toml .
RUN mkdir -p src && echo 'fn main(){}' > src/main.rs
RUN cargo build --release
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/downstream-fast /app/downstream-fast
EXPOSE 9201
ENV RUST_LOG=info
ENTRYPOINT ["/app/downstream-fast"]
