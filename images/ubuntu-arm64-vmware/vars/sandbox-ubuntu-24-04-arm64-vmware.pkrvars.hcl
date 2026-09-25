# Ubuntu 24.04 LTS (ARM64) sandbox image — VMware (Fusion) build.
#
# Built with the Packer vmware-iso plugin on Apple Silicon (the vmware-iso
# builder drives VMware Fusion, which virtualizes ARM64 guests natively):
# Ubuntu Server ARM64 ISO + Subiquity autoinstall (seed served over HTTP).
# See images/ubuntu-arm64-vmware/README.md for the full build flow — the
# Ubuntu ISO is bring-your-own (not redistributable via Packer), so it is
# not part of this repo.

ubuntu_version = "24-04"

# SHA256 of the Ubuntu Server 24.04 ARM64 ISO. Canonical publishes the hash
# in the release SHA256SUMS (https://cdimage.ubuntu.com/releases/24.04/release/);
# paste it here to enable integrity verification. Set UBUNTU_ISO_PATH to the
# local ISO path when building. Empty = skip verification.
iso_sha256 = "9a6ce6d7e66c8abed24d24944570a495caca80b3b0007df02818e13829f27f32"

# Toolchain versions. Direct downloads are pinned by version + SHA256 here
# (the hashes come from the vendor's published checksums); nvm (Node) and
# rustup (Rust) pin the major/minor and resolve the latest patch. apt
# packages (gcc, git, ...) come from the Ubuntu archive, except Python,
# which is pinned to the archive's python3.<minor> package.
node_version = "26"
python_version = "3.12"
github_cli_version = "2.98.0"
github_cli_sha256 = "bbc4ac7964c2a091fd555cd1758d10a7cfcfdc472e405f0b0fb958f05d535cb6"
open_code_review_version = "1.9.5"
go_version = "1.27.0"
go_sha256 = "51798d2c42d0e1c6ed7fd9f48728b4193abac9e8aad6dbac2fe96a81f5909bda"
rust_version = "1.95"
vscode_version = "1.134.0"
vscode_sha256 = "b30f5bda4855231681cc7fe22d4a59e7dbee2be170b0e4fb04c7e83b9f9affe5"

# Mozilla Firefox: official linux-aarch64 release tarball (en-US), pinned
# by version + SHA256 (SHA256SUMS from the same FTP directory). No Google
# Chrome: CfT publishes no linux-arm64 build (only x86_64 linux64) and
# Ubuntu's chromium is snap-only.
firefox_version = "154.0"
firefox_sha256 = "0391a8d072431286fbed8f9ff497a126ff0c9e81c455d4ef04f9fb878fd4bf1f"

# Docker CLI + plugins (client only — the engine is bridged from the host
# by the sandbox runner). Static aarch64 binaries, hash-pinned.
docker_version = "29.7.2"
docker_sha256 = "43d143448adf2c2787704e7d7704fd6d62d367a54c5edaef0a3f75509cb0938d"
docker_compose_version = "5.5.0"
docker_compose_sha256 = "ff42489f5a9b879d5d117c5ffea6defc27390b3286da8ad52cbc9c6ab5df590e"
docker_buildx_version = "0.36.1"
docker_buildx_sha256 = "5d0cafd9d16afe1a0f0d9529885344ace2cc99efdd531b6c783c5455a6001569"

# Optional toolchains (empty = skip; see sandbox.pkr.hcl) — OpenJDK from the
# archive (JAVA_HOME exported via /etc/profile.d), Gradle (hash-pinned bin
# zip + wrapper pre-cache) and the Android SDK, bootstrapped into
# /opt/android-sdk (the Linux guest has no pre-installed SDK).
#
# Kotlin/Native is deliberately left empty: JetBrains publishes prebuilt
# Kotlin/Native tarballs only for macOS (x86_64/aarch64) and Linux x86_64 —
# the linux-aarch64 URL 404s for every version (verified 2026-09-02:
# releases/1.9.24/linux-aarch64/... 404s), so the pre-cache could never
# work and a non-empty value fails the build at curl.
java_version = "17"
gradle_version = "8.7"
gradle_sha256 = "544c35d6bd849ae8a5ed0bcea39ba677dc40f49df7d1835561582da2009b961d"
kotlin_native_version = ""
android_cmdline_tools_version = "14742923"
android_cmdline_tools_sha256 = "04453066b540409d975c676d781da1477479dde3761310f1a7eb92a1dfb15af7"
android_sdk_packages = ["ndk;29.0.14206865", "build-tools;34.0.0"]

# OpenChamber desktop app 2.0.0 — the OpenCode V2-compatible release
# (linux-arm64 AppImage from the GitHub releases, hash-pinned) — parity
# with the mac image's openchamber cask.
openchamber_desktop_version = "2.0.0"
openchamber_desktop_sha256 = "7ddfaba7c98ee86123dd8266a87dd8b68c81bf4a86f1e4ca3066dec4ca42c3da"

# VM resources
disk_size = 100
cpu_count = 4
memory_gb = 8

# SSH credentials used for provisioning. They are baked into
# images/ubuntu-arm64-vmware/autoinstall/user-data (identity: user +
# password hash) and become the sandbox's login — keep the two files in
# sync.
ssh_username = "admin"
ssh_password = "sandbox1"

# OpenChamber web UI password + port. The runner advertises the UI at
# http://<guest-ip>:4000 (password "sandbox" by default). OpenChamber
# refuses to serve on the network without a password.
openchamber_ui_password = "sandbox"
openchamber_port = 4000

# Semantic version this image is published under (also the GHCR push tag,
# besides :latest). For every release: bump it, add a CHANGELOG.md entry,
# and create the ubuntu-arm64-vmware-v<version> git tag
# (npx agent-dev-env tag <image>).
image_version = "2.1.0"
