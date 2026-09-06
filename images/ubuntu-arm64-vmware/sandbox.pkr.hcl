packer {
  required_version = ">= 1.10.0"

  required_plugins {
    vmware = {
      version = ">= 2.1.5"
      source  = "github.com/vmware/vmware"
    }
  }
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------
#
# The Ubuntu build reuses the vmware-iso mechanics of
# images/windows-arm64-vmware/sandbox.pkr.hcl (Fusion on Apple Silicon,
# NAT + vmxnet3 + EFI, tar.gz OCI artifact) with a Linux twist: it is
# installed from the Ubuntu Server ARM64 ISO via Subiquity autoinstall
# (cloud-init seed served over HTTP), provisioned over SSH, and uses
# open-vm-tools from the Ubuntu archive instead of a VMware Tools ISO —
# Fusion ships no Linux tools for arm64 guests (open-vm-tools are the
# only in-guest tools available for arm64 Linux VMs).

variable "ubuntu_version" {
  type        = string
  description = "Ubuntu guest version, e.g. '24-04'; part of the image name (sandbox-ubuntu-<ubuntu_version>-vmware)."
}

variable "image_version" {
  type        = string
  description = "Semantic version this image is published under; bump it + add a CHANGELOG.md entry per release."
}

# --- Build layout ---
#
# Built images and their scratch land in a top-level build/ directory:
# build/ubuntu-arm64-vmware/output (Packer's output_directory). The
# agent-dev-env CLI build flow computes the directory and passes it
# in; the default keeps a bare `packer build` from the platform dir working.

variable "build_dir" {
  type        = string
  default     = "."
  description = "Per-image build directory: <build_dir>/output holds the built VM. Set by `agent-dev-env build` to build/ubuntu-arm64-vmware/."
}

# --- Ubuntu install ISO (bring-your-own, see images/ubuntu-arm64-vmware/README.md) ---

variable "iso_path" {
  type        = string
  description = "Absolute path to the Ubuntu Server 24.04 ARM64 ISO. Set by the agent-dev-env CLI build flow (PKR_VAR_iso_path); the ISO is not redistributable so it cannot live in the repo. Required — validate with `-var iso_path=/path/to/iso`."
}

variable "iso_sha256" {
  type        = string
  default     = ""
  description = "SHA256 of the Ubuntu ISO as published in the release SHA256SUMS. Read by the agent-dev-env CLI build flow for verification, not by Packer itself (iso_checksum is 'none')."
}

# --- SSH credentials (baked into autoinstall/user-data — keep in sync) ---

variable "ssh_username" {
  type        = string
  default     = "admin"
  description = "User created by the autoinstall seed; used for SSH provisioning and as the sandbox login."
}

variable "ssh_password" {
  type        = string
  default     = "sandbox1"
  sensitive   = true
  description = "Password of the provisioning account; must match the crypt hash in autoinstall/user-data."
}

# --- Toolchain versions ---
#
# Pinned by direct download (like the Windows image's Chrome CfT approach):
# the URL and SHA256 of each artifact are in the vars file; apt-installed
# tools (gcc, git, ...) come from the Ubuntu archive, with Python pinned to
# the archive's python3.<minor> package. Node.js is installed via nvm (like
# the macOS image) and Rust via rustup (like the Windows image), so only
# the major/minor version is pinned here.

variable "node_version" {
  type        = string
  description = "Node.js major version installed via nvm and set as the default, e.g. '22' (nvm resolves the latest patch)."
}

variable "python_version" {
  type        = string
  description = "Python major.minor pinned to the Ubuntu archive package python3.<minor>, e.g. '3.12' (apt resolves the exact patch)."
}

variable "github_cli_version" {
  type        = string
  description = "GitHub CLI version, e.g. '2.98.0' (linux-arm64 deb from the GitHub releases)."
}

variable "github_cli_sha256" {
  type        = string
  description = "SHA256 of the gh_<version>_linux_arm64.deb for github_cli_version."
}

variable "open_code_review_version" {
  type        = string
  description = "open-code-review (ocr) version installed via npm."
}

# Optional toolchains. Empty (or an empty list) skips the tool; the
# non-empty values live in the image's vars file — same pattern as the
# macOS template (Java via SDKMAN there, OpenJDK from the Ubuntu archive
# here). The Linux guest has no pre-installed Android SDK (unlike the
# Cirrus macOS base), so the SDK itself is bootstrapped below.

variable "java_version" {
  type        = string
  default     = ""
  description = "OpenJDK major version from the Ubuntu archive to install, e.g. \"17\"; JAVA_HOME exported via /etc/profile.d. Empty = skip."
}

variable "gradle_version" {
  type        = string
  default     = ""
  description = "Gradle version to install and pre-cache the wrapper distribution for, e.g. \"8.7\" (bin zip from services.gradle.org). Empty = skip."
}

variable "gradle_sha256" {
  type        = string
  default     = ""
  description = "SHA256 of the gradle-<version>-bin.zip for gradle_version."
}

variable "kotlin_native_version" {
  type        = string
  default     = ""
  description = "Kotlin/Native version to pre-cache for linux-aarch64 (under the sandbox user's ~/.konan). Empty = skip."
}

variable "android_cmdline_tools_version" {
  type        = string
  default     = ""
  description = "Android command-line tools version, e.g. \"14742923\" (commandlinetools-linux-<version>_latest.zip). Used when android_sdk_packages is non-empty."
}

variable "android_cmdline_tools_sha256" {
  type        = string
  default     = ""
  description = "SHA256 of the commandlinetools-linux zip for android_cmdline_tools_version."
}

variable "android_sdk_packages" {
  type        = list(string)
  default     = []
  description = "Android SDK packages to install via sdkmanager, e.g. [\"ndk;29.0.14206865\", \"build-tools;34.0.0\"]. Empty = no Android SDK."
}

variable "go_version" {
  type        = string
  description = "Go version, e.g. '1.27.0' (linux-arm64 tarball from go.dev/dl)."
}

variable "go_sha256" {
  type        = string
  description = "SHA256 of the go<version>.linux-arm64.tar.gz for go_version."
}

variable "rust_version" {
  type        = string
  description = "Rust toolchain version installed via rustup (e.g. '1.95'; rustup resolves the latest patch)."
}

variable "vscode_version" {
  type        = string
  description = "Visual Studio Code version, e.g. '1.134.0' (linux-deb-arm64 from update.code.visualstudio.com)."
}

variable "vscode_sha256" {
  type        = string
  description = "SHA256 of the Code <version> arm64 deb for vscode_version."
}

variable "firefox_version" {
  type        = string
  description = "Mozilla Firefox version, e.g. '154.0' (linux-aarch64 en-US tar.xz from ftp.mozilla.org)."
}

variable "firefox_sha256" {
  type        = string
  description = "SHA256 of the firefox-<version>.tar.xz for firefox_version."
}

variable "docker_version" {
  type        = string
  description = "Docker CLI version, e.g. '29.7.2' (linux/static/stable/aarch64 tarball from download.docker.com)."
}

variable "docker_sha256" {
  type        = string
  description = "SHA256 of the docker-<version>.tgz for docker_version."
}

variable "docker_compose_version" {
  type        = string
  description = "Docker Compose plugin version, e.g. '5.5.0' (docker-compose-linux-aarch64 from the GitHub releases)."
}

variable "docker_compose_sha256" {
  type        = string
  description = "SHA256 of the docker-compose-linux-aarch64 binary for docker_compose_version."
}

variable "docker_buildx_version" {
  type        = string
  description = "Docker Buildx plugin version, e.g. '0.36.1' (buildx-<v>.linux-arm64 from the GitHub releases)."
}

variable "docker_buildx_sha256" {
  type        = string
  description = "SHA256 of the buildx-<v>.linux-arm64 binary for docker_buildx_version."
}

# --- VM resources ---

variable "disk_size" {
  type        = number
  default     = 100
  description = "VM disk size in GB."
}

variable "cpu_count" {
  type        = number
  default     = 4
  description = "CPU count of the VM."
}

variable "memory_gb" {
  type        = number
  default     = 8
  description = "RAM of the VM in GB."
}

# --- OpenChamber web UI ---

variable "openchamber_ui_password" {
  type        = string
  default     = "sandbox"
  description = "Password protecting the OpenChamber web UI; required because the server binds to 0.0.0.0 (host access: http://<guest-ip>:4000)."
}

variable "openchamber_port" {
  type        = number
  default     = 4000
  description = "TCP port the OpenChamber web UI listens on inside the guest."
}

variable "openchamber_desktop_version" {
  type        = string
  description = "OpenChamber desktop app version, e.g. \"1.22.0\" (linux-arm64 AppImage from the GitHub releases)."
}

variable "openchamber_desktop_sha256" {
  type        = string
  description = "SHA256 of the OpenChamber-<version>-linux-arm64.AppImage for openchamber_desktop_version."
}

# ---------------------------------------------------------------------------
# Source: VMware (Fusion on Apple Silicon, ARM64 guest)
# ---------------------------------------------------------------------------
#
# Ubuntu Server ARM64 runs natively on VMware Fusion on Apple Silicon —
# Fusion supports Ubuntu 24.04 LTS, and the guest uses the in-box
# open-vm-tools (Fusion ships no Linux tools ISO at all for arm64 guests:
# isoimages/arm64/ contains only windows.iso; open-vm-tools are the
# VMware-recommended tools for Linux and the only in-guest tools available
# for arm64 Linux VMs). The recipe mirrors the reference implementation in
# gusztavvargadr/packer (src/ubuntu/source.vmware.pkr.hcl, Unlicense),
# adapted to this repo's conventions and the Ubuntu Server ARM64 installer:
#
#   - guest_os_type "arm-ubuntu-64" (Fusion's identifier for Ubuntu 64-bit
#     ARM — verified in the VMX binary's guestOS table), hardware version
#     20, NVMe disk (Ubuntu's kernel has an in-box NVMe driver), vmxnet3
#     NIC under NAT (vmxnet3.ko ships in the base linux-modules package,
#     verified for 24.04 arm64), EFI firmware — the proven ARM64 combo,
#   - the autoinstall seed is served over HTTP (autoinstall/ directory,
#     http_directory) and passed to the installer kernel with
#     ds=nocloud-net — the proven way to autoinstall Ubuntu Server under
#     the vmware-iso builder; the boot_command is kept minimal (no wait
#     tokens) so it cannot overrun grub's 30 s menu auto-boot,
#   - Subiquity takes care of the partition layout (LVM over the whole
#     disk), the network profile (DHCP on the NAT), and reboots into the
#     installed system; Packer provisions over SSH afterwards,
#   - open-vm-tools (installed by the autoinstall seed) is what makes
#     vmrun's getGuestIPAddress and HGFS work in the sandbox runner.
#
# No snapshot is created (snapshot_name): the sandbox runner makes a full
# vmrun clone as its working VM, and a snapshot inside the published image
# would only complicate disk compaction and re-clones.

source "vmware-iso" "ubuntu" {
  vm_name          = "sandbox-ubuntu-${var.ubuntu_version}-arm64-vmware"
  output_directory = "${var.build_dir}/output"

  # The build flow (agent-dev-env build) verifies the ISO
  # against var.iso_sha256 before Packer runs; iso_checksum is "none" so
  # Packer does not re-verify.
  iso_url      = var.iso_path
  iso_checksum = "none"

  cpus      = var.cpu_count
  memory    = var.memory_gb * 1024
  disk_size = var.disk_size * 1024

  # --- ARM64 guest wiring (identical shape to the Windows template) ---
  version              = 20
  guest_os_type        = "arm-ubuntu-64"
  disk_type_id         = "0"
  disk_adapter_type    = "nvme"
  network              = "nat"
  network_adapter_type = "vmxnet3"
  firmware             = "efi"
  cdrom_adapter_type   = "sata"

  # Autoinstall seed: user-data + meta-data, served by the build flow's
  # own HTTP server (the flow runs `python3 -m http.server 8004` over
  # autoinstall/; the installer kernel fetches it via ds=nocloud-net). The
  # flow's server is used instead of Packer's http_directory: its port is
  # random and the vmware plugin does not accept an http_port override,
  # while the autoinstall URL has to be known at grub-typing time (see the
  # watchdog note below). The guest reaches the server at the vmnet8 host
  # address (x.y.z.1 — vmnetd delivers guest traffic to the host's
  # loopback, proven by the bridge runners).

  vmx_data = {
    # The install ISO rides on the SATA controller.
    "sata1.present" = "TRUE"
    # USB 3.x controller — the plugin auto-enables USB on Apple Silicon
    # for its own VNC typer; keeping it present makes USB input work.
    "usb_xhci.present" = "TRUE"
    # Boot the install CD before the (empty) NVMe disk, so the firmware
    # reaches the ISO's EFI/grub boot menu as early as possible.
    "bios.bootorder" = "cdrom,hdd"
  }

  # SSH, not WinRM: the installed system ships openssh-server (the
  # autoinstall enables it), and the VM is on a NAT network where the
  # builder can reach it directly. The password must match the crypt hash
  # in autoinstall/user-data (identity.password).
  communicator = "ssh"
  ssh_username = var.ssh_username
  ssh_password = var.ssh_password
  ssh_timeout  = "60m"
  ssh_port     = 22

  # Headless: no Fusion window, VNC pinned for the build watchdog
  # (the bundled VNC build watchdog) — same as the Windows templates.
  headless = true

  vnc_bind_address     = "127.0.0.1"
  vnc_port_min         = 5901
  vnc_port_max         = 5901
  vnc_disable_password = true

  # No boot_command: the VNC typing raced the firmware's variable-length
  # No-Media/PXE probe cycle (the CD only becomes bootable after a retry,
  # 20-40 s in), and stray keys at the probe screen make the firmware
  # attempt devices from the probe. The BUILD WATCHDOG does the typing
  # instead (the bundled watch-build.py + WATCH_BUILD_BOOT_CMD, set by
  # the build flow): it waits for the grub menu or
  # shell in the OCR and then types the autoinstall command. The VNC is
  # still opened (pinned below) for the watchdog, and the plugin's
  # boot_wait simply gives the VM a moment to power on.
  boot_wait    = "5s"
  boot_command = []

  shutdown_command = "echo '${var.ssh_password}' | sudo -S shutdown -P now"
  shutdown_timeout = "10m"
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
#
# All provisioners run as root: the execute_command pipes the sandbox
# password into sudo. User-level installs (nvm, rustup, npm globals, the
# OpenChamber systemd user service) are run as the sandbox user explicitly
# (`sudo -H -u <user>`), inside a single bash -c so $HOME, PATH and
# XDG_RUNTIME_DIR stay correct.
#
# "$" characters in the heredocs are plain bash variables: HCL only
# interpolates "${...}", so do NOT double them to "$$" (bash would expand
# "$$" to its PID — observed as "4330HOME" in a built image).

build {
  sources = ["source.vmware-iso.ubuntu"]

  # ===== Preamble: base system setup =====
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      # --- timezone: UTC, like every other sandbox image ---
      timedatectl set-timezone UTC
      # --- apt maintenance: a sandbox reboots rarely and must boot fast ---
      systemctl disable --now apt-daily.timer apt-daily-upgrade.timer \
        unattended-upgrades.service fstrim.timer motd-news.service \
        2>/dev/null || true
      # --- open-vm-tools: the guest tools (no Fusion tools ISO exists for
      # arm64 Linux); vmtoolsd + vmhgfs-fuse live here ---
      systemctl enable --now open-vm-tools 2>/dev/null || true
      # --- shared-folder mount point (the sandbox runner mounts HGFS here) ---
      mkdir -p /mnt/hgfs/work
      # --- linger: the sandbox user's systemd user services (OpenChamber,
      # bridge relays) must start at boot without a login ---
      loginctl enable-linger ${var.ssh_username}
      # --- home ownership safety: a root-owned path inside the sandbox
      # user's home breaks first-run client writes (EACCES observed with
      # opencode's ~/.local/share) — normalize before any user-level step ---
      chown -R ${var.ssh_username}:${var.ssh_username} /home/${var.ssh_username} || true
      echo "base system ready"
      END
    ]
  }

  # ===== Base toolchain via apt =====
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      apt-get install -y --no-install-recommends \
        build-essential pkg-config make cmake ninja-build autoconf automake \
        git curl wget jq ripgrep vim tmux unzip zip xz-utils \
        git-lfs libicu-dev \
        ca-certificates openssl gnupg \
        python${var.python_version} python3-pip python3-venv python3-dev \
        ruby ruby-dev rbenv \
        socat \
        libfuse2t64 libfuse3-3 \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
        libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 \
        libgtk-3-0t64 libdbus-glib-1-2 libglib2.0-0
      # apt's nodejs/npm are ancient on 24.04 — Node comes via nvm below.
      # The pinned python3.<minor> package is what apt resolves; the assert
      # fails the build loudly if `python3` has drifted from the var.
      python3 --version
      python3 -c "import sys; assert '%d.%d' % sys.version_info[:2] == '${var.python_version}', 'python3 is not ${var.python_version}'"
      git --version
      # Wire git-lfs filters into both root and the sandbox user's global
      # git config (`git lfs install` writes ~/.gitconfig of the invoking
      # user; the script runs as root, so the sandbox user needs its own).
      git lfs install || true
      sudo -H -u ${var.ssh_username} git lfs install || true
      git lfs version
      ninja --version
      echo "apt toolchain ready"
      END
    ]
  }

  # ===== GNOME desktop (minimal) =====
  # The base installer is Ubuntu Server, so the guest boots to a text
  # console by default. A desktop is part of the sandbox: GNOME Shell under
  # GDM3 with automatic login for the sandbox user — the Fusion window is
  # the human interface for VS Code, Firefox and OpenChamber in a browser.
  # Graphics are software-rendered (llvmpipe — Fusion's arm64 guests get no
  # GPU acceleration), and the Xorg session is the default (the virtualhw
  # SVGA works better with the open-vm-tools input drivers than Wayland's
  # compositor here).
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      # ubuntu-desktop-minimal (GNOME Shell + GDM3 + core apps, arm64) and
      # open-vm-tools-desktop (the SVGA Xorg driver, clipboard and
      # drag-and-drop). Recommends stay ON: a desktop without its fonts and
      # theme pieces is a broken desktop (the toolchain installs above keep
      # --no-install-recommends on purpose).
      apt-get install -y ubuntu-desktop-minimal open-vm-tools-desktop
      # Boot straight to a login-free desktop: the VM window is the primary
      # human interface, so the sandbox user must not have to log in first
      # (SSH does not go through the GUI anyway).
      cat >/etc/gdm3/custom.conf <<'GDM'
