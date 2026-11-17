#!/usr/bin/env bash
# Clean machine member check (FL-67).
# Pretends to be a brand new member on a computer that has Node.js (the README says it is needed to
# start the installer) but no Git and no Python, with no login, no keys and a short private HOME.
# It runs the install line from README.md and proves the OS works with what the installer prepared.
#
# Phases (CM_PHASE):
#   no-git    macOS and Linux. Git is hidden. Git has no portable download there, so the documented
#             behaviour is a plain message and nothing changed. Asserts exactly that.
#   with-git  macOS and Linux. Git is visible, Python is hidden. Asserts the install works and the
#             private Python is the one used.
#   full      Windows. Git and Python are hidden. Asserts the installer downloaded private copies of
#             both and that the OS then runs with them.
# Default: full on Windows, with-git elsewhere.
#
# Inputs (environment): CM_REF (full commit id to install; default: the install line as written),
# CM_VARIANT (plain | awkward), CM_LEG (label only), CM_PHASE, CM_README (default: README.md),
# CM_INSTALL_LINE (only for rehearsing on a developer machine; CI never sets it).
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
README="${CM_README:-$REPO/README.md}"
VARIANT="${CM_VARIANT:-plain}"
LEG="${CM_LEG:-local}"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WIN=1 ;; *) WIN=0 ;; esac
if [ "$WIN" = 1 ]; then PHASE="${CM_PHASE:-full}"; else PHASE="${CM_PHASE:-with-git}"; fi
say() { printf '\n== %s\n' "$*"; }
fail() { printf 'CLEAN MACHINE FAIL (%s/%s/%s): %s\n' "$LEG" "$PHASE" "$VARIANT" "$*" >&2; exit 1; }

