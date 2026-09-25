#!/usr/bin/env bash
# Build the venue program in release and report its size and mainnet deploy rent, for the
# deploy-cost approval. Exits non-zero when the .so exceeds the 40 KiB budget.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/programs/venue/Cargo.toml"
SO="$ROOT/programs/venue/target/deploy/bellwether_venue.so"
LIMIT=40960                # 40 KiB hard budget
LAMPORTS_PER_BYTE=5080     # measured on mainnet 2026-09-25 (includes the 128-byte overhead)
OVERHEAD=128
PROGRAMDATA_HEADER=45      # loader-v3 ProgramData = code + 45 bytes
PROGRAM_ACCOUNT=36
RPC="${SOLANA_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"

# Supervised shells often lack the Rust and Solana toolchains on PATH.
for dir in "$HOME/.cargo/bin" "$HOME/.local/share/solana/install/active_release/bin"; do
  [ -d "$dir" ] && PATH="$PATH:$dir"
done
export PATH
command -v cargo-build-sbf >/dev/null || { echo "size-check: cargo-build-sbf not found (install the Agave toolchain)" >&2; exit 2; }

cargo-build-sbf --manifest-path "$MANIFEST" >/dev/null 2>&1 || cargo-build-sbf --manifest-path "$MANIFEST"
[ -f "$SO" ] || { echo "size-check: $SO was not produced" >&2; exit 2; }

BYTES=$(wc -c < "$SO" | tr -d ' ')
rent() { echo $(( ($1 + OVERHEAD) * LAMPORTS_PER_BYTE )); }
sol() { awk -v l="$1" 'BEGIN { printf "%.6f", l / 1e9 }'; }
PD_BYTES=$((BYTES + PROGRAMDATA_HEADER))
PD_RENT=$(rent "$PD_BYTES")
PROG_RENT=$(rent "$PROGRAM_ACCOUNT")
TOTAL=$((PD_RENT + PROG_RENT))

echo "program        programs/venue (bellwether_venue)"
echo "release .so    $BYTES bytes = $(awk -v b="$BYTES" 'BEGIN { printf "%.2f", b / 1024 }') KiB (budget $LIMIT bytes = 40 KiB)"
echo "ProgramData    $PD_BYTES bytes -> $PD_RENT lamports = $(sol "$PD_RENT") SOL"
echo "Program acct   $PROGRAM_ACCOUNT bytes -> $PROG_RENT lamports = $(sol "$PROG_RENT") SOL"
echo "deploy rent    $TOTAL lamports = $(sol "$TOTAL") SOL (fresh loader-v3 deploy, exact --max-len; upgrades need a second buffer)"

LIVE=$(curl -s -m 10 -X POST -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getMinimumBalanceForRentExemption\",\"params\":[$PD_BYTES]}" "$RPC" 2>/dev/null \
  | sed -n 's/.*"result":\([0-9][0-9]*\).*/\1/p' || true)
if [ -n "$LIVE" ]; then
  echo "mainnet RPC    getMinimumBalanceForRentExemption($PD_BYTES) = $LIVE lamports = $(sol "$LIVE") SOL"
else
  echo "mainnet RPC    unreachable; using the measured $LAMPORTS_PER_BYTE lamports/byte"
fi
echo "SIZE_BYTES=$BYTES DEPLOY_RENT_LAMPORTS=$TOTAL"

if [ "$BYTES" -gt "$LIMIT" ]; then
  echo "size-check: FAIL — $BYTES bytes exceeds the $LIMIT-byte budget" >&2
  exit 1
fi
echo "size-check: OK"