[daemon]
AutomaticLoginEnable=true
AutomaticLogin=${var.ssh_username}
WaylandEnable=false
GDM
      systemctl set-default graphical.target
      systemctl enable gdm3
      echo "GNOME desktop ready"
      END
    ]
  }

  # ===== GitHub CLI (pinned deb) =====
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      cd /tmp
      DEB="gh_${var.github_cli_version}_linux_arm64.deb"
      curl -fsSL -o "$DEB" "https://github.com/cli/cli/releases/download/v${var.github_cli_version}/$DEB"
      echo "${var.github_cli_sha256}  $DEB" | sha256sum -c -
      dpkg -i "$DEB" || apt-get install -y -f
      rm -f "$DEB"
      gh --version
      END
    ]
  }

  # ===== Go (pinned tarball) =====
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      cd /tmp
      TARBALL="go${var.go_version}.linux-arm64.tar.gz"
      curl -fsSL -o "$TARBALL" "https://go.dev/dl/$TARBALL"
      echo "${var.go_sha256}  $TARBALL" | sha256sum -c -
      rm -rf /usr/local/go
      tar -C /usr/local -xzf "$TARBALL"
      rm -f "$TARBALL"
      # Persist for login shells (profile.d runs before every login shell).
      echo 'export PATH=$PATH:/usr/local/go/bin' | tee /etc/profile.d/agent-dev-env-go.sh
      /usr/local/go/bin/go version
      END
    ]
  }

  # ===== Node.js via nvm (pinned major) =====
  # Same approach as the macOS image: nvm picks the version and makes it
  # the default; the npm global installs (opencode, openchamber) land in
  # the nvm dir. Runs as the sandbox user — npm caches and user configs
  # must not be owned by root.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      sudo -H -u ${var.ssh_username} bash -c '
        set -e
        export NVM_DIR="$HOME/.nvm"
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        . "$NVM_DIR/nvm.sh"
        nvm install ${var.node_version}
        nvm alias default ${var.node_version}
        node --version
        npm --version
      '
      echo "node ready"
      END
    ]
  }

  # ===== Rust via rustup (pinned toolchain) =====
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      sudo -H -u ${var.ssh_username} bash -c '
        set -e
        curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain ${var.rust_version}
        . "$HOME/.cargo/env"
        rustc --version
        cargo --version
      '
      echo 'export PATH=$PATH:$HOME/.cargo/bin' | tee /etc/profile.d/agent-dev-env-rust.sh
      echo "rust ready"
      END
    ]
  }

  # ===== Java — OpenJDK from the Ubuntu archive (opt-in) =====
  # Same role as the mac image's SDKMAN Java, but plain archive OpenJDK: one
  # apt package, no version manager. JAVA_HOME is derived from the real
  # install path (not a hardcoded variant suffix) and exported system-wide
  # for every login shell. Gradle/Android/Kotlin provisioners below depend
  # on it.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      if [ -z '${var.java_version}' ]; then echo 'Skipping Java'; exit 0; fi
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      apt-get install -y openjdk-${var.java_version}-jdk
      JAVA_HOME=$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")
      cat > /etc/profile.d/agent-dev-env-java.sh <<JAVA
