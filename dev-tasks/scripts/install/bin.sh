#!/usr/bin/env bash
# install/bin.sh: put the `fleet` command on PATH: a symlink <dir>/fleet -> bin/fleet in this checkout (one copy; `fleet update`
# updates it with the checkout). Default <dir>: FLEET_BIN, else ~/.local/bin. A file or a foreign link named fleet there is
# reported and left alone (exit 1). Warns when <dir> is not on PATH and says what to add.
# Touches: that one symlink (and creates <dir>). Usage: bin.sh [dir]
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
install_lock
dir=${1:-${FLEET_BIN:-$HOME/.local/bin}}; want="$ROOT/bin/fleet"; link="$dir/fleet"
mkdir -p "$dir"
if [ -L "$link" ] && [ "$(readlink "$link")" = "$want" ]; then echo "ok      $link"
elif [ -L "$link" ] && [[ "$(readlink "$link")" == */bin/fleet ]] && [ ! -e "$link" ]; then ln -sfn "$want" "$link"; echo "relinked $link (its old target was gone)"
elif [ -e "$link" ] || [ -L "$link" ]; then echo "SKIPPED $link: it exists and is not our link ($(readlink "$link" 2>/dev/null || echo file))" >&2; exit 1
else ln -s "$want" "$link"; echo "linked  $link -> $want"; fi
case ":$PATH:" in *":$dir:"*) ;; *) echo "note: $dir is not on PATH; add to ~/.zshrc: export PATH=\"$dir:\$PATH\"" ;; esac
echo "completion: add to ~/.zshrc: eval \"\$(fleet completion zsh)\""
