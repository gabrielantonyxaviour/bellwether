#!/usr/bin/env bash
set -euo pipefail

# Publish a filtered, fast-forward-only snapshot of v1.0.0.
# The working repository and its film files are never rewritten.
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
public_url="https://github.com/gabrielantonyxaviour/bellwether.git"
branch="$(git -C "$source_root" branch --show-current)"
if [[ "$branch" != "v1.0.0" ]]; then
  echo "Refusing to publish from branch $branch; expected v1.0.0" >&2
  exit 1
fi
for command_name in git git-filter-repo python3; do
  command -v "$command_name" >/dev/null || { echo "Missing $command_name" >&2; exit 1; }
done

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/bellwether-public-sync.XXXXXX")"
cleanup() {
  code=$?
  if [[ $code -eq 0 ]]; then
    rm -rf -- "$scratch_dir"
  else
    echo "Sync failed; scratch clone retained at $scratch_dir" >&2
  fi
}
trap cleanup EXIT

git clone --quiet --no-local --single-branch --branch v1.0.0 "$source_root" "$scratch_dir/repo"
cd "$scratch_dir/repo"
source_head="$(git rev-parse HEAD)"
git filter-repo --force --path docs/film/ --path evidence/ --invert-paths >/dev/null

python3 - <<'PY'
from pathlib import Path
import hashlib
import re
import subprocess
import sys

def git(*args: str, input_data: bytes | None = None) -> bytes:
    return subprocess.check_output(["git", *args], input=input_data)

ref = git("rev-parse", "HEAD").decode().strip()
rows = git("rev-list", "--objects", ref).decode().splitlines()
objects = [row.split(" ", 1) for row in rows]
metadata = git("cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
               input_data=("\n".join(row[0] for row in objects) + "\n").encode()).decode().splitlines()
blobs = [(row[0], row[1] if len(row) > 1 else "") for row, meta in zip(objects, metadata)
         if meta.split()[1] == "blob"]

patterns = {
    "Alchemy key prefix": re.compile(bytes.fromhex("616c63685f")),
    "Alchemy keyed RPC URL": re.compile(bytes.fromhex("672e616c6368656d792e636f6d2f76322f")),
    "private key block": re.compile(rb"-----BEGIN (?:OPENSSH|RSA|EC|DSA|PRIVATE) PRIVATE KEY-----"),
    "64-byte key array": re.compile(rb"\[(?:\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,){63}\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*\]"),
    "ReUI license assignment": re.compile(rb"(?i)REUI_LICENSE_TOKEN\s*[:=]\s*['\"]?[^\s'\"};,]{8,}"),
    "Cloudflare token assignment": re.compile(rb"(?i)(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CF_TUNNEL_TOKEN|TUNNEL_TOKEN)\s*[:=]\s*['\"]?[^\s'\"};,]{8,}"),
    "GitHub token": re.compile(rb"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b"),
    "AWS access key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "literal secret": re.compile(rb"(?i)(?:private[_-]?key|secret[_-]?key|api[_-]?key|operator[_-]?token|tunnel[_-]?token)\s*[:=]\s*['\"]([^'\"\r\n]{16,})['\"]"),
}
fixture_sha = "5013477fb585efe27550a8d9f4ea3f45134c2a30d1fb3a1d3d7b4d41c17a1f39"
secret_file = re.compile(r"(^|/)(\.env(?:\.[^/]+)?|id\.json|[^/]*\.keypair\.json|[^/]*\.pem|[^/]*\.key|[^/]*tunnel[^/]*credential[^/]*\.json)$", re.I)
film_media = re.compile(r"\.(?:mp4|mov|webm|wav|mp3|vtt)$", re.I)
errors: list[str] = []

def check(path: str, data: bytes, scope: str) -> None:
    for label, pattern in patterns.items():
        for match in pattern.finditer(data):
            if label == "literal secret":
                value = match.group(1)
                if re.search(rb"process\.env|YOUR_|PLACEHOLDER|\.json|/|\\|\$\{|<", value, re.I):
                    continue
                if path == "services/api/api.test.ts" and hashlib.sha256(value).hexdigest() == fixture_sha:
                    continue
            line = data.count(b"\n", 0, match.start()) + 1
            errors.append(f"{scope}: {path}:{line}: {label}")

for oid, path in blobs:
    if path.startswith(("docs/film/", "evidence/")):
        errors.append(f"history: excluded media path {path}")
    if secret_file.search(path) and not path.endswith(".env.example"):
        errors.append(f"history: sensitive filename {path}")
    if film_media.search(path):
        errors.append(f"history: media outside excluded folders {path}")
    check(path, git("cat-file", "blob", oid), "history")

tracked = [path.decode() for path in git("ls-files", "-z").split(b"\0") if path]
for path in tracked:
    check(path, Path(path).read_bytes(), "worktree")

if errors:
    print("Secret/media scan failed; no values printed:", file=sys.stderr)
    for error in sorted(set(errors)):
        print(error, file=sys.stderr)
    sys.exit(1)
print(f"Filtered scan passed: {len(blobs)} historical blobs, {len(tracked)} tracked files; no secret or film media")
PY

git remote add public "$public_url"
git fetch --quiet public main
previous_head="$(git rev-parse FETCH_HEAD)"
git switch --quiet -c public-sync "$previous_head"
git merge --no-ff --no-edit v1.0.0

# Keep the root README aligned with the submission draft in the filtered source.
python3 - <<'PY'
from pathlib import Path
import re

source = Path("docs/submission/README-public.md").read_text()
source = source.replace("../../scripts/deploy/README.md", "scripts/deploy/README.md")
source = source.replace("../../scripts/deploy/deployments/devnet.json", "scripts/deploy/deployments/devnet.json")
source = source.replace("../../web/README.md", "web/README.md")
source = re.sub(r"\]\((?!https?://|#)([^)]+)\)",
                lambda match: match.group(0) if Path(match.group(1).split("#", 1)[0]).exists()
                else (_ for _ in ()).throw(ValueError(f"Broken README link: {match.group(1)}")), source)
Path("README.md").write_text(source)
PY
git add -- README.md
if ! git diff --cached --quiet -- README.md; then
  git commit --quiet -m "Refresh public README from submission draft" -- README.md
fi

[[ -f LICENSE ]] || { echo "Public MIT LICENSE is missing" >&2; exit 1; }
if git ls-files | grep -Eq '^(docs/film/|evidence/)'; then
  echo "Filtered media reappeared after merge" >&2
  exit 1
fi
git merge-base --is-ancestor "$previous_head" HEAD || { echo "Push would not fast-forward public main" >&2; exit 1; }
if [[ "${BELLWETHER_PUBLIC_SYNC_DRY_RUN:-0}" == "1" ]]; then
  printf 'DRY_RUN_SOURCE_HEAD=%s\nDRY_RUN_PUBLIC_HEAD=%s\n' "$source_head" "$(git rev-parse HEAD)"
  exit 0
fi
git push public HEAD:refs/heads/main
pushed_head="$(git rev-parse HEAD)"
remote_head="$(git ls-remote public refs/heads/main | cut -f1)"
[[ "$remote_head" == "$pushed_head" ]] || { echo "Remote head differs after push" >&2; exit 1; }
printf 'SOURCE_HEAD=%s\nPUBLIC_PREVIOUS_HEAD=%s\nPUSHED_HEAD=%s\nPUBLIC_URL=https://github.com/gabrielantonyxaviour/bellwether\n' \
  "$source_head" "$previous_head" "$pushed_head"