export JAVA_HOME="$JAVA_HOME"
export PATH="\$JAVA_HOME/bin:\$PATH"
JAVA
      java -version 2>&1
      echo "java ready"
      END
    ]
  }

  # ===== Gradle — pinned bin zip + wrapper pre-cache (opt-in) =====
  # Direct download like Go/VS Code (no Gradle in the Ubuntu archive that is
  # usable for modern builds): the bin zip into /opt/gradle, the wrapper
  # pre-cache as the sandbox user so the cached distributions land in the
  # user's ~/.gradle (a root-owned cache would be useless for the agent).
  # The scratch project is thrown away; `gradle wrapper` + `./gradlew help`
  # leave the wrapper *-all distribution cached for the pinned version.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      if [ -z '${var.gradle_version}' ]; then echo 'Skipping Gradle'; exit 0; fi
      if ! command -v java >/dev/null 2>&1; then echo "WARN: gradle needs java_version; skipping"; exit 0; fi
      cd /tmp
      ZIP="gradle-${var.gradle_version}-bin.zip"
      curl -fsSL -o "$ZIP" "https://services.gradle.org/distributions/$ZIP"
      echo "${var.gradle_sha256}  $ZIP" | sha256sum -c -
      rm -rf /opt/gradle
      mkdir -p /opt/gradle
      unzip -q "$ZIP" -d /opt/gradle
      rm -f "$ZIP"
      ln -sf /opt/gradle/gradle-${var.gradle_version}/bin/gradle /usr/local/bin/gradle
      sudo -H -u ${var.ssh_username} bash -c '
        set -e
        export JAVA_HOME=$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")
        export PATH="$JAVA_HOME/bin:/usr/local/bin:$PATH"
        tmpdir=$(mktemp -d)
        cd "$tmpdir"
        gradle init --type basic --dsl kotlin --project-name warmup --no-daemon -q >/dev/null 2>&1 || true
        gradle wrapper --gradle-version ${var.gradle_version} --distribution-type all --no-daemon -q
        ./gradlew help --no-daemon -q
        cd /
        rm -rf "$tmpdir"
      '
      gradle --version | head -2
      echo "gradle ready"
      END
    ]
  }

  # ===== Kotlin/Native pre-cache (opt-in, currently skipped) =====
  # The vars file keeps kotlin_native_version empty: JetBrains publishes
  # prebuilt Kotlin/Native tarballs only for macOS (x86_64/aarch64) and
  # Linux x86_64 — the linux-aarch64 URL 404s for every version (verified
  # 2026-09-02, releases/1.9.24/linux-aarch64/...), so the pre-cache can
  # never download. The provisioner stays (guarded by -z, below) so a
  # future upstream distro can be enabled from the vars file alone. The
  # URL is built at runtime with $$ (HCL renders it to $) because the
  # version is a bash variable inside the sudo'd snippet.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      if [ -z '${var.kotlin_native_version}' ]; then echo 'Skipping Kotlin/Native pre-cache (no linux-aarch64 prebuilt upstream)'; exit 0; fi
      sudo -H -u ${var.ssh_username} bash -c '
        set -e
        KN_VERSION="${var.kotlin_native_version}"
        KN_URL="https://download.jetbrains.com/kotlin/native/builds/releases/$${KN_VERSION}/linux-aarch64/kotlin-native-prebuilt-linux-aarch64-$${KN_VERSION}.tar.gz"
        mkdir -p "$HOME/.konan"
        curl -fsSL "$${KN_URL}" | tar -xz -C "$HOME/.konan/"
        echo "Kotlin/Native $${KN_VERSION} cached at ~/.konan"
      '
      echo "kotlin/native ready"
      END
    ]
  }

  # ===== Android SDK — bootstrap + packages (opt-in) =====
  # The Linux guest has no pre-installed SDK (unlike the Cirrus macOS base
  # image), so the SDK is bootstrapped first: cmdline-tools (hash-pinned
  # zip) into /opt/android-sdk, licenses accepted, then the packages pinned
  # in android_sdk_packages (NDK, build-tools, ...). The profile.d exports
  # make sdkmanager/adb available in every login shell.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      if [ '${length(var.android_sdk_packages)}' -eq '0' ]; then echo 'Skipping Android SDK'; exit 0; fi
      export ANDROID_HOME=/opt/android-sdk
      export ANDROID_SDK_ROOT=$ANDROID_HOME
      cd /tmp
      ZIP="commandlinetools-linux-${var.android_cmdline_tools_version}_latest.zip"
      curl -fsSL -o "$ZIP" "https://dl.google.com/android/repository/$ZIP"
      echo "${var.android_cmdline_tools_sha256}  $ZIP" | sha256sum -c -
      rm -rf "$ANDROID_HOME" /tmp/android-cmdline-tools
      mkdir -p "$ANDROID_HOME/cmdline-tools"
      unzip -q "$ZIP" -d /tmp/android-cmdline-tools
      mv /tmp/android-cmdline-tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
      rm -f "$ZIP" && rm -rf /tmp/android-cmdline-tools
      export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
      yes | sdkmanager --licenses >/dev/null 2>&1 || true
      yes | sdkmanager ${join(" ", [for p in var.android_sdk_packages : "\"${p}\""])}
      cat > /etc/profile.d/agent-dev-env-android.sh <<'ANDROID'
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools
ANDROID
      test -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
      echo "Android SDK packages installed"
      END
    ]
  }

  # ===== Visual Studio Code (pinned arm64 deb) =====
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      cd /tmp
      DEB="code_${var.vscode_version}_arm64.deb"
      curl -fsSL -o "$DEB" "https://update.code.visualstudio.com/${var.vscode_version}/linux-deb-arm64/stable"
      echo "${var.vscode_sha256}  $DEB" | sha256sum -c -
      dpkg -i "$DEB" || apt-get install -y -f
      rm -f "$DEB"
      ln -sf /usr/bin/code /usr/local/bin/code
      code --version | head -n1
      END
    ]
  }

  # ===== Mozilla Firefox (pinned linux-aarch64 release) =====
  # No Google Chrome: Chrome for Testing publishes no linux-arm64 build
  # (only x86_64 linux64) and Ubuntu's chromium is snap-only, so Firefox
  # is the browser in the image (linux-aarch64 releases are official).
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      cd /tmp
      ARCHIVE="firefox-${var.firefox_version}.tar.xz"
      curl -fsSL -o "$ARCHIVE" "https://ftp.mozilla.org/pub/firefox/releases/${var.firefox_version}/linux-aarch64/en-US/$ARCHIVE"
      echo "${var.firefox_sha256}  $ARCHIVE" | sha256sum -c -
      rm -rf /opt/firefox
      mkdir -p /opt/firefox
      tar -xJf "$ARCHIVE" -C /opt/firefox --strip-components=1
      rm -f "$ARCHIVE"
      ln -sf /opt/firefox/firefox /usr/local/bin/firefox
      firefox --version
      END
    ]
  }

  # ===== Docker CLI + plugins (client only, pinned static binaries) =====
  # The guest never runs a container engine (it is bridged to the host's);
  # only the CLI + compose + buildx are installed. Plugin search paths:
  # the CLI checks /usr/local/lib/docker/cli-plugins after the user dirs.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      cd /tmp
      TGZ="docker-${var.docker_version}.tgz"
      curl -fsSL -o "$TGZ" "https://download.docker.com/linux/static/stable/aarch64/$TGZ"
      echo "${var.docker_sha256}  $TGZ" | sha256sum -c -
      tar -xzf "$TGZ"
      install -Dm755 "docker/docker" /usr/local/bin/docker
      rm -rf docker "$TGZ"
      mkdir -p /usr/local/lib/docker/cli-plugins
      curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
        "https://github.com/docker/compose/releases/download/v${var.docker_compose_version}/docker-compose-linux-aarch64"
      echo "${var.docker_compose_sha256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -
      chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose
      curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx \
        "https://github.com/docker/buildx/releases/download/v${var.docker_buildx_version}/buildx-v${var.docker_buildx_version}.linux-arm64"
      echo "${var.docker_buildx_sha256}  /usr/local/lib/docker/cli-plugins/docker-buildx" | sha256sum -c -
      chmod 755 /usr/local/lib/docker/cli-plugins/docker-buildx
      # The static CLI looks for plugins in $HOME/.docker/cli-plugins (and
      # the system dir next to /usr/local/bin); mirror the plugins into the
      # caller's (root) and the sandbox user's plugin dirs so both root and
      # admin shells see `docker compose` / `docker buildx`.
      for pdir in "$HOME/.docker/cli-plugins" "/home/${var.ssh_username}/.docker/cli-plugins"; do
        mkdir -p "$pdir"
        ln -sf /usr/local/lib/docker/cli-plugins/docker-compose "$pdir/docker-compose"
        ln -sf /usr/local/lib/docker/cli-plugins/docker-buildx "$pdir/docker-buildx"
      done
      # docker context 'host' pointing at the runtime bridge socket (the
      # runner's guest bridge creates /tmp/docker.sock); nice-to-have only —
      # the profile.d DOCKER_HOST export (written by the runner) covers
      # clients that ignore contexts, so a context failure must not fail
      # the build.
      sudo -H -u ${var.ssh_username} bash -c '
        docker context create host --description "Host engine via /tmp/docker.sock bridge" \
          --docker "host=unix:///tmp/docker.sock" 2>&1 || true
        docker context use host 2>&1 || true
      '
      docker --version
      docker compose version
      docker buildx version
      END
    ]
  }

  # ===== OpenCode, OpenCodeReview, OpenChamber web UI =====
  # npm globals as the sandbox user. OpenChamber runs as a systemd user
  # service (systemd is the Linux equivalent of the macOS LaunchAgent /
  # Windows ONLOGON task): a deterministic unit is written by this image
  # (framed exactly like the Windows image's wrapper approach — the
  # openchamber CLI's own `startup enable` prefers an interactive user
  # session to detect the service backend). The unit pins PATH (systemd
  # user services start with a minimal environment — nvm/node and cargo
  # paths must be explicit), OPENCODE_BINARY, OPENCHAMBER_UI_PASSWORD and
  # SSH_AUTH_SOCK / DOCKER_HOST (the runner's bridge sockets).
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      # nvm dir of the sandbox user (node lives there; nvm only loads in
      # interactive shells, so non-login shells need the path directly).
      NPM_BIN=$(sudo -H -u ${var.ssh_username} bash -c 'ls -d $HOME/.nvm/versions/node/v* 2>/dev/null | tail -n1')/bin
      [ -n "$NPM_BIN" ] && [ -x "$NPM_BIN/npm" ] || { echo "nvm node dir not found"; exit 1; }
      # Root-side guarantees (the user shell below has privileges to write
      # only what its owner owns): create the XDG dirs with explicit
      # ownership so first-run writes (opencode's ~/.local/share) can
      # never hit an EACCES. `.local` must be listed as its own operand:
      # install -d only applies -o/-g to the operands, and an intermediate
      # `.local` would be created root-owned (breaking `tar -C $HOME` and
      # any write the sandbox user makes directly into ~/.local).
      install -d -o ${var.ssh_username} -g ${var.ssh_username} \
        /home/${var.ssh_username}/.local \
        /home/${var.ssh_username}/.local/share \
        /home/${var.ssh_username}/.local/state \
        /home/${var.ssh_username}/.config /home/${var.ssh_username}/.cache
      sudo -H -u ${var.ssh_username} bash -c '
        set -e
        export NVM_DIR="$HOME/.nvm"
        . "$NVM_DIR/nvm.sh"
        nvm use default >/dev/null
        # opencode via the official installer: the npm package postinstall
        # mis-selects the arm64-musl binary on glibc systems (EBADPLATFORM).
        curl -fsSL https://opencode.ai/install | bash
        export PATH="$HOME/.opencode/bin:$PATH"
        opencode --version
        npm install -g @alibaba-group/open-code-review@${var.open_code_review_version}
        npm install -g @openchamber/web
        # Package managers for frontend/Node projects (the mac image ships
        # them as nvm globals too).
        npm install -g pnpm yarn
        ocr --version
        openchamber --version
        pnpm --version
        yarn --version
      '
      OPENCODE_BIN="$ADMIN_HOME/.opencode/bin/opencode"
      ADMIN_HOME=$(sudo -H -u ${var.ssh_username} bash -c 'printf %s "$HOME"')
      # Keep the CLI's own env file consistent (openchamber status/logs
      # read it; the runtime service unit is ours).
      sudo -H -u ${var.ssh_username} mkdir -p "$ADMIN_HOME/.config/openchamber"
      cat > /tmp/startup.env <<EOF
