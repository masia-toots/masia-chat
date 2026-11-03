# The OpenMLS side of the messenger's interop test: a small Rust binary (`openmls-peer`) that drives
# OpenMLS from JSON lines on stdin. Build context = this directory (`run-interop.mjs` does it).
#
# Both base images are pinned by DIGEST, and the crate versions by `=x.y.z` in Cargo.toml plus a
# committed Cargo.lock built with --locked, so "interop against OpenMLS 0.9.1" names one artifact.

# rust:1-bookworm, pulled 2026-10-10 (rustc 1.99.0).
FROM rust:1-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS build
WORKDIR /src

# Dependencies first, so a source-only change does not recompile the whole OpenMLS tree.
COPY openmls-peer/Cargo.toml openmls-peer/Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src target/release/openmls-peer target/release/deps/openmls_peer* target/release/.fingerprint/openmls-peer*

COPY openmls-peer/src ./src
RUN cargo build --release --locked \
 && (rustc --version; cargo --version) > /rustc-version.txt

# debian:bookworm-slim, pulled 2026-10-10.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
COPY --from=build /src/target/release/openmls-peer /usr/local/bin/openmls-peer
# What the run records: the toolchain and the exact resolved crate versions.
COPY --from=build /rustc-version.txt /opt/openmls-peer/rustc-version.txt
COPY openmls-peer/Cargo.lock /opt/openmls-peer/Cargo.lock
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/openmls-peer"]