# Step 0: re-run ourselves with a PATH that shows Node but no Python, no gh, no Homebrew and, in the
# no-git and full phases, no Git.
if [ -z "${CM_CLEAN:-}" ]; then
  NODE_SRC="$(command -v node || true)"
  [ -n "$NODE_SRC" ] || { echo "CLEAN MACHINE FAIL: the runner has no Node.js to start the installer" >&2; exit 1; }
  if [ "$WIN" = 1 ]; then
    # Not /c/Windows: py.exe lives there. System32 has tar and the other system programs the installer uses.
    CLEAN_PATH="$(dirname "$NODE_SRC"):/usr/bin:/c/Windows/System32"
  else
    MINBIN="$(mktemp -d "${TMPDIR:-/tmp}/cm-minbin.XXXXXX")"
    TOOLS="node npm npx bash sh env curl wget tar gzip gunzip unzip xz bzip2 uname mkdir rm rmdir cp mv cat ls chmod ln dirname basename sed grep awk tr head tail sort uniq find xargs mktemp printf date sleep touch wc cut readlink id sha256sum shasum openssl tee test true false diff stat realpath expr"
    [ "$PHASE" = no-git ] || TOOLS="$TOOLS git"
    for t in $TOOLS; do
      p="$(command -v "$t" 2>/dev/null || true)"; case "$p" in /*) ln -sf "$p" "$MINBIN/$t" ;; esac
    done
    CLEAN_PATH="$MINBIN"
  fi
  # The commit under test, read now while Git is still visible.
  CM_HEAD="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$CM_HEAD" ] || { echo "CLEAN MACHINE FAIL: cannot read the commit under test" >&2; exit 1; }
  exec env CM_CLEAN=1 CM_HEAD="$CM_HEAD" PATH="$CLEAN_PATH" "$BASH" "$0" "$@"
fi

say "Hidden tools (phase $PHASE)"
HIDE="python python3 py python.exe py.exe gh brew"
[ "$PHASE" = with-git ] || HIDE="$HIDE git git.exe"
for t in $HIDE; do
  if command -v "$t" >/dev/null 2>&1; then fail "$t is still visible at $(command -v "$t"); the machine is not clean"; fi
done
command -v node >/dev/null 2>&1 || fail "node must stay visible: the README needs it to start the installer"
echo "hidden: $HIDE"; echo "visible: node $(node --version)"
NODE="$(command -v node)"

# Step 1: a member's world: short private HOME, no login, no keys, locale and path variant.
BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
export HOME="$BASE/cmh-$LEG-$PHASE"; rm -rf "$HOME"; mkdir -p "$HOME"
unset GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN NODE_OPTIONS NPM_TOKEN AI_VERSE_TOOLCHAIN_DIR AI_VERSE_PRIVATE_TOOLCHAIN
export GIT_TERMINAL_PROMPT=0 CI=true npm_config_update_notifier=false
export USERPROFILE="$HOME" LOCALAPPDATA="$HOME/AppData/Local" APPDATA="$HOME/AppData/Roaming"
if [ "$VARIANT" = awkward ]; then
  if command -v locale >/dev/null 2>&1 && locale -a 2>/dev/null | grep -qi '^tr_TR\.utf-\?8$'; then
    export LANG=tr_TR.UTF-8 LC_ALL=tr_TR.UTF-8
  else
    export LANG=C.UTF-8 LC_ALL=C.UTF-8
    echo "NOTE: tr_TR.UTF-8 is not installed on this runner, so the awkward variant tests the odd folder path only, not the locale"
  fi
  WORK="$BASE/AI Verse Ünï Çödé Ğ/my project (ro da tr)-$PHASE"
else
  export LANG=C.UTF-8 LC_ALL=C.UTF-8
  WORK="$BASE/cm-work-$LEG-$PHASE"
fi
rm -rf "$WORK"; mkdir -p "$WORK"
echo "HOME=$HOME"; echo "WORK=$WORK"; echo "LANG=$LANG"
TCDIR="$HOME/.aiverse/toolchain"

# Step 2: the install line from the README, pointed at the commit under test. npm can only fetch a
# GitHub package without Git when the commit is a full id, so CI always passes CM_REF.
if [ -n "${CM_INSTALL_LINE:-}" ]; then LINE="$CM_INSTALL_LINE"; else
  LINE="$(awk '/^## Install/{f=1;next} /^## /{f=0} f && /^(npx|curl|irm|iwr) /{print;exit}' "$README")"
  [ -n "$LINE" ] || LINE="$(awk '/^## Install/{f=1;next} /^## /{f=0} f && /^npx /{print;exit}' "$README")"
  [ -n "$LINE" ] || fail "no install line found under '## Install' in $README"
  if [ -n "${CM_REF:-}" ]; then LINE="${LINE//github:aiverse-filmmakers\/AI-Verse-OS/github:aiverse-filmmakers/AI-Verse-OS#$CM_REF}"; fi
fi
if [ -z "${CM_INSTALL_LINE:-}" ] && [ -n "${CM_REF:-}" ]; then
  case "$LINE" in *"#$CM_REF"*) ;; *) fail "the README install line does not take the commit under test (no #$CM_REF after substitution): $LINE" ;; esac
fi
say "Install line: $LINE"
TARGET="$WORK/AI-Verse-OS"
INSTALL_LOG="$BASE/cm-install-$LEG-$PHASE.log"
( cd "$WORK" && eval "$LINE" ) > "$INSTALL_LOG" 2>&1; RC=$?
cat "$INSTALL_LOG"

if [ "$PHASE" = no-git ]; then
  # Documented behaviour: a plain message, nothing installed, nothing changed on the computer.
  say "No Git on macOS or Linux: plain message expected"
  [ "$RC" -ne 0 ] || fail "the install succeeded without Git, but it should have stopped"
  if grep -q 'spawn git\|ENOENT' "$INSTALL_LOG" && ! grep -q 'Git has to be installed by you' "$INSTALL_LOG"; then
    fail "npm itself failed to fetch the package without Git, so the README line cannot start on a machine without Git (see log above)"
  fi
  grep -q 'Stopped before changing anything' "$INSTALL_LOG" || fail "the install did not stop before changing anything"
  grep -Eq 'needs Git [0-9.]+ or newer, and it was not found on this computer' "$INSTALL_LOG" || fail "the message does not say Git is needed and was not found"
  grep -q 'Git has to be installed by you' "$INSTALL_LOG" || fail "the message does not tell the member to install Git themselves"
  grep -q 'Nothing on your computer was changed' "$INSTALL_LOG" || fail "the message does not say nothing was changed"
  grep -qi 'xcode-select --install\|package manager' "$INSTALL_LOG" || fail "the message does not say how to install Git"
  if grep -q '^    at \|TypeError\|ReferenceError' "$INSTALL_LOG"; then fail "the message came with a stack trace"; fi
  [ ! -e "$TARGET" ] || fail "an install folder was created even though the install stopped: $TARGET"
  [ ! -e "$TCDIR/git" ] || fail "a private Git appeared on a platform that has no portable Git"
  printf '\nCLEAN MACHINE OK (%s/%s/%s): plain message, nothing installed\n' "$LEG" "$PHASE" "$VARIANT"
  exit 0
fi

[ "$RC" -eq 0 ] || fail "the README install line failed on a clean machine"
[ -f "$TARGET/bin/ai-verse-os.mjs" ] || fail "install did not create $TARGET"

# The installer gives a member the accepted release, which is not necessarily the commit under test.
# Move the new folder to exactly the commit under test, so every check below runs the code being reviewed.
say "Commit under test"
SRC="$REPO"; [ "$WIN" = 1 ] && SRC="$(cygpath -m "$REPO")"
if [ "$WIN" = 1 ]; then GITBIN="$("$NODE" "$TARGET/scripts/toolchain.mjs" resolve git)"; else GITBIN="$(command -v git)"; fi
"$GITBIN" -C "$TARGET" fetch -q "$SRC" HEAD || fail "could not fetch the commit under test from $SRC"
"$GITBIN" -C "$TARGET" checkout -q --detach FETCH_HEAD || fail "could not check out the commit under test"
[ "$("$GITBIN" -C "$TARGET" rev-parse HEAD)" = "$CM_HEAD" ] || fail "the install folder is not at the commit under test ($CM_HEAD)"
echo "install folder is at $CM_HEAD"

# Step 3: the private toolchain. Python (and on Windows Git) were hidden, so only the private copies
# the installer downloaded can be what ran. Node was the member's own, started the installer.
say "Private toolchain"
TC="$TARGET/scripts/toolchain.mjs"
CHECK="$("$NODE" "$TC" check 2>&1)" || fail "toolchain check failed: $CHECK"
echo "$CHECK"
printf '%s\n' "$CHECK" | grep -q '^Python .*(private)' || fail "Python is not the private copy"
printf '%s\n' "$CHECK" | grep -q '^Node.js .*(system)' || fail "Node.js should be the member's own, which started the installer"
if [ "$PHASE" = full ]; then
  printf '%s\n' "$CHECK" | grep -q '^Git .*(private)' || fail "Git is not the private copy"
else
  printf '%s\n' "$CHECK" | grep -q '^Git .*(system)' || fail "Git should be the member's own on this platform"
fi
for tool in python git; do
  found="$("$NODE" "$TC" resolve "$tool")" || fail "toolchain.mjs cannot resolve $tool"
  found="${found//\\//}"
  echo "$tool -> $found"
  if [ "$tool" = python ] || [ "$PHASE" = full ]; then
    case "$found" in */.aiverse/toolchain/*) ;; *) fail "$tool resolved to $found, not the private copy under $TCDIR" ;; esac
  fi
done
[ -d "$TCDIR/python" ] || fail "no private Python folder under $TCDIR"
[ "$PHASE" != full ] || [ -d "$TCDIR/git" ] || fail "no private Git folder under $TCDIR"
# The OS runs a tool through its own launcher path (the same code scripts/ai-verse uses).
"$NODE" "$TC" run python --version || fail "the OS could not run its private Python"
"$NODE" "$TC" run git --version || fail "the OS could not run Git"
# On macOS and Linux also run the shell launcher itself.
if [ "$WIN" = 0 ]; then "$TARGET/scripts/ai-verse" python --version || fail "scripts/ai-verse python failed"; fi
GIT="$("$NODE" "$TC" resolve git)"

# Step 4: the secrets helper (scripts/secrets.mjs). The value must never be printed or stored outside .env.
# Interface: "set NAME" reads the value from stdin; "status" prints "NAME: set|missing"; "run -- cmd"
# starts one command that is listed in .env.allow, with the keys. A bare interpreter is refused.
say "Secrets helper"
[ -f "$TARGET/scripts/secrets.mjs" ] || fail "scripts/secrets.mjs does not exist"
SENTINEL="cm-secret-$RANDOM$RANDOM$RANDOM"
SECRETS=("$NODE" "$TARGET/scripts/secrets.mjs")
cd "$TARGET" || fail "cannot enter $TARGET"
OUT="$("${SECRETS[@]}" status 2>&1)" || fail "secrets status failed before any key: $OUT"
OUT="$(printf '%s\n' "$SENTINEL" | "${SECRETS[@]}" set CM_TEST_KEY 2>&1)" || fail "secrets set failed: $OUT"
case "$OUT" in *"$SENTINEL"*) fail "secrets set printed the key value" ;; esac
printf '%s\n' "$OUT" | grep -q '^CM_TEST_KEY is set' || fail "secrets set did not confirm: $OUT"
OUT="$("${SECRETS[@]}" status 2>&1)" || fail "secrets status failed: $OUT"
case "$OUT" in *"$SENTINEL"*) fail "secrets status printed the key value" ;; esac
printf '%s\n' "$OUT" | grep -q '^CM_TEST_KEY: set' || fail "secrets status does not show CM_TEST_KEY as set: $OUT"
# Not on the approved list yet: the command must be refused and get no keys.
cat > cm-probe.mjs <<'PROBE'
import crypto from 'node:crypto';
const v = process.env.CM_TEST_KEY || '';
console.log('hash:' + crypto.createHash('sha256').update(v).digest('hex'));
console.log('raw:' + v);
PROBE
OUT="$("${SECRETS[@]}" run -- node cm-probe.mjs 2>&1)" && fail "secrets run ran a command that is not on .env.allow"
case "$OUT" in *"$SENTINEL"*) fail "the refusal printed the key value" ;; esac
printf 'node cm-probe.mjs\n' > .env.allow
OUT="$("${SECRETS[@]}" run -- node cm-probe.mjs 2>&1)" || fail "secrets run failed for an approved command: $OUT"
WANT="$(printf '%s' "$SENTINEL" | "$NODE" -e "process.stdin.on('data',d=>console.log(require('crypto').createHash('sha256').update(d).digest('hex')))")"
printf '%s\n' "$OUT" | grep -q "hash:$WANT" || fail "the approved command did not receive the key"
case "$OUT" in *"$SENTINEL"*) fail "secrets run printed the key value instead of hiding it" ;; esac
printf 'node\n' > .env.allow
OUT="$("${SECRETS[@]}" run -- node cm-probe.mjs 2>&1)" && fail "secrets run accepted a bare interpreter on .env.allow"
case "$OUT" in *"lists only a program like node or git"*) ;; *) fail "the bare interpreter refusal has the wrong message: $OUT" ;; esac
case "$OUT" in *"$SENTINEL"*) fail "the bare interpreter refusal printed the key value" ;; esac
rm -f .env.allow cm-probe.mjs
"$GIT" check-ignore -q .env || fail ".env is not ignored by git"
[ -z "$("$GIT" status --porcelain --untracked-files=all -- .env)" ] || fail ".env shows up as a change to commit"
if grep -rIl --exclude-dir=.git --exclude=.env -- "$SENTINEL" "$TARGET" "$HOME" 2>/dev/null | grep -q .; then fail "the key value was found outside .env"; fi
echo "secrets: set, status, run, refusal and .env containment all behave"

# Step 5: the OS starts and reports its own status.
say "OS status"
OSCLI=("$NODE" "$TARGET/bin/ai-verse-os.mjs")
"${OSCLI[@]}" setup --dir "$TARGET" --json >/dev/null || fail "setup failed"
"${OSCLI[@]}" status --dir "$TARGET" --json > "$BASE/cm-status-$LEG-$PHASE.json" || fail "status failed"
"$NODE" -e "const x=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!x.state) process.exit(1); console.log('state:', x.state)" "$BASE/cm-status-$LEG-$PHASE.json" || fail "status gave no state"
"${OSCLI[@]}" doctor --dir "$TARGET" --json >/dev/null || fail "doctor failed"
printf '\nCLEAN MACHINE OK (%s/%s/%s)\n' "$LEG" "$PHASE" "$VARIANT"
