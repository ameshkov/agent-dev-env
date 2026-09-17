# Windows 11 (ARM64) sandbox image.
#
# Built with the Packer qemu plugin on Apple Silicon (HVF accelerator):
# Windows 11 ARM64 ISO + virtio-win drivers + swtpm (TPM 2.0). See
# images/windows-arm64-qemu/README.md for the full build flow — the Windows ISO is
# bring-your-own (Microsoft does not permit redistribution), so it is not
# part of this repo.

windows_version = "11"

# SHA256 of the Windows 11 ARM64 ISO. Microsoft publishes the hash on the
# download page (https://www.microsoft.com/software-download/windows11arm64);
# paste it here to enable integrity verification. Set WINDOWS_ISO_PATH to
# the local ISO path when building. Empty = skip verification.
iso_sha256 = "638AA2C88E94385B00F4F178D071E3DF0B7D9E335577A83BD533B7F2EB65ADF0"

# virtio-win ISO with ARM64 drivers (release 0.1.240+). Downloaded by
# the agent-dev-env CLI build flow into build/windows-arm64-qemu/
# packer_cache/ when VIRTIO_WIN_ISO_PATH is unset; paste the published
# SHA256 to verify (empty = skip).
virtio_win_url = "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso"
virtio_win_sha256 = ""

# Toolchain versions installed via Chocolatey (choco package versions —
# must exist in the community repository) — except Node.js: the official
# win-arm64 zip from nodejs.org (choco's nodejs is the x64 build).
nodejs_version = "26.8.1"
# SHA256 of node-v26.8.1-win-arm64.zip (nodejs.org/dist/v26.8.1/SHASUMS256.txt).
nodejs_sha256 = "09d62005aa9dca8fcd9bdce8196f5aa783eee3818d5af74089eb7297103c02d4"
python_version = "3.13.15"
# SHA256 of python-3.13.15-arm64.exe (python.org/ftp/python/3.13.15/).
python_sha256 = "c252c676087c49e6b94e95a273536b78921c28a5fc9f86d15d25392328247249"
github_cli_version = "2.97.0"
# SHA256 of gh_2.97.0_windows_arm64.zip (cli/cli release v2.97.0).
github_cli_sha256 = "3e2d4a166da4ee5020c592737b65eec0e724946d5d5b962f5fe59d99116dc4bf"
ripgrep_version = "15.2.0"
git_version = "2.55.0.4"
# SHA256 of Git-2.55.0.4-arm64.exe (git-for-windows release v2.55.0.windows.4).
git_sha256 = "8d358f4d53a5a475570edca3124dc0d4f1a020321594984f58e6b04f86f50ec4"
jq_version = "1.8.1"
open_code_review_version = "1.9.5"
# Firefox: official win64-aarch64 installer (mozilla.org versioned product
# URL; the win64-x64 choco package is not native).
firefox_version = "155.0.1"
firefox_sha256 = "920a8ef590280b5c5e82cff413bcb1780ef2d887aa9f54218e735ae0f8cf3a92"

# C/C++ + cross-language toolchains (brought over from AdGuard's
# build-agent-images windows2022-vs2022 / windows2022-go images).
# VS2022 Build Tools (choco package version; the finalizer adds the .NET
# SDKs + VC++ workload + Win11 SDK) and Rust (via rustup, not choco) are
# installed by dedicated provisioners.
go_version = "1.27.0"
# SHA256 of go1.27.0.windows-arm64.zip (go.dev/dl).
go_sha256 = "6e0156b9788209931dd340fadc04171ce15063c17b51c92e7b86b51109626e90"
rust_version = "1.95"
wixtoolset_version = "3.14.1.20250415"
protoc_version = "36.0.0"
nasm_version = "3.2.0"
llvm_version = "22.1.7"
vim_version = "9.2.995"
nuget_version = "7.9.0"
mingw_version = "16.1.0"
make_version = "4.4.1"
vs_buildtools_version = "117.14.37"

# VM resources
disk_size = 100
cpu_count = 4
memory_gb = 8

# WinRM credentials used for provisioning. They are baked into
# images/windows-arm64-qemu/autounattend.xml (Administrator password) and become the
# sandbox's login (SSH/RDP) — keep the two files in sync.
winrm_username = "Administrator"
winrm_password = "sandbox1"

# Tooling brought over from AdGuard's windows2022-vs2022 / windows2022-flutter
# images: Ninja (choco; Git LFS is bundled with Git for Windows), Temurin
# JDK 21 (JAVA_HOME + jni.h/jvm.lib, a JDK not a JRE) and Conan via pip. The
# JDK is the official Adoptium win-aarch64 zip (choco's temurin21 is x64).
jdk_version = "21.0.12.1"
# SHA256 of OpenJDK21U-jdk_aarch64_windows_hotspot_21.0.12.1_1.zip
# (adoptium/jdk-21.0.12.1+1 release; Adoptium asset checksum).
jdk_sha256 = "ccf2e51f527d542a70ba5794a600d3aac04b4e967950e227834c7566cb1bec7b"
ninja_version = "1.13.2"

# OpenChamber desktop app (win-arm64 NSIS installer from the GitHub
# releases, hash-pinned) — parity with the mac cask and the Ubuntu AppImage.
openchamber_desktop_version = "1.22.0"
openchamber_desktop_sha256 = "6c49e9a6fdd6a2b6f4e4618f3eb83ab46b4b0e667b04668ac1ac9890622941f3"

# OpenChamber web UI password + port. The runner forwards guest 4000 to
# host 127.0.0.1:4000, so the UI is reachable at http://127.0.0.1:4000
# (password "sandbox" by default). OpenChamber refuses to serve on the
# network without a password.
openchamber_ui_password = "sandbox"
openchamber_port = 4000

# Semantic version this image is published under (also the GHCR push tag,
# besides :latest). For every release: bump it, add a CHANGELOG.md entry,
# and create the windows-arm64-qemu-v<version> git tag
# (npx agent-dev-env tag <image>).
image_version = "2.0.0"
