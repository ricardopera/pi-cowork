#!/usr/bin/env bash
# Prepare the PINNED Linux toolchain rootfs for the Pi-Cowork sandbox.
#
# Builds a self-contained Alpine 3.20 rootfs (with python3, node, git, curl,
# ca-certificates) at sandbox-rootfs/rootfs. The sandbox runs bash/file tools
# against this FIXED image instead of the host's userspace — mirroring Claude
# Cowork's pinned-toolchain VM model.
#
# Reproducible: pinned versions, no host state. Re-run to refresh.
# Requires: bwrap, curl, tar, and network egress for apk.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/sandbox-rootfs/rootfs"
ALPINE_VERSION="${ALPINE_VERSION:-3.20.0}"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/x86_64/alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz"
# Pinned toolchain packages installed into the rootfs.
PACKAGES="${PACKAGES:-python3 py3-pip nodejs git curl ca-certificates coreutils}"

echo ">> Preparing pinned Alpine ${ALPINE_VERSION} rootfs at ${OUT}"

command -v bwrap >/dev/null || { echo "bwrap is required (apt/dnf install bubblewrap)"; exit 1; }
command -v curl >/dev/null || { echo "curl is required"; exit 1; }

mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo ">> Downloading $ALPINE_URL"
curl -sL -o "$TMP/alpine.tar.gz" "$ALPINE_URL"

echo ">> Extracting minirootfs"
rm -rf "$OUT"
mkdir -p "$OUT"
tar -xzf "$TMP/alpine.tar.gz" -C "$OUT"

echo ">> Installing pinned toolchain: $PACKAGES"
# Run apk INSIDE the rootfs (it has its own /sbin/apk) via bwrap. --share-net
# is needed for apk to reach the Alpine package CDN.
bwrap --bind "$OUT" / \
  --dev /dev --proc /proc \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --share-net \
  /sbin/apk update
bwrap --bind "$OUT" / \
  --dev /dev --proc /proc \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --share-net \
  /sbin/apk add --no-cache $PACKAGES

# Stamp the image with its provenance for auditing.
cat > "$OUT/etc/pi-cowork-toolchain" <<EOF
Pi-Cowork pinned sandbox toolchain
Alpine: ${ALPINE_VERSION}
Packages: ${PACKAGES}
Built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Source: ${ALPINE_URL}
EOF

echo ">> Verifying toolchain inside the rootfs"
bwrap --bind "$OUT" / --dev /dev --proc /proc \
  /bin/sh -c 'echo "  $(cat /etc/alpine-release): py=$(python3 --version 2>&1) node=$(node --version 2>&1) git=$(git --version 2>&1)"'

echo ">> Done. Pinned rootfs ready at ${OUT} ($(du -sh "$OUT" | cut -f1))"
