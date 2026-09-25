packer {
  required_plugins {
    tart = {
      version = ">= 1.20.0"
      source  = "github.com/cirruslabs/tart"
    }
  }
}

# ===== Variables =====
#
# Each sandbox image is a single macOS version, described by a variables file
# in vars/ named after the image (`sandbox-macos-<macos-version>`).  See
# DEVELOPMENT.md for how to add a new macOS version.

variable "macos_version" {
  type = string
}

variable "xcode_version" {
  type = string
}

variable "disk_size" {
  type    = number
  default = 160
  # VM disk size in GB. Must be >= the Cirrus base image disk (140 GB): tart
  # can only grow a disk, never shrink it.
}

variable "cpu_count" {
  type    = number
  default = 4
  # CPU count of the VM.
}

variable "memory_gb" {
  type    = number
  default = 8
  # RAM of the VM in GB.
}

variable "ssh_username" {
  type    = string
  default = "admin"
  # SSH user used for provisioning (fixed in the Cirrus Labs base images).
}

variable "ssh_password" {
  type    = string
  default = "admin"
  # SSH password used for provisioning (fixed in the Cirrus Labs base images).
}

variable "openchamber_ui_password" {
  type    = string
  default = "sandbox"
  # Password protecting the OpenChamber web UI. OpenChamber refuses to bind
  # the server to a network interface without a UI password; the sandbox
  # listens on 0.0.0.0:<openchamber_port> so the host can reach it (see
  # docs/macos.md).
}

variable "openchamber_port" {
  type    = number
  default = 4000
  # TCP port the OpenChamber web UI listens on inside the guest. Not 3000 —
  # that is the default Vite dev-server port and would collide with frontend
  # dev servers in the guest. The CLI's SANDBOX_OPENCHAMBER_PORT default
  # (lib/platform.ts) must stay in sync with this.
}

variable "image_version" {
  type = string
  # Semantic version this image is published under; bump it and add a
  # CHANGELOG.md entry for every release.
}

variable "node_version" {
  type = string
  # Node.js version installed via nvm and set as the default (see the
  # "Node.js via nvm" provisioner below).
}

variable "python_version" {
  type = string
  # Homebrew Python version, e.g. "3.14"; also used for the unversioned
  # python/python3/pip/pip3 aliases.
}

# Optional toolchain versions. Empty (or an empty list) skips the tool; the
# non-empty values live in the image's vars file — see
# vars/sandbox-macos-tahoe.pkrvars.hcl. The Cirrus base images already ship
# Flutter (at $FLUTTER_HOME) and the full Android SDK (cmdline-tools,
# platform-tools, platforms;android-36, build-tools;36.0.0, NDK 28.2,
# openjdk@17, licenses accepted) — the vars below only pin versions and
# pre-install extras on top, mirroring the AdGuard build-agent-images recipe.

variable "rust_version" {
  type        = string
  default     = ""
  description = "Rust toolchain to install via rustup, e.g. \"1.95\"; also adds the aarch64/x86_64 macOS + iOS targets. Empty = skip."
}

variable "java_version" {
  type        = string
  default     = ""
  description = "SDKMAN Java version to install and set as the default, e.g. \"17.0.11-oracle\". Empty = skip."
}

variable "flutter_version" {
  type        = string
  default     = ""
  description = "Flutter version to check out at FLUTTER_HOME (shipped in the Cirrus base image). Empty = keep the base checkout."
}

variable "gradle_version" {
  type        = string
  default     = ""
  description = "Gradle version to pre-cache the wrapper distribution for, e.g. \"8.7\". Empty = skip."
}

variable "kotlin_native_version" {
  type        = string
  default     = ""
  description = "Kotlin/Native version to pre-cache for macos-aarch64, e.g. \"1.9.24\" (under ~/.konan). Empty = skip."
}

variable "android_sdk_packages" {
  type        = list(string)
  default     = []
  description = "Android SDK packages to pre-install via sdkmanager on top of the base image's SDK, e.g. [\"ndk;29.0.14206865\"]. Empty = keep the base packages."
}

