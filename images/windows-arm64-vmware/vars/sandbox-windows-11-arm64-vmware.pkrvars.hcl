# Windows 11 (ARM64) sandbox image — VMware (Fusion) build.
#
# Built with the Packer vmware-iso plugin on Apple Silicon (the vmware-iso
# builder drives VMware Fusion, which virtualizes ARM64 guests natively):
# Windows 11 ARM64 ISO + Fusion's ARM64 boot drivers + VMware Tools. See
# images/windows-arm64-vmware/README.md for the full build flow — the
# Windows ISO is bring-your-own (Microsoft does not permit redistribution),
# so it is not part of this repo.

windows_version = "11"

# SHA256 of the Windows 11 ARM64 ISO. Microsoft publishes the hash on the
# download page (https://www.microsoft.com/software-download/windows11arm64);
# paste it here to enable integrity verification. Set WINDOWS_ISO_PATH to
# the local ISO path when building. Empty = skip verification.
iso_sha256 = "638AA2C88E94385B00F4F178D071E3DF0B7D9E335577A83BD533B7F2EB65ADF0"

# VMware Fusion installation that supplies the ARM64 boot drivers
# (Contents/Library/isoimages/arm64/drivers-arm64.zip) and the ARM64 VMware
# Tools ISO (Contents/Library/isoimages/arm64/windows.iso) during the build;
# the sandbox runner needs the same Fusion to run the VM.
# Fusion 13.6+ is required (the Packer vmware plugin's minimum).
vmware_fusion_app_path = "/Applications/VMware Fusion.app"

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
# images/windows-arm64-vmware/autounattend.xml (Administrator password) and
# become the sandbox's login (SSH/RDP) — keep the two files in sync.
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

# OpenChamber desktop app 2.0.0 — the OpenCode V2-compatible release
# (win-arm64 NSIS installer from the GitHub releases, hash-pinned) —
# parity with the mac cask and the Ubuntu AppImage.
openchamber_desktop_version = "2.0.0"
openchamber_desktop_sha256 = "a8280d2f09fa784a64c5d88007c2dea82bf36bc9d313de1158610252a556d367"

# OpenChamber web UI password + port. The runner advertises the UI at
# http://<guest-ip>:4000 (password "sandbox" by default). OpenChamber
# refuses to serve on the network without a password.
openchamber_ui_password = "sandbox"
openchamber_port = 4000

# Semantic version this image is published under (also the GHCR push tag,
# besides :latest). For every release: bump it, add a CHANGELOG.md entry,
# and create the windows-arm64-vmware-v<version> git tag
# (npx agent-dev-env tag <image>).
image_version = "2.1.0"
