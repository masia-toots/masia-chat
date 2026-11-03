# PLACEHOLDER - not built, not referenced by any compose file.
#
# The relay does not run from this image today: a deployment runs it as a plain Node process
# under a service manager. When it gets its own container, these decisions are still open and
# are NOT made here:
#   - how the TypeScript runs in production (compile with tsc, or a bundler; `start` uses tsx for now)
#   - the database service, its backup policy, the TLS front, and the image's non-root user
#   - pinning the base image by digest
#
# Settled, so the image does not need new code for it: the listen address is configuration.
# RELAY_HOST (default: localhost; a container needs 0.0.0.0 - the relay logs a warning for a
# wildcard host, so put it behind a proxy), RELAY_PORT (default: 3400) and RELAY_BASE_PATH
# (default: empty; "/relay" serves everything under that prefix, including /health, which is
# also what a container health check must probe).
#
# Until then this file only marks the spot.
FROM node:22-slim