variable "brew_formulas" {
  type = list(string)
  default = [
    # Core CLI tools
    "bash", "git", "gh", "jq", "ripgrep", "coreutils", "curl", "wget",
    # SSH agent bridging (docs/ssh-agent.md)
    "socat",
    # Node.js version manager (Keg-only; the Node runtime itself is installed
    # via nvm — see the "Node.js via nvm" provisioner below)
    "nvm",
    # The required programming languages (Python is installed separately by
    # the toolchain provisioner, pinned via python_version; Ruby comes with
    # rbenv so projects can pin their own interpreter)
    "ruby", "rbenv",
    # C/C++ build systems
    "cmake", "ninja",
    # Go (the brew formula is named `go`)
    "go",
    # Swift/iOS tooling: project generation, linting, dead-code analysis
    "xcodegen", "swiftlint", "periphery",
    # Large-file storage (the `git lfs` filter is wired up below)
    "git-lfs",
    # Docker CLI + plugins (client only — the sandbox is a macOS VM and cannot
    # run a local container engine, see docs/macos.md "Docker (remote engine)";
    # the compose/buildx plugins are wired up in the provisioner below)
    "docker", "docker-compose", "docker-buildx",
  ]
}

variable "extra_brew_formulas" {
  type    = list(string)
  default = []
}

# ===== Builder =====
#
# Derives the sandbox VM from Cirrus Labs' pre-built macOS image with Xcode.
# The base images are published to GHCR, see:
# https://github.com/orgs/cirruslabs/packages?tab=packages&q=macos-
#
# The resulting VM boots to a desktop with auto-login enabled and can be used
# both with graphics (tart run) and headless (tart run --no-graphics).
#
# Audio pass-through to the host (guest sound to host speakers, host
# microphone to the guest) is a per-run Tart flag, not a persisted VM
# setting — the sandbox stays audio-isolated from the host by running with
# `tart run --no-audio` (see docs/macos.md). The build honors the same
# policy via run_extra_args.

source "tart-cli" "tart" {
  vm_base_name = "ghcr.io/cirruslabs/macos-${var.macos_version}-xcode:${var.xcode_version}"
  # The image name is fixed per macOS version: sandbox-macos-<macos-version>.
  # The Xcode version selects the base image only and is not part of the name.
  vm_name      = "sandbox-macos-${var.macos_version}"
  cpu_count    = var.cpu_count
  memory_gb    = var.memory_gb
  disk_size_gb = var.disk_size
  headless     = true
  ssh_password = var.ssh_password
  ssh_username = var.ssh_username
  ssh_timeout  = "120s"
  # No audio pass-through with the host during the build either (Tart attaches
  # the VirtIO sound device even when running headless).
  run_extra_args = ["--no-audio"]
}

# ===== Provisioners =====