OPENCHAMBER_UI_PASSWORD='${var.openchamber_ui_password}'
OPENCODE_BINARY='$OPENCODE_BIN'
EOF
      sudo -H -u ${var.ssh_username} cp /tmp/startup.env "$ADMIN_HOME/.config/openchamber/startup.env"
      rm -f /tmp/startup.env

      # systemd user unit — the deterministic service the sandbox runner
      # also restarts after the bridges come up.
      sudo -H -u ${var.ssh_username} mkdir -p "$ADMIN_HOME/.config/systemd/user"
      cat > /tmp/agent-dev-env-openchamber.service <<EOF
[Unit]
Description=OpenChamber Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=$NPM_BIN/openchamber serve --port ${var.openchamber_port} --host 0.0.0.0 --foreground
Environment=PATH=$NPM_BIN:$ADMIN_HOME/.opencode/bin:/usr/local/go/bin:$ADMIN_HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=OPENCODE_BINARY=$OPENCODE_BIN
Environment=OPENCHAMBER_UI_PASSWORD=${var.openchamber_ui_password}
Environment=SSH_AUTH_SOCK=/tmp/ssh-agent.sock
Environment=DOCKER_HOST=unix:///tmp/docker.sock
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
      sudo -H -u ${var.ssh_username} cp /tmp/agent-dev-env-openchamber.service \
        "$ADMIN_HOME/.config/systemd/user/agent-dev-env-openchamber.service"
      rm -f /tmp/agent-dev-env-openchamber.service
      sudo -H -u ${var.ssh_username} bash -c '
        export XDG_RUNTIME_DIR="/run/user/$(id -u)"
        systemctl --user daemon-reload
        systemctl --user enable --now agent-dev-env-openchamber
      '
      END
    ]
  }

  # ===== OpenChamber desktop app (linux-arm64 AppImage) =====
  # Parity with the mac image's openchamber cask: the desktop app for the
  # GNOME session (pair it with the web UI service via
  # `openchamber connect-url --port 4000 --server http://127.0.0.1:4000`,
  # see docs/ubuntu-vmware.md). The AppImage runs on the libfuse2 installed
  # above; if FUSE is unavailable it can be executed with
  # --appimage-extract-and-run.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      cd /tmp
      APP="OpenChamber-${var.openchamber_desktop_version}-linux-arm64.AppImage"
      curl -fsSL -o "$APP" "https://github.com/openchamber/openchamber/releases/download/v${var.openchamber_desktop_version}/$APP"
      echo "${var.openchamber_desktop_sha256}  $APP" | sha256sum -c -
      rm -rf /opt/openchamber
      mkdir -p /opt/openchamber
      install -m 755 -o root -g root "$APP" /opt/openchamber/OpenChamber.AppImage
      rm -f "$APP"
      ln -sf /opt/openchamber/OpenChamber.AppImage /usr/local/bin/openchamber-desktop
      cat > /usr/share/applications/openchamber.desktop <<'DESKTOP'