build {
  sources = ["source.tart-cli.tart"]

  # Base system setup: Xcode license, SSH + Screen Sharing (for tart run --vnc),
  # auto-login as admin (boots straight into the desktop and creates an
  # unlocked login.keychain, which is required for headless VMs on macOS 15+).
  provisioner "shell" {
    inline = [<<-END
set -e -x
# Xcode (already pre-installed in the Cirrus Labs base image)
sudo xcodebuild -license accept || true
sudo xcode-select -p || true

# Remote Login (SSH) and Screen Sharing (VNC) — used by `tart run --vnc`
# and by `tart ip`-based SSH from the host.
sudo systemsetup -setremotelogin on || true
sudo launchctl enable system/com.apple.screensharing || true
sudo launchctl kickstart -k system/com.apple.screensharing || true

# Auto-login as admin: boot lands straight on the desktop.
sudo sysadminctl -autologin set -userName admin -password admin || true

# Friendly hostname for the VM
sudo scutil --set ComputerName "Agent Dev Env" || true
sudo scutil --set HostName "agent-dev-env" || true
sudo scutil --set LocalHostName "agent-dev-env" || true

# Tart Guest Agent (pre-installed in Cirrus base images) powers clipboard
# sharing in GUI mode and `tart exec`.  Check that it is present.
if pgrep -x tart-guest-agent >/dev/null; then
    echo "tart-guest-agent: OK"
else
    echo "tart-guest-agent: MISSING" >&2
fi
END
    ]
  }

  # Homebrew toolchain: nvm (Node version manager), python, ruby and CLI
  # utilities.  Node.js itself is installed via nvm in the provisioner below.
  provisioner "shell" {
    inline = [<<-END
set -e -x
touch ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

brew update
brew install python@${var.python_version}
brew install ${join(" ", concat(var.brew_formulas, var.extra_brew_formulas))}

# Make Homebrew available to non-interactive shells
grep -qxF 'eval "$(/opt/homebrew/bin/brew shellenv)"' ~/.zprofile || \
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile

# Unversioned python/pip aliases pointing at brew's python@${var.python_version}
sudo ln -sf /opt/homebrew/bin/python${var.python_version} /opt/homebrew/bin/python3
sudo ln -sf /opt/homebrew/bin/python${var.python_version} /opt/homebrew/bin/python
sudo ln -sf /opt/homebrew/bin/pip${var.python_version} /opt/homebrew/bin/pip3
sudo ln -sf /opt/homebrew/bin/pip${var.python_version} /opt/homebrew/bin/pip

source ~/.zprofile
python3 --version && pip3 --version
ruby --version
END
    ]
  }

  # Node.js via nvm — brew's nvm formula is keg-only, so we wire it into
  # ~/.zprofile and install the node_version from the vars file as the
  # default version for both interactive and non-interactive shells.
  provisioner "shell" {
    inline = [<<-END
set -e -x
# Load nvm in every shell (brew's nvm is keg-only).  nvm use default picks the
# alias created below; the || true keeps non-interactive shells happy before
# the default alias exists.
grep -qxF 'export NVM_DIR="$HOME/.nvm"' ~/.zprofile || \
    cat >> ~/.zprofile <<'NVM'
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
nvm use default >/dev/null 2>&1 || true
NVM

source ~/.zprofile
nvm install ${var.node_version}
nvm alias default ${var.node_version}
# Package managers for frontend/Node projects (same npm globals as the
# Ubuntu image).
npm install --global yarn pnpm

node --version && npm --version
pnpm --version
yarn --version
nvm --version
END
    ]
  }

  # Visual Studio Code
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
curl -fsSL -o /tmp/vscode.zip "https://update.code.visualstudio.com/latest/darwin-universal/stable"
unzip -q /tmp/vscode.zip -d /tmp/vscode
sudo rm -rf "/Applications/Visual Studio Code.app"
sudo mv "/tmp/vscode/Visual Studio Code.app" /Applications/
rm -rf /tmp/vscode /tmp/vscode.zip

# Drop the quarantine attribute so the app launches without Gatekeeper prompts
sudo xattr -dr com.apple.quarantine "/Applications/Visual Studio Code.app" || true

# `code` CLI on PATH
sudo ln -sf "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" /opt/homebrew/bin/code

code --version
END
    ]
  }

  # Browsers — Google Chrome and Mozilla Firefox (latest stable universal
  # macOS builds, via Homebrew casks). Quarantine is stripped explicitly so
  # they launch without Gatekeeper prompts (the VM boots straight to the
  # desktop and may run headless; same choice as the xattr call for VS Code
  # above — brew's own --no-quarantine flag was removed in newer Homebrew).
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
brew install --cask google-chrome firefox

# Drop the quarantine attribute so the apps launch without Gatekeeper prompts
sudo xattr -dr com.apple.quarantine "/Applications/Google Chrome.app" || true
sudo xattr -dr com.apple.quarantine "/Applications/Firefox.app" || true

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
"/Applications/Firefox.app/Contents/MacOS/firefox" --version
END
    ]
  }

  # Sublime Text — the text editor (Homebrew cask, current stable build).
  # The cask also links the `subl` CLI into the Homebrew bin dir.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
brew install --cask sublime-text

# Drop the quarantine attribute so the app launches without Gatekeeper prompts
sudo xattr -dr com.apple.quarantine "/Applications/Sublime Text.app" || true

"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" --version
END
    ]
  }

  # OpenCode V2 — the AI coding agent. The tap ships V2 as `opencode-v2`
  # (the plain `opencode` formula still installs V1 and conflicts with it).
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
# The recommended Homebrew tap, see https://opencode.ai/v2/docs/
brew install anomalyco/tap/opencode-v2
opencode --version
END
    ]
  }

  # OpenCodeReview — the AI-powered code review CLI
  # (https://github.com/alibaba/open-code-review). Installed via npm (the
  # image ships Node.js via nvm), provides the `ocr` command; its global
  # config (~/.opencodereview/config.json) is synced from the host by the
  # user-settings copy (settings/macos.ts).
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
npm install -g @alibaba-group/open-code-review
ocr --version
END
    ]
  }

  # OpenChamber — the native macOS desktop app (https://openchamber.dev),
  # installed alongside the web UI below. Distributed as the `openchamber`
  # Homebrew cask (the arm64 build on Apple Silicon); the cask pins the DMG
  # checksum and stays in sync with the GitHub releases. The app bundles its
  # own OpenCode CLI and manages its own server by default — the sandbox's
  # web UI service on port 4000 below remains the main server; docs/macos.md
  # explains how to pair the app with it so both share sessions.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
brew install --cask openchamber

# Drop the quarantine attribute so the app launches without Gatekeeper
# prompts (same choice as the browsers above)
sudo xattr -dr com.apple.quarantine "/Applications/OpenChamber.app" || true

test -d "/Applications/OpenChamber.app"
defaults read "/Applications/OpenChamber.app/Contents/Info.plist" CFBundleShortVersionString
END
    ]
  }

  # OpenChamber — web UI for OpenCode (https://openchamber.dev). Installed via
  # npm (requires Node.js 22+, the image ships 26 via nvm, and the opencode
  # CLI on PATH). Registered as a login service (LaunchAgent
  # dev.openchamber.web) that listens on 0.0.0.0:${var.openchamber_port}, so
  # the host can open the UI at http://$(tart ip <vm>):${var.openchamber_port}
  # — see docs/macos.md.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
npm install -g @openchamber/web
openchamber --version

# Pin the opencode binary the service will run: `startup enable` snapshots
# the environment into the LaunchAgent, so resolving the absolute path here
# (instead of relying on PATH lookup inside the login session) guarantees
# OpenChamber uses exactly the opencode this image ships.
opencode_bin="$(command -v opencode)"
test -x "$opencode_bin"
export OPENCODE_BINARY="$opencode_bin"
echo "OpenChamber will run opencode at: $OPENCODE_BINARY"

# Auto-start at login, bind to 0.0.0.0 for host access. --lan refuses to
# start without a UI password, hence openchamber_ui_password.
# During image builds the admin user may not have a GUI login session yet
# (auto-login applies on the next boot), so a failed immediate start is OK:
# the plist is installed and RunAtLoad starts the service at first login.
openchamber startup enable --port ${var.openchamber_port} --lan --ui-password "${var.openchamber_ui_password}" \
    || echo "WARNING: OpenChamber service installed but not started yet (expected during image builds); it will start at first login"

openchamber startup status

# Health check if the service already came up during the build.
if curl -fsS --max-time 5 http://127.0.0.1:${var.openchamber_port}/health >/dev/null 2>&1; then
    echo "OpenChamber: OK (http://127.0.0.1:${var.openchamber_port}/health)"
else
    echo "WARNING: OpenChamber not reachable yet; it will start at first login"