[Desktop Entry]
Name=OpenChamber
Comment=AI coding agent workspace
Exec=openchamber-desktop %U
Terminal=false
Type=Application
Categories=Development;
DESKTOP
      test -x /opt/openchamber/OpenChamber.AppImage
      echo "openchamber desktop ready"
      END
    ]
  }

  # ===== OpenChamber health check + cleanup =====
  # The service runs as a systemd user unit (linger enabled in the base
  # provisioner): poll the HTTP endpoint until it answers (the first start
  # may take a couple of minutes — npm modules + OpenCode spawn).
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      sudo -H -u ${var.ssh_username} bash -c '
        export XDG_RUNTIME_DIR="/run/user/$(id -u)"
        systemctl --user is-active agent-dev-env-openchamber
      '
      n=0
      while [ "$n" -lt 60 ]; do
        if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:${var.openchamber_port}" >/dev/null 2>&1; then
          echo "OpenChamber web UI is up on port ${var.openchamber_port}"
          break
        fi
        n=$((n + 1))
        sleep 5
      done
      if [ "$n" -ge 60 ]; then
        echo "WARN: OpenChamber did not answer on 127.0.0.1:${var.openchamber_port}"
      fi
      apt-get autoclean -y || true
      apt-get autoremove -y || true
      rm -rf /var/lib/apt/lists/* /tmp/* 2>/dev/null || true
      echo "Ubuntu sandbox image complete"
      END
    ]
  }

  # ===== Final verification =====
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      echo "=== Versions ==="
      lsb_release -ds
      uname -m
      systemctl is-active open-vm-tools
      # Desktop (GNOME): the packages and the boot target — run as root,
      # no display needed for the checks.
      dpkg -s ubuntu-desktop-minimal open-vm-tools-desktop >/dev/null
      systemctl is-enabled gdm3
      default_target=$(systemctl get-default)
      [ "$default_target" = "graphical.target" ] || echo "WARN: default target is $default_target"
      # Node/npm/opencode/ocr/openchamber live in the sandbox user's home
      # (nvm + .opencode/bin) — the verification shell runs as root, so
      # those have to be checked as the user.
      sudo -H -u ${var.ssh_username} bash -c '
        export PATH="$HOME/.opencode/bin:$PATH"
        export NVM_DIR="$HOME/.nvm"
        . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
        nvm use default >/dev/null
        node --version
        npm --version
        pnpm --version
        yarn --version
        opencode --version | head -n1
        ocr --version
        openchamber --version | head -n1
      '
      python3 --version
      git --version
      git lfs version
      gh --version
      rg --version
      jq --version
      ninja --version
      rbenv --version
      /usr/local/go/bin/go version
      sudo -H -u ${var.ssh_username} bash -c '. "$HOME/.cargo/env"; rustc --version; cargo --version'
      code --version | head -n1
      docker --version
      docker compose version
      docker buildx version
      # Optional toolchains — verified only when pinned in the vars file (a
      # bare `packer build` without a vars file skips them).
      if [ -n '${var.java_version}' ]; then java -version 2>&1 | head -1; fi
      if [ -n '${var.gradle_version}' ]; then gradle --version | head -2; fi
      if [ -n '${var.kotlin_native_version}' ]; then sudo -H -u ${var.ssh_username} bash -c 'test -d ~/.konan && echo "Kotlin/Native: precached in ~/.konan"'; fi
      if [ '${length(var.android_sdk_packages)}' -gt '0' ]; then test -x /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager && echo "Android SDK ready"; fi
      test -x /opt/openchamber/OpenChamber.AppImage
      # check-and-warn: a missing helper must never fail the build
      for tool in firefox; do
        if command -v "$tool" >/dev/null 2>&1; then
          "$tool" --version 2>/dev/null | head -n1 || true
        else
          echo "WARN: $tool not found on PATH"
        fi
      done
      sudo -H -u ${var.ssh_username} bash -c '
        export XDG_RUNTIME_DIR="/run/user/$(id -u)"
        systemctl --user list-unit-files | grep agent-dev-env-openchamber || true
        docker context ls | grep host || true
      '
      END
    ]
  }

  # Image identity — the image records its own name/version inside the
  # guest (~/.config/agent-dev-env/image.json, the green-field guest
  # marker dir), so any clone of it can answer "which image am I" without
  # host-side provenance records. Written through sudo -H so the file
  # lands in the sandbox user's home, owned by it.
  provisioner "shell" {
    execute_command = "echo '${var.ssh_password}' | sudo -S -E bash '{{.Path}}'"
    inline = [<<-END
      set -e -x
      sudo -H -u ${var.ssh_username} bash -c '
        mkdir -p "$HOME/.config/agent-dev-env"
        cat > "$HOME/.config/agent-dev-env/image.json" <<JSON
        {
          "image": "sandbox-ubuntu-${var.ubuntu_version}-arm64-vmware",
          "image_version": "${var.image_version}",
          "platform": "ubuntu-vmware",
          "ubuntu_version": "${var.ubuntu_version}"
        }
JSON
        cat "$HOME/.config/agent-dev-env/image.json"
      '
      END
    ]
  }
}