fi
END
    ]
  }

  # Docker CLI — client only. The sandbox is a macOS VM, and Apple's
  # Virtualization.framework does not support nested virtualization for macOS
  # guests (only Linux guests on M3+ with macOS 15+), so no container engine
  # (Docker Desktop, Colima, ...) can run inside it. The CLI is meant to be
  # pointed at a remote engine — e.g. the host's Docker Desktop over SSH; see
  # docs/macos.md "Docker (remote engine)". The brew docker-compose and
  # docker-buildx formulas install the compose/buildx plugins into
  # $HOMEBREW_PREFIX/lib/docker/cli-plugins; the CLI only discovers them via
  # cliPluginsExtraDirs in ~/.docker/config.json.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile

# Wire Homebrew's cli-plugins dir into the docker CLI config so `docker
# compose` and `docker buildx` are found. docker preserves this key when the
# user later runs `docker context use ...` (the file never pre-exists in a
# fresh image; the jq branch is only defensive).
mkdir -p ~/.docker
if [ -f ~/.docker/config.json ]; then
    jq '.cliPluginsExtraDirs += ["/opt/homebrew/lib/docker/cli-plugins"] | .cliPluginsExtraDirs |= unique' \
        ~/.docker/config.json > /tmp/docker-config.json
    mv /tmp/docker-config.json ~/.docker/config.json
else
    cat > ~/.docker/config.json <<'DOCKER'
{
  "cliPluginsExtraDirs": [
    "/opt/homebrew/lib/docker/cli-plugins"
  ]
}
DOCKER
fi

docker --version
docker compose version
docker buildx version
END
    ]
  }

  # Git LFS, SSH legacy-key compatibility and CocoaPods specs block.
  #  - `git lfs install` wires the filter into the admin user's global git
  #    config (the git-lfs binary comes from the brew formula above).
  #  - The SSH config re-enables ssh-rsa key exchange for legacy hosts
  #    (Bitbucket-era servers) and skips host-key prompts — the sandbox is a
  #    short-lived VM behind Tart's NAT, and an agent-driven SSH client must
  #    not hang on an unknown host key. The runner's bridge setup appends its
  #    IdentityAgent block to this file (docs/ssh-agent.md); a second
  #    `Host *` block merges cleanly.
  #  - Blocking the deprecated CocoaPods specs repo (4+ GB, causes hangs)
  #    makes `pod` fail fast instead of stalling on a clone. Same trick as
  #    the AdGuard build-agent-images recipe.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile

git lfs install

mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat > ~/.ssh/config <<'SSH'
Host *
    PubkeyAcceptedKeyTypes +ssh-rsa
    HostKeyAlgorithms +ssh-rsa
    StrictHostKeyChecking no
SSH
chmod 600 ~/.ssh/config

git config --global url."cocoapods-specs-repo-is-forbidden".insteadOf https://github.com/CocoaPods/Specs

git lfs version
END
    ]
  }

  # Rust via rustup — pinned toolchain plus the cross-compile targets for all
  # macOS/iOS platforms, so `cargo build --target aarch64-apple-ios` and
  # friends work without a one-off rustup run (same shape as the AdGuard
  # recipe).
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
if [ -z '${var.rust_version}' ]; then echo 'Skipping Rust'; exit 0; fi
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain=${var.rust_version}
source "$HOME/.cargo/env"
rustup target add aarch64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-darwin x86_64-apple-ios
grep -qxF '. "$HOME/.cargo/env"' ~/.zprofile || \
    echo '. "$HOME/.cargo/env"' >> ~/.zprofile
rustc --version
cargo --version
END
    ]
  }

  # Java via SDKMAN. SDKMAN 5.x requires bash 4+, while macOS /bin/bash is
  # 3.2 — brew's bash (brew_formulas) is used explicitly, exactly like the
  # AdGuard recipe. The plain JAVA_HOME/PATH exports are written to
  # ~/.zprofile so login shells do not need sdkman's init script at runtime.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
if [ -z '${var.java_version}' ]; then echo 'Skipping Java'; exit 0; fi
# SDKMAN 5.x needs bash 4+; macOS /bin/bash is 3.2. Use brew's bash.
export SHELL=/opt/homebrew/bin/bash
curl -fsSL https://get.sdkman.io | /opt/homebrew/bin/bash
/opt/homebrew/bin/bash -lc 'source /Users/admin/.sdkman/bin/sdkman-init.sh && yes | sdk install java ${var.java_version} && sdk default java ${var.java_version}'

cat >> ~/.zprofile <<'ZPROFILE'
# Java via SDKMAN (plain exports — no sdkman-init.sh needed at runtime)
export JAVA_HOME="/Users/admin/.sdkman/candidates/java/current"
export PATH="$JAVA_HOME/bin:$PATH"
ZPROFILE
source ~/.zprofile
java -version
END
    ]
  }

  # Flutter — the Cirrus base image ships Flutter at $FLUTTER_HOME
  # (~/flutter, stable checkout, precached); this only pins the exact
  # version, since Flutter force-updates its branches/tags upstream and a
  # plain `git pull` fails with divergent branches (same workflow as the
  # AdGuard recipe).
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
if [ -z '${var.flutter_version}' ]; then echo 'Skipping Flutter'; exit 0; fi
if [ -z "$FLUTTER_HOME" ]; then echo "WARN: FLUTTER_HOME not set, skipping Flutter"; exit 0; fi
cd "$FLUTTER_HOME"
git fetch --all --tags --prune --force
git checkout ${var.flutter_version}
flutter doctor --android-licenses || true
flutter precache
flutter doctor
END
    ]
  }

  # Gradle wrapper pre-cache — brew's gradle resolves the pinned wrapper
  # distribution once during the build, so a project's first `./gradlew`
  # does not download it. The scratch project is thrown away; the cached
  # distribution stays in ~/.gradle.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
if [ -z '${var.gradle_version}' ]; then echo 'Skipping Gradle pre-cache'; exit 0; fi
brew install --quiet gradle
tmpdir=$(mktemp -d)
cd "$tmpdir"
gradle init --type basic --dsl kotlin --project-name warmup --no-daemon -q 2>&1 | tail -3
gradle wrapper --gradle-version ${var.gradle_version} --distribution-type all --no-daemon -q
./gradlew help --no-daemon -q
cd /
rm -rf "$tmpdir"
echo "Gradle ${var.gradle_version} wrapper cached"
END
    ]
  }

  # Kotlin/Native pre-cache — the ~1 GB prebuilt compiler for macos-aarch64
  # lands in ~/.konan so the first Kotlin/Native compile does not download
  # it. The URL uses $$ (HCL renders it to $) because the version is a bash
  # variable here (same escaping as the AdGuard recipe).
  provisioner "shell" {
    inline = [<<-END
set -e
if [ -z '${var.kotlin_native_version}' ]; then echo 'Skipping Kotlin/Native pre-cache'; exit 0; fi
kn_version="${var.kotlin_native_version}"
kn_url="https://download.jetbrains.com/kotlin/native/builds/releases/$${kn_version}/macos-aarch64/kotlin-native-prebuilt-macos-aarch64-$${kn_version}.tar.gz"
mkdir -p /Users/admin/.konan
curl -fsSL "$${kn_url}" | tar -xz -C /Users/admin/.konan/
echo "Kotlin/Native $${kn_version} cached at ~/.konan"
END
    ]
  }

  # Android SDK packages — the Cirrus base image ships the SDK
  # ($ANDROID_HOME/cmdline-tools/latest, licenses accepted, default packages
  # platforms;android-36 + build-tools;36.0.0 + ndk;28.2.13676358). This
  # pre-installs the extra packages a pipeline pins (e.g. an older NDK or
  # build-tools), so the first build does not run sdkmanager itself.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
if [ '${length(var.android_sdk_packages)}' -eq '0' ]; then echo 'Skipping Android SDK packages'; exit 0; fi
sdkmanager="$${ANDROID_HOME:-/Users/admin/android-sdk}/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$${sdkmanager}" ]; then echo "sdkmanager not found at $${sdkmanager}"; exit 1; fi
"$${sdkmanager}" --licenses >/dev/null 2>&1 || true
yes | "$${sdkmanager}" ${join(" ", [for p in var.android_sdk_packages : "\"${p}\""])}
echo "Android SDK packages installed"
END
    ]
  }

  # Warm up Xcode and a simulator so the first launch in the sandbox does not
  # cold-start (Xcode's first boot and the simulator runtime boot are the
  # slowest parts of a fresh macOS dev session). Same approach as the AdGuard
  # recipe: boot the Pro Max device, then shut it down again — caches stay
  # warm. gtimeout comes from coreutils.
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
DEVICE_NAME=$(xcrun simctl list -j | jq -r '.devices[] | .[] | select(.name | contains("Pro Max")) | .name' | head -1)
if [ -z "$DEVICE_NAME" ]; then
  echo "No Pro Max simulator found, skipping warmup"
  exit 0
fi
XCODE_PATH=$(dirname $(xcode-select -p))
gtimeout --signal=9 299 "$XCODE_PATH/MacOS/Xcode" || true
xcrun simctl boot "$DEVICE_NAME" || true
gtimeout --signal=9 299 "$XCODE_PATH/Developer/Applications/Simulator.app/Contents/MacOS/Simulator" || true
xcrun simctl shutdown "$DEVICE_NAME" || true
END
    ]
  }

  # Final verification and cleanup
  provisioner "shell" {
    inline = [<<-END
set -e -x
source ~/.zprofile
brew cleanup

echo "===== Agent Dev Env image contents ====="
sw_vers
xcodebuild -version
brew --version | head -1
node --version
npm --version
pnpm --version
yarn --version
nvm --version
python3 --version
pip3 --version
ruby --version
rbenv --version
git --version
git lfs version
gh --version | head -1
go version
cmake --version | head -1
ninja --version
xcodegen --version
swiftlint --version
periphery version
code --version | head -1
subl --version
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
"/Applications/Firefox.app/Contents/MacOS/firefox" --version
opencode --version
ocr --version | head -1
openchamber --version
defaults read "/Applications/OpenChamber.app/Contents/Info.plist" CFBundleShortVersionString
docker --version
docker compose version
docker buildx version
# Optional toolchains — verified only when pinned in the vars file (a bare
# `packer build` without a vars file skips them).
if [ -n '${var.rust_version}' ]; then rustc --version && cargo --version; fi
if [ -n '${var.java_version}' ]; then java -version 2>&1 | head -1; fi
if [ -n '${var.flutter_version}' ]; then flutter --version | head -3; fi
if [ -n '${var.gradle_version}' ]; then gradle --version | head -2; fi
if [ -n '${var.kotlin_native_version}' ]; then test -d ~/.konan && echo "Kotlin/Native: precached in ~/.konan"; fi
if [ '${length(var.android_sdk_packages)}' -gt '0' ]; then ls -1 "$ANDROID_HOME/ndk" 2>/dev/null; fi
echo "========================================"
END
    ]
  }

  # Image identity — the image records its own name/version inside the
  # guest (~/.config/agent-dev-env/image.json, the green-field guest
  # marker dir), so any clone of it can answer "which image am I" without
  # host-side provenance records.
  provisioner "shell" {
    inline = [<<-END
set -e -x
mkdir -p ~/.config/agent-dev-env
cat > ~/.config/agent-dev-env/image.json <<JSON
{
  "image": "sandbox-macos-${var.macos_version}",
  "image_version": "${var.image_version}",
  "platform": "macos",
  "macos_version": "${var.macos_version}",
  "xcode_version": "${var.xcode_version}"
}
JSON
cat ~/.config/agent-dev-env/image.json
END
    ]
  }
}
