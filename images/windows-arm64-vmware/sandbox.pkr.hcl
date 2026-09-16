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
# The Windows build is shared between the QEMU and VMware platforms: the
# toolchain, credentials and OpenChamber vars mirror
# images/windows-arm64-qemu/sandbox.pkr.hcl. The VMware build differs in the
# mechanics — VMware Fusion hosts the installer and the VM is exported as a
# .vmx + .vmdk instead of a qcow2.

variable "windows_version" {
  type        = string
  description = "Windows guest version, e.g. '11'; part of the image name (sandbox-windows-<windows_version>-arm64-vmware)."
}

variable "image_version" {
  type        = string
  description = "Semantic version this image is published under; bump it + add a CHANGELOG.md entry per release."
}

# --- Build layout ---
#
# Built images and their scratch land in a top-level build/ directory:
# build/windows-arm64-vmware/output (Packer's output_directory) and
# build/windows-arm64-vmware/drivers/ (staged into the unattend CD).
# The agent-dev-env CLI build flow computes the directory and passes
# it in; the default keeps a bare `packer build` from the platform dir
# working.

variable "build_dir" {
  type        = string
  default     = "."
  description = "Per-image build directory: <build_dir>/output holds the built image and <build_dir>/drivers the staged unattend-CD drivers. Set by `agent-dev-env build` to build/windows-arm64-vmware/."
}

# --- Windows install ISO (bring-your-own, see images/windows-arm64-vmware/README.md) ---

variable "iso_path" {
  type        = string
  description = "Absolute path to the Windows 11 ARM64 ISO. Set by the agent-dev-env CLI build flow (PKR_VAR_iso_path); the ISO is not redistributable so it cannot live in the repo. Required — validate with `-var iso_path=/path/to/iso`."
}

variable "iso_sha256" {
  type        = string
  default     = ""
  description = "SHA256 of the Windows ISO as published on the Microsoft download page. Read by the agent-dev-env CLI build flow for verification, not by Packer itself (iso_checksum is 'none')."
}

# --- VMware Fusion (host hypervisor + ARM64 boot drivers + tools ISO) ---

variable "vmware_fusion_app_path" {
  type        = string
  default     = "/Applications/VMware Fusion.app"
  description = "Path of the VMware Fusion installation. Packer's vmware-iso builder drives Fusion via vmrun; the ARM64 Windows boot drivers (drivers-arm64.zip) and the ARM64 VMware Tools ISO (isoimages/arm64/windows.iso) come from the app bundle."
}

# --- Toolchain versions (installed via Chocolatey) ---

variable "nodejs_version" {
  type        = string
  description = "Node.js version, e.g. '26.8.1' (official win-arm64 zip from nodejs.org)."
}

variable "nodejs_sha256" {
  type        = string
  description = "SHA256 of node-v<nodejs_version>-win-arm64.zip (from nodejs.org SHASUMS256.txt)."
}

variable "python_version" {
  type        = string
  description = "Python version, e.g. '3.13.15' (official win-arm64 installer from python.org)."
}

variable "python_sha256" {
  type        = string
  description = "SHA256 of python-<python_version>-arm64.exe."
}

variable "github_cli_version" {
  type        = string
  description = "GitHub CLI version, e.g. '2.97.0' (official win-arm64 zip)."
}

variable "github_cli_sha256" {
  type        = string
  description = "SHA256 of gh_<github_cli_version>_windows_arm64.zip."
}

variable "ripgrep_version" {
  type        = string
  description = "ripgrep version, e.g. '15.2.0' (choco package version; no win-arm64 build exists)."
}

variable "git_version" {
  type        = string
  description = "Git version, e.g. '2.55.0.4' (Git for Windows release; the installer is the win-arm64 exe)."
}

variable "git_sha256" {
  type        = string
  description = "SHA256 of Git-<git_version>-arm64.exe (Git for Windows release v<git_version>.windows.<patch>)."
}

variable "jq_version" {
  type        = string
  description = "jq version, e.g. '1.8.1' (choco package version; no win-arm64 build exists)."
}

variable "open_code_review_version" {
  type        = string
  description = "open-code-review (ocr) version installed via npm."
}

# --- C/C++ + cross-language toolchains (brought over from AdGuard's
# build-agent-images windows2022-vs2022 image) ---

variable "vs_buildtools_version" {
  type        = string
  description = "VS2022 Build Tools choco package version, e.g. '117.14.37' (the installer is then finalized with setup.exe + the .NET SDK / VC++ / Win11 SDK components)."
}

variable "go_version" {
  type        = string
  description = "Go version, e.g. '1.27.0' (official go<version>.windows-arm64.zip)."
}

variable "go_sha256" {
  type        = string
  description = "SHA256 of go<go_version>.windows-arm64.zip."
}

variable "rust_version" {
  type        = string
  description = "Rust toolchain version installed via rustup (e.g. '1.95'; rustup resolves the latest patch)."
}

variable "jdk_version" {
  type        = string
  description = "JDK version, e.g. '21.0.12.1' (Adoptium Temurin win-aarch64 zip; exposed as JAVA_HOME — a JDK, not a JRE: Gradle/Android and package:jni-style C++ builds need jni.h and jvm.lib)."
}

variable "jdk_sha256" {
  type        = string
  description = "SHA256 of the Adoptium Temurin win-aarch64 JDK zip for jdk_version."
}

variable "firefox_version" {
  type        = string
  description = "Firefox version, e.g. '155.0.1' (official win64-aarch64 installer)."
}

variable "firefox_sha256" {
  type        = string
  description = "SHA256 of Firefox Setup <firefox_version>.exe (win64-aarch64)."
}

variable "ninja_version" {
  type        = string
  description = "Ninja build tool version, e.g. '1.13.2' (choco package version)."
}

variable "wixtoolset_version" {
  type        = string
  description = "WiX Toolset version (choco package version)."
}

variable "protoc_version" {
  type        = string
  description = "protobuf compiler (protoc) version (choco package version)."
}

variable "nasm_version" {
  type        = string
  description = "NASM assembler version (choco package version)."
}

variable "llvm_version" {
  type        = string
  description = "LLVM version (choco package version)."
}

variable "vim_version" {
  type        = string
  description = "Vim version (choco package version)."
}

variable "nuget_version" {
  type        = string
  description = "NuGet command-line client version (choco package version)."
}

variable "mingw_version" {
  type        = string
  description = "MinGW-w64 GCC toolchain version (choco package version; provides make + mingw gcc)."
}

variable "make_version" {
  type        = string
  description = "GNU make version (choco package version)."
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

# --- WinRM credentials (baked into autounattend.xml — keep in sync) ---

variable "winrm_username" {
  type        = string
  default     = "Administrator"
  description = "User used for WinRM provisioning; must match the account autounattend.xml creates."
}

variable "winrm_password" {
  type        = string
  default     = "sandbox1"
  sensitive   = true
  description = "Password of the provisioning account; must match autounattend.xml."
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
  description = "OpenChamber desktop app version, e.g. \"1.22.0\" (win-arm64 NSIS installer from the GitHub releases)."
}

variable "openchamber_desktop_sha256" {
  type        = string
  description = "SHA256 of the OpenChamber-<version>-win-arm64.exe for openchamber_desktop_version."
}

# ---------------------------------------------------------------------------
# Source: VMware (Fusion on Apple Silicon, ARM64 guest)
# ---------------------------------------------------------------------------
#
# Windows 11 ARM64 runs natively on VMware Fusion on Apple Silicon — the
# most proven Windows-ARM path (Fusion ships the ARM64 guest drivers and
# tools). The recipe mirrors the reference implementation in
# gusztavvargadr/packer (src/windows/source.vmware.pkr.hcl +
# samples/windows-11/images.pkrvars.hcl, Unlicense), adapted to this repo's
# conventions:
#   - guest_os_type "arm-windows11-64", hardware version 20, NVMe disk,
#     vmxnet3 NIC under NAT, EFI firmware — the proven ARM64 combo,
#   - the unattend CD also carries the vmxnet3 ARM64 network driver
#     (drivers/staging/, staged by the build flow from Fusion's
#     Contents/Library/isoimages/arm64/drivers-arm64.zip). Without it there
#     is NO NIC in the guest and WinRM is unreachable from the host — the
#     driver must land before any network use (FirstLogonCommands order 1),
#   - VMware Tools ARM64 (the ISO Fusion bundles at
#     Contents/Library/isoimages/arm64/windows.iso) is attached by the
#     builder (tools_mode "attach"); autounattend.xml installs it at
#     first logon, before WinRM — the installer rebinds the NIC and
#     would kill a live WinRM session (observed as"dial tcp ... wsman:
#     operation timed out"). Tools
#     are what make vmrun's getGuestIPAddress work in the sandbox runner,
#   - NVMe storage needs no extra driver: Windows 11 ARM64 has the NVMe
#     driver in-box (unlike QEMU's virtio disk, which needs viostor in
#     WinPE).
#
# No snapshot is created (snapshot_name): the sandbox runner makes a full
# vmrun clone as its working VM, and a snapshot inside the published image
# would only complicate disk compaction and re-clones.

source "vmware-iso" "windows" {
  vm_name          = "sandbox-windows-${var.windows_version}-arm64-vmware"
  output_directory = "${var.build_dir}/output"

  # The build flow (agent-dev-env build) verifies the ISO
  # against var.iso_sha256 before Packer runs; iso_checksum is "none" so
  # Packer does not re-verify.
  iso_url      = var.iso_path
  iso_checksum = "none"

  cpus      = var.cpu_count
  memory    = var.memory_gb * 1024
  disk_size = var.disk_size * 1024

  # --- ARM64 guest wiring (proven in gusztavvargadr/packer) ---
  version              = 20
  guest_os_type        = "arm-windows11-64"
  disk_type_id         = "0"
  disk_adapter_type    = "nvme"
  network              = "nat"
  network_adapter_type = "vmxnet3"
  firmware             = "efi"
  cdrom_adapter_type   = "sata"

  # Unattend CD: Setup probes attached media for Autounattend.xml at the
  # root, so no keyboard input is needed for the answer file. The same CD
  # carries the staged vmxnet3 ARM64 driver flat in the root (see the
  # FirstLogonCommands driver scan in autounattend.xml). Note: glob the
  # staged files rather than passing the directory — the plugin copies
  # directory cd_files into a temp tree where nested paths break.
  cd_files = ["./autounattend.xml", "${var.build_dir}/drivers/staging/*"]
  cd_label = "UNATTEND"

  # VMware Tools ARM64 from the Fusion install (matching the host's Fusion
  # version — no download, no version pinning). Attached as a CD-ROM for
  # the whole build and removed on completion; autounattend.xml's
  # FirstLogonCommands installs it before WinRM comes up (the installer
  # rebinds the NIC and would kill a live WinRM session). Requires
  # Fusion 13.6+ (the plugin's minimum) and makes vmrun guest tooling
  # (getGuestIPAddress, shared folders) available at runtime.
  tools_mode        = "attach"
  tools_source_path = "${var.vmware_fusion_app_path}/Contents/Library/isoimages/arm64/windows.iso"

  vmx_data = {
    # The unattend/tools CD-ROMs ride on the SATA controller.
    "sata1.present" = "TRUE"
    # USB 3.x controller — Windows 11 ARM64 has in-box xHCI drivers; the
    # plugin auto-enables USB on Apple Silicon for its own VNC typer, and
    # keeping it present makes the USB input devices work in the guest.
    "usb_xhci.present" = "TRUE"
    # Boot the install CD before the (empty) NVMe disk, so the firmware
    # reaches the ISO's "Press any key to boot from CD" prompt as early
    # as possible.
    "bios.bootorder" = "cdrom,hdd"
  }

  # WinRM, not SSH: it comes up via autounattend's FirstLogonCommands
  # before any OpenSSH server exists, and DISM online servicing needs the
  # elevated token the provisioners request.
  communicator   = "winrm"
  winrm_username = var.winrm_username
  winrm_password = var.winrm_password
  winrm_timeout  = "90m"
  winrm_port     = 5985

  # Headless: no Fusion window, and the VNC server stays available for the
  # build watchdog (bundled watch-build.py) — pinned so the build flow
  # can start it before `packer build`. The vmware plugin's VNC
  # server is bound to 127.0.0.1; the password is disabled so the watchdog
  # (which assumes an unauthenticated VNC, like the QEMU plugin's) can
  # connect.
  headless = true

  vnc_bind_address     = "127.0.0.1"
  vnc_port_min         = 5901
  vnc_port_max         = 5901
  vnc_disable_password = true

  # The ISO's EFI "Press any key to boot from CD or DVD" prompt appears a
  # few seconds after power-on; Enter presses spread over ~25 s cover
  # early and late appearances without spamming keys into Setup like the
  # QEMU template does (no stray keys, no Cancel-dialog watch needed).
  # The build watchdog (bundled watch-build.py) also answers the prompt
  # and rescues a boot that lands in the EFI shell.
  boot_wait = "1s"
  boot_command = [
    "<enter><wait5><enter><wait5><enter><wait5><enter><wait5><enter><wait5><enter>",
  ]

  shutdown_command = "shutdown /s /t 10"
  shutdown_timeout = "10m"
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

build {
  sources = ["source.vmware-iso.windows"]

  # ===== Preamble: settle after OOBE, dump versions =====
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$os = Get-CimInstance Win32_OperatingSystem",
      "Write-Host \"Windows install complete: $($os.Caption) build $($os.BuildNumber) ($env:PROCESSOR_ARCHITECTURE)\"",
      "Write-Host 'Waiting 30s for post-OOBE first-logon scripts to settle...'",
      "Start-Sleep -Seconds 30",
    ]
  }

  # ===== VMware Tools =====
  # VMware Tools are installed by autounattend.xml's FirstLogonCommands
  # (order 2, BEFORE WinRM comes up) — the tools installer rebinds the
  # NIC and drops every live WinRM session mid-install, so a provisioner
  # here would kill its own connection (observed as a hard "dial tcp ...
  # wsman: operation timed out" failure). The tools are what make vmrun
  # getGuestIPAddress and HGFS shared folders work in the sandbox runner;
  # the build fails softly if the CD was not found.

  # ===== Chocolatey + .NET strong crypto =====
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [
      "$ErrorActionPreference = 'Stop'",
      "[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072",
      "iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))",
      "if ($LASTEXITCODE -ne 0) { throw \"chocolatey install failed: $LASTEXITCODE\" }",
      "$chocoInstall = [System.Environment]::GetEnvironmentVariable('ChocolateyInstall','Machine')",
      "if (-not $chocoInstall) { $chocoInstall = 'C:\\ProgramData\\chocolatey' }",
      "$chocoBin = Join-Path $chocoInstall 'bin'",
      "# Persist the Chocolatey bin dir into the machine PATH ourselves: the",
      "# bootstrapper's compiled Install-ChocolateyPath cmdlet asserts UAC",
      "# before writing and can fail to persist the registry value in the",
      "# elevated WinRM context (observed as 'choco' not recognized in the",
      "# toolchain phase after the reboot, even with PATH re-read).",
      "$machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')",
      "if (-not (($machinePath -split ';') -contains $chocoBin)) {",
      "  [System.Environment]::SetEnvironmentVariable('Path', $machinePath + ';' + $chocoBin, 'Machine')",
      "}",
      "# Run choco by its full path too — this session's PATH is not",
      "# guaranteed to contain the bin dir above.",
      "$choco = Join-Path $chocoBin 'choco.exe'",
      "if (-not (Test-Path $choco)) { throw \"choco.exe not found at $choco\" }",
      "& $choco feature enable -n allowGlobalConfirmation",
      "if ($LASTEXITCODE -ne 0) { throw \"choco feature enable failed: $LASTEXITCODE\" }",
      "# Legacy .NET strong-crypto: without it, older TLS stacks fail against modern hosts",
      "reg add 'HKLM\\SOFTWARE\\Microsoft\\.NETFramework\\v4.0.30319' /v SchUseStrongCrypto /t REG_DWORD /d 1 /f",
      "reg add 'HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\.NETFramework\\v4.0.30319' /v SchUseStrongCrypto /t REG_DWORD /d 1 /f",
    ]
  }

  # ===== Reboot: clear the tools-install pending reboot =====
  # The VMware Tools install (autounattend FirstLogonCommands) leaves a
  # pending reboot, which makes `choco install` return 3010 (seen on
  # python) and makes the .NET Framework 4.8 Developer Pack installer
  # fail with exit code 1 (it refuses to run while a reboot is pending).
  # Restart once and wait for WinRM, so the toolchain + VS phases run on
  # a cleanly booted machine.
  provisioner "windows-restart" {
    restart_timeout = "30m"
  }

  # ===== Toolchain via Chocolatey (versions from the vars file) =====
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      # Choco is called by its full path, never via PATH: the bootstrapper
      # can fail to persist the machine PATH (see the Chocolatey
      # provisioner), and after the tools reboot a fresh WinRM process can
      # inherit a stale PATH — both observed as 'choco' not recognized.
      # The PATH is still re-read from the registry below for the tools
      # this phase installs.
      $chocoInstall = [System.Environment]::GetEnvironmentVariable('ChocolateyInstall','Machine')
      if (-not $chocoInstall) { $chocoInstall = 'C:\ProgramData\chocolatey' }
      $choco = Join-Path (Join-Path $chocoInstall 'bin') 'choco.exe'
      if (-not (Test-Path $choco)) { throw "choco.exe not found at $choco (Chocolatey install failed?)" }
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      # choco downloads can 404 transiently over the VM's NAT (observed
      # with the pinned python package); retry each install before giving
      # up. The command goes through cmd /c so the package name and its
      # --version are parsed as separate arguments (passing $installArgs
      # straight to the exe makes choco look for a package literally named
      # 'nodejs --version=26.8.1'). No 2>&1 here: redirecting native
      # stderr under $ErrorActionPreference='Stop' turns any choco warning
      # into a terminating error in Windows PowerShell 5.1 (the repo's
      # documented native-stderr bug) — the output just streams to the
      # session log and $LASTEXITCODE decides the retry.
      function Invoke-ChocoRetry([string]$installArgs) {
        for ($try = 1; $try -le 3; $try++) {
          cmd /c "$choco install $installArgs -y"
          if ($LASTEXITCODE -eq 0) { return }
          Write-Host "choco install $installArgs attempt $try failed ($LASTEXITCODE); retrying"
          Start-Sleep -Seconds 15
        }
        throw "choco install $installArgs failed after 3 attempts"
      }
      # Official ARM64 downloads over the VM's NAT can drop mid-transfer;
      # retry, then verify the SHA256 when the caller pinned one (an empty
      # _sha256 means "no pin": the Chrome MSI lives on a live channel
      # with no versioned URL).
      function Download-Verified([string]$url, [string]$destFile, [string]$expected = '') {
        $downloaded = $false
        for ($try = 1; $try -le 3 -and -not $downloaded; $try++) {
          try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destFile -ErrorAction Stop
            $downloaded = $true
          } catch {
            Write-Host "download attempt $try failed ($url): $($_.Exception.Message)"
            if ($try -lt 3) { Start-Sleep -Seconds 10 }
          }
        }
        if (-not $downloaded) { throw "download failed after 3 attempts: $url" }
        if (-not $expected) {
          Write-Host "no pinned SHA256 for $url - skipping checksum"
          return
        }
        $actual = (Get-FileHash -Path $destFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
          throw "checksum mismatch for $url`n  expected $expected`n  got      $actual"
        }
      }
      # Installer temp files can stay locked after `&` returns (Inno/NSIS
      # bootstrappers spawn a child setup that holds the exe open; Defender
      # real-time scanning can also hold a handle on a freshly-run exe) —
      # retry the delete instead of aborting the build over a temp cleanup.
      function Remove-TempFile([string]$path) {
        for ($try = 1; $try -le 20; $try++) {
          try {
            Remove-Item -Force -Recurse -Path $path -ErrorAction Stop
            return
          } catch {
            if ($try -eq 20) { throw "could not remove $${path}: $($_.Exception.Message)" }
            Start-Sleep -Seconds 3
          }
        }
      }
      # Inno Setup installers can also *hand off* to an elevated child
      # (UAC split-token) and exit the stub early: `&` returns while the
      # child still runs and holds the installer exe open. Wait for the
      # process by name to disappear before the temp-file delete.
      function Wait-InstallerExited([string]$procName) {
        for ($try = 1; $try -le 150; $try++) {
          if (-not (Get-Process -Name $procName -ErrorAction SilentlyContinue)) {
            return
          }
          Start-Sleep -Seconds 2
        }
        throw "installer process '$procName' did not exit within 300s"
      }
      # Node.js — the official win-arm64 build (nodejs.org zip), not the
      # Chocolatey package: 'choco install nodejs' installs the x64 build,
      # which on this ARM64 guest runs under x64 emulation. Every npm
      # global (opencode-ai, pnpm/yarn, @openchamber/web, ...) then picks
      # x64 binaries and opencode's native session path crashes
      # intermittently (0xC0000005). The zip is hash-pinned and extracted
      # into the standard install location, so the rest of the toolchain
      # keeps using 'C:\Program Files\nodejs'.
      Download-Verified "https://nodejs.org/dist/v${var.nodejs_version}/node-v${var.nodejs_version}-win-arm64.zip" "$env:TEMP\node-arm64.zip" '${var.nodejs_sha256}'
      Expand-Archive -Path "$env:TEMP\node-arm64.zip" -DestinationPath "$env:TEMP\node-x" -Force
      New-Item -ItemType Directory -Force -Path 'C:\Program Files\nodejs' | Out-Null
      $srcNode = Get-ChildItem "$env:TEMP\node-x" -Directory | Select-Object -First 1
      if (-not $srcNode) { throw "Node.js zip extracted nothing" }
      Copy-Item -Path (Join-Path $srcNode.FullName '*') -Destination 'C:\Program Files\nodejs' -Recurse -Force
      Remove-TempFile "$env:TEMP\node-x"
      Remove-TempFile "$env:TEMP\node-arm64.zip"
      if (-not (Test-Path 'C:\Program Files\nodejs\node.exe')) { throw "node.exe not found after extraction" }
      # GitHub CLI — official win-arm64 zip (choco's gh package is x64).
      Download-Verified "https://github.com/cli/cli/releases/download/v${var.github_cli_version}/gh_${var.github_cli_version}_windows_arm64.zip" "$env:TEMP\gh.zip" '${var.github_cli_sha256}'
      Expand-Archive -Path "$env:TEMP\gh.zip" -DestinationPath "$env:TEMP\gh-x" -Force
      New-Item -ItemType Directory -Force -Path 'C:\Program Files\GitHub CLI' | Out-Null
      Copy-Item -Path "$env:TEMP\gh-x\bin\gh.exe" -Destination 'C:\Program Files\GitHub CLI\gh.exe' -Force
      Remove-TempFile "$env:TEMP\gh.zip"
      Remove-TempFile "$env:TEMP\gh-x"
      if (-not (Test-Path 'C:\Program Files\GitHub CLI\gh.exe')) { throw "gh.exe not found after extraction" }
      Invoke-ChocoRetry "ripgrep --version=${var.ripgrep_version}"
      # Git — official win-arm64 installer, Inno Setup silent (choco's git
      # package is x64; the ARM64 build is what makes git-lfs/ssh signing
      # work natively).
      $gitTag = 'v' + ('${var.git_version}' -replace '\.(\d+)$', '.windows.$1')
      Download-Verified "https://github.com/git-for-windows/git/releases/download/$gitTag/Git-${var.git_version}-arm64.exe" "$env:TEMP\git-arm64.exe" '${var.git_sha256}'
      & "$env:TEMP\git-arm64.exe" /VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES
      if ($LASTEXITCODE -ne 0) { throw "git installer failed: $LASTEXITCODE" }
      Wait-InstallerExited 'git-arm64'
      Remove-TempFile "$env:TEMP\git-arm64.exe"
      if (-not (Test-Path 'C:\Program Files\Git\cmd\git.exe')) { throw "git.exe not found after install" }
      Invoke-ChocoRetry "jq --version=${var.jq_version}"
      # Python — official win-arm64 installer (choco's python is x64):
      # without it venvs/pip would default to amd64 wheels on this guest.
      Download-Verified "https://www.python.org/ftp/python/${var.python_version}/python-${var.python_version}-arm64.exe" "$env:TEMP\python-arm64.exe" '${var.python_sha256}'
      & "$env:TEMP\python-arm64.exe" /quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_launcher=0 TargetDir=C:\Python313
      if ($LASTEXITCODE -ne 0) { throw "python installer failed: $LASTEXITCODE" }
      Wait-InstallerExited 'python-arm64'
      Remove-TempFile "$env:TEMP\python-arm64.exe"
      if (-not (Test-Path 'C:\Python313\python.exe')) { throw "python.exe not found after install" }
      # Firefox — official win-aarch64 installer (choco's firefox is x64).
      Download-Verified "https://download.mozilla.org/?product=firefox-${var.firefox_version}-SSL&os=win64-aarch64&lang=en-US" "$env:TEMP\firefox.exe" '${var.firefox_sha256}'
      & "$env:TEMP\firefox.exe" /S
      if ($LASTEXITCODE -ne 0) { throw "firefox installer failed: $LASTEXITCODE" }
      Wait-InstallerExited 'firefox'
      Remove-TempFile "$env:TEMP\firefox.exe"
      if (-not (Test-Path 'C:\Program Files\Mozilla Firefox\firefox.exe')) { throw "firefox.exe not found after install" }
      Invoke-ChocoRetry "curl"
      Invoke-ChocoRetry "docker-cli"
      Invoke-ChocoRetry "docker-compose"
      # C/C++ + cross-language toolchains (brought over from AdGuard's
      # build-agent-images windows2022-vs2022 / windows2022-go images).
      # VS2022 Build Tools (with its .NET/VC++ workloads) and Rust are
      # installed by their own provisioners below.
      # Go — official win-arm64 toolchain (choco's golang is x64): on an
      # ARM64 guest an x64 `go build` would default to amd64 output.
      Download-Verified "https://go.dev/dl/go${var.go_version}.windows-arm64.zip" "$env:TEMP\go-arm64.zip" '${var.go_sha256}'
      Expand-Archive -Path "$env:TEMP\go-arm64.zip" -DestinationPath "$env:TEMP\go-x" -Force
      Copy-Item -Path "$env:TEMP\go-x\go" -Destination 'C:\Program Files\' -Recurse -Force
      Remove-TempFile "$env:TEMP\go-arm64.zip"
      Remove-TempFile "$env:TEMP\go-x"
      if (-not (Test-Path 'C:\Program Files\go\bin\go.exe')) { throw "go.exe not found after extraction" }
      Invoke-ChocoRetry "mingw --version=${var.mingw_version}"
      Invoke-ChocoRetry "make --version=${var.make_version}"
      Invoke-ChocoRetry "vim --version=${var.vim_version}"
      Invoke-ChocoRetry "nuget.commandline --version=${var.nuget_version}"
      Invoke-ChocoRetry "protoc --version=${var.protoc_version}"
      Invoke-ChocoRetry "nasm --version=${var.nasm_version}"
      Invoke-ChocoRetry "llvm --version=${var.llvm_version}"
      Invoke-ChocoRetry "wixtoolset --version=${var.wixtoolset_version}"
      # Ninja (the CMake generator) — parity with the mac/Ubuntu
      # sandboxes and the AdGuard windows2022-vs2022 image. Git LFS needs
      # no choco package: Git for Windows ships the git-lfs binary
      # (filters are wired below), and a choco copy lands AFTER Git in
      # PATH and only shadows it.
      Invoke-ChocoRetry "ninja --version=${var.ninja_version}"

      # ===== Google Chrome (official Windows ARM64 MSI) =====
      # Chrome for Testing publishes no win-arm64 builds (its platform
      # list is linux64/mac-arm64/mac-x64/win32/win64), so the native
      # option is the enterprise ARM64 MSI. That URL is a live channel
      # with no versioned variant: the MSI rotates with every Chrome
      # release, so nothing can be pinned without vendoring it — install
      # whatever build the channel serves (the choco googlechrome package
      # was abandoned for the same reason; CfT is used wherever a
      # versioned arm64 archive exists).
      $chromeAppDir = 'C:\Program Files\Google\Chrome\Application'
      $chromeExe = Join-Path $chromeAppDir 'chrome.exe'
      Download-Verified "https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise_arm64.msi" "$env:TEMP\chrome-arm64.msi"
      $install = Start-Process msiexec -ArgumentList '/i', "$env:TEMP\chrome-arm64.msi", '/qn', '/norestart' -Wait -PassThru
      if ($install.ExitCode -notin 0, 3010) { throw "chrome MSI install failed: exit code $($install.ExitCode)" }
      Remove-TempFile "$env:TEMP\chrome-arm64.msi"
      # Register App Paths so `start chrome` / shell launchers resolve it
      $appPaths = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
      New-Item -Path $appPaths -Force | Out-Null
      New-ItemProperty -Path $appPaths -Name '(Default)' -Value $chromeExe -PropertyType String -Force | Out-Null
      if (-not (Test-Path $chromeExe)) { throw "chrome.exe not found after install" }
      $pyDir = 'C:\Python' + ('${var.python_version}' -replace '\.(\d+)\.(\d+)\.(\d+)', '$1$2')
      $toolPaths = @(
        'C:\Program Files\nodejs',
        'C:\Program Files\GitHub CLI',
        'C:\ProgramData\chocolatey\bin',
        'C:\Program Files\Git\cmd',
        'C:\Program Files\Git\bin',
        'C:\Program Files\Google\Chrome\Application',
        'C:\Program Files\Go\bin',
        'C:\Program Files\LLVM\bin',
        'C:\Program Files\NASM',
        "$pyDir",
        "$pyDir\Scripts",
        # WiX 3.14.x: newer package versions install the MSI under
        # 'Program Files\WiX Toolset v3.14\bin' (older ones put the
        # binaries in the choco lib) — add both, the guards skip absent.
        'C:\Program Files (x86)\WiX Toolset v3.14\bin',
        'C:\ProgramData\chocolatey\lib\wixtoolset\tools',
        'C:\mingw64\bin',
        "$env:APPDATA\npm"
      )
      $machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')
      # choco packages append their dirs with a trailing backslash (e.g.
      # 'C:\Program Files\nodejs\'), which the exact-match check above used
      # to double-append them — compare normalized (slash-less) entries.
      $machineEntries = @($machinePath -split ';' | ForEach-Object { $_.TrimEnd('\') })
      foreach ($toolPath in $toolPaths) {
        if ((Test-Path $toolPath) -and -not ($machineEntries -contains $toolPath.TrimEnd('\'))) {
          $machinePath = $machinePath + ';' + $toolPath
        }
      }
      [System.Environment]::SetEnvironmentVariable('Path', $machinePath, 'Machine')
      $env:Path = $machinePath + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      node --version
      git --version
      gh --version
      rg --version
      jq --version
      python --version
      go version
      # Conan — the C/C++ dependency manager (pairs with MSVC + CMake +
      # Ninja), current release via pip (from AdGuard's windows2022-vs2022
      # image, which installs it in a requirements.txt; ours is unpinned).
      python -m pip install conan
      if ($LASTEXITCODE -ne 0) { throw "pip conan failed: $LASTEXITCODE" }
      conan --version
      # Git LFS filters for the Administrator account (the sandbox login;
      # git-lfs is the binary bundled with Git for Windows)
      git lfs install
      if ($LASTEXITCODE -ne 0) { throw "git lfs install failed: $LASTEXITCODE" }
      git lfs version
      ninja --version
      END
    ]
  }

  # ===== Long paths + Developer Mode =====
  # Same settings as AdGuard's windows2022-flutter image. Node modules, pub
  # caches and generated code easily exceed MAX_PATH, and Windows 11 honors
  # LongPathsEnabled natively; Developer Mode lets non-elevated accounts
  # create the plugin/symlinks that package installers need.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      reg add 'HKLM\SYSTEM\CurrentControlSet\Control\FileSystem' /v LongPathsEnabled /t REG_DWORD /d 1 /f | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "reg add LongPathsEnabled failed: $LASTEXITCODE" }
      reg add 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "reg add AllowDevelopmentWithoutDevLicense failed: $LASTEXITCODE" }
      # Git's own companion switch: without it git truncates long paths even
      # when the OS setting allows them.
      git config --system core.longpaths true
      if ($LASTEXITCODE -ne 0) { throw "git config core.longpaths failed: $LASTEXITCODE" }
      Write-Host 'Long paths + Developer Mode enabled'
      END
    ]
  }

  # ===== JDK (Temurin) + JAVA_HOME =====
  # Same requirement as AdGuard's windows2022-flutter image: Gradle/Android
  # and package:jni-style C++ builds need a real JDK — a JRE ships jvm.dll
  # but no jni.h/jvm.lib. JAVA_HOME is set machine-wide and the JDK bin dir
  # goes on PATH so `java` works in any shell.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    timeout           = "30m"
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      $chocoInstall = [System.Environment]::GetEnvironmentVariable('ChocolateyInstall','Machine')
      if (-not $chocoInstall) { $chocoInstall = 'C:\ProgramData\chocolatey' }
      $choco = Join-Path (Join-Path $chocoInstall 'bin') 'choco.exe'
      if (-not (Test-Path $choco)) { throw "choco.exe not found at $choco (Chocolatey install failed?)" }
      # JDK — official Adoptium win-aarch64 zip, hash-pinned (choco's
      # temurin21 is x64; on this ARM64 guest the JVM would run emulated).
      function Download-Verified([string]$url, [string]$destFile, [string]$expected = '') {
        $downloaded = $false
        for ($try = 1; $try -le 3 -and -not $downloaded; $try++) {
          try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destFile -ErrorAction Stop
            $downloaded = $true
          } catch {
            Write-Host "download attempt $try failed ($url): $($_.Exception.Message)"
            if ($try -lt 3) { Start-Sleep -Seconds 10 }
          }
        }
        if (-not $downloaded) { throw "download failed after 3 attempts: $url" }
        if (-not $expected) {
          Write-Host "no pinned SHA256 for $url - skipping checksum"
          return
        }
        $actual = (Get-FileHash -Path $destFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
          throw "checksum mismatch for $url`n  expected $expected`n  got      $actual"
        }
      }
      function Remove-TempFile([string]$path) {
        for ($try = 1; $try -le 10; $try++) {
          try {
            Remove-Item -Force -Recurse -Path $path -ErrorAction Stop
            return
          } catch {
            if ($try -eq 10) { throw "could not remove $${path}: $($_.Exception.Message)" }
            Start-Sleep -Seconds 3
          }
        }
      }
      Download-Verified "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${var.jdk_version}%2B1/OpenJDK21U-jdk_aarch64_windows_hotspot_${var.jdk_version}_1.zip" "$env:TEMP\jdk.zip" '${var.jdk_sha256}'
      Expand-Archive -Path "$env:TEMP\jdk.zip" -DestinationPath "$env:TEMP\jdk-x" -Force
      $srcJdk = Get-ChildItem "$env:TEMP\jdk-x" -Directory | Select-Object -First 1
      if (-not $srcJdk) { throw "JDK zip extracted nothing" }
      New-Item -ItemType Directory -Force -Path 'C:\Program Files\Eclipse Adoptium' | Out-Null
      Copy-Item -Path $srcJdk.FullName -Destination "C:\Program Files\Eclipse Adoptium\jdk-${var.jdk_version}-hotspot" -Recurse -Force
      Remove-TempFile "$env:TEMP\jdk.zip"
      Remove-TempFile "$env:TEMP\jdk-x"
      $jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'jdk-*' } | Sort-Object Name -Descending | Select-Object -First 1
      if (-not $jdk) { throw 'JDK directory not found under C:\Program Files\Eclipse Adoptium' }
      [System.Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk.FullName, 'Machine')
      foreach ($f in 'include\jni.h', 'include\win32\jni_md.h', 'lib\jvm.lib') {
        if (-not (Test-Path (Join-Path $jdk.FullName $f))) { throw "$f is missing in $($jdk.FullName): the choco package installed a JRE instead of a JDK" }
      }
      $machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')
      $javaBin = Join-Path $jdk.FullName 'bin'
      if (-not (($machinePath -split ';') -contains $javaBin)) {
        [System.Environment]::SetEnvironmentVariable('Path', $machinePath + ';' + $javaBin, 'Machine')
      }
      # A WinRM shell's PATH is captured when the shell starts, so this
      # process does not see the registry update above (observed as
      # "The term 'java' is not recognized" right after JAVA_HOME was
      # set). Re-read the machine + user PATH, like the toolchain
      # provisioner does, so `java` resolves for the check below.
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      Write-Host "JAVA_HOME set to $($jdk.FullName)"
      java -version
      END
    ]
  }

  # ===== Visual Studio 2022 Build Tools (MSVC + .NET SDKs + CMake + Win11 SDK) =====
  # Brought over from AdGuard's build-agent-images windows2022-base-vs2022
  # image: the choco package installs the VS bootstrapper, then setup.exe
  # adds the .NET 4.8 + .NET Core SDKs, the VC++ workload (x86/x64/ARM/
  # ARM64 — ARM64 matters for this ARM64 guest) and the Windows 11 SDK.
  # On ARM64 the bootstrapper runs as an x86 binary under emulation, which
  # VS2022 supports.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    timeout           = "90m"
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      # Choco is called by its full path, never via PATH (see the
      # toolchain provisioner). The PATH is still re-read for the tools
      # this phase installs.
      $chocoInstall = [System.Environment]::GetEnvironmentVariable('ChocolateyInstall','Machine')
      if (-not $chocoInstall) { $chocoInstall = 'C:\ProgramData\chocolatey' }
      $choco = Join-Path (Join-Path $chocoInstall 'bin') 'choco.exe'
      if (-not (Test-Path $choco)) { throw "choco.exe not found at $choco (Chocolatey install failed?)" }
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      # Standalone .NET Framework 4.8 Developer Pack (latest), as in the
      # AdGuard image — MSBuild/.NET 4.8 targets need it. 3010 = success,
      # reboot required, which choco also returns for the KB dep.
      & $choco install netfx-4.8-devpack -y --norestart
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "choco netfx-4.8-devpack failed: $LASTEXITCODE" }
      & $choco install visualstudio2022buildtools --version=${var.vs_buildtools_version} -y --norestart --wait --nocache --noUpdateInstaller
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "choco visualstudio2022buildtools failed: $LASTEXITCODE" }
      $setup = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'
      if (-not (Test-Path $setup)) { throw "VS installer not found: $setup" }
      # .NET 4.8 SDK + .NET Core SDK workloads
      & $setup modify --quiet --norestart `
          --installPath 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools' `
          --add Microsoft.Net.Component.4.8.SDK `
          --add Microsoft.NetCore.Component.SDK `
          | Out-Host
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "vs .NET workloads failed: $LASTEXITCODE" }
      # VC++ workload (x86/x64/ARM/ARM64) + CMake project support + ATL
      # (ATL standard C++ component, as in AdGuard's windows2022-flutter
      # image — plain CMake/ATL projects expect it)
      & $setup modify --quiet --norestart `
          --installPath 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools' `
          --add Microsoft.VisualStudio.Workload.VCTools `
          --add Microsoft.VisualStudio.Component.VC.CMake.Project `
          --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
          --add Microsoft.VisualStudio.Component.VC.Tools.ARM `
          --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 `
          --add Microsoft.VisualStudio.Component.VC.ATL `
          | Out-Host
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "vs VC++ workloads failed: $LASTEXITCODE" }
      # Windows 11 SDK (the components the Win11 toolchain expects)
      & $setup modify --quiet --norestart `
          --installPath 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools' `
          --add Microsoft.VisualStudio.Component.Windows11SDK.22621 `
          | Out-Host
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "vs Windows11SDK failed: $LASTEXITCODE" }
      $vcPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build'
      $machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')
      if (-not (($machinePath -split ';') -contains $vcPath)) {
        [System.Environment]::SetEnvironmentVariable('Path', $machinePath + ';' + $vcPath, 'Machine')
      }
      Write-Host 'Visual Studio 2022 Build Tools + .NET SDKs installed'
      END
    ]
  }

  # ===== Rust via rustup (ARM64 host toolchain + MSVC cross targets) =====
  # Brought over from AdGuard's build-agent-images windows2022-vs2022
  # image, adapted for ARM64: win.rustup.rs/aarch64 ships the aarch64
  # rustup-init (win.rustup.rs/x86_64 is the x86_64 host only). The
  # default-toolchain is resolved by rustup (e.g. '1.95' -> 1.95.x), and
  # the MSVC targets cover x86_64/i686/aarch64 linking.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    timeout           = "30m"
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      $rustupInit = "$env:TEMP\rustup-init.exe"
      $downloaded = $false
      for ($try = 1; $try -le 3 -and -not $downloaded; $try++) {
        try {
          Invoke-WebRequest -UseBasicParsing -Uri 'https://win.rustup.rs/aarch64' -OutFile $rustupInit -ErrorAction Stop
          $downloaded = $true
        } catch {
          Write-Host "rustup-init download attempt $try failed: $($_.Exception.Message)"
          if ($try -lt 3) { Start-Sleep -Seconds 10 }
        }
      }
      if (-not $downloaded) { throw "rustup-init download failed after 3 attempts" }
      & $rustupInit -y --default-toolchain ${var.rust_version}
      if ($LASTEXITCODE -ne 0) { throw "rustup-init failed: $LASTEXITCODE" }
      Remove-Item $rustupInit -Force -ErrorAction SilentlyContinue
      $cargoBin = "$env:USERPROFILE\.cargo\bin"
      $machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')
      if (-not (($machinePath -split ';') -contains $cargoBin)) {
        [System.Environment]::SetEnvironmentVariable('Path', $machinePath + ';' + $cargoBin, 'Machine')
      }
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      rustup target add x86_64-pc-windows-msvc i686-pc-windows-msvc aarch64-pc-windows-msvc
      if ($LASTEXITCODE -ne 0) { throw "rustup target add failed: $LASTEXITCODE" }
      Write-Host "Rust ${var.rust_version} installed with MSVC targets"
      END
    ]
  }

  # ===== Visual Studio Code (native arm64, direct download) =====
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      $installer = "$env:TEMP\vscode-arm64-user-setup.exe"
      $downloaded = $false
      for ($try = 1; $try -le 3 -and -not $downloaded; $try++) {
        try {
          Invoke-WebRequest -UseBasicParsing -Uri 'https://update.code.visualstudio.com/latest/win32-arm64-user/stable' -OutFile $installer -ErrorAction Stop
          $downloaded = $true
        } catch {
          Write-Host "vscode download attempt $try failed: $($_.Exception.Message)"
          if ($try -lt 3) { Start-Sleep -Seconds 10 }
        }
      }
      if (-not $downloaded) { throw "vscode download failed after 3 attempts" }
      Start-Process $installer -ArgumentList '/VERYSILENT /NORESTART /MERGETASKS=!runcode' -Wait
      Remove-Item $installer -Force -ErrorAction SilentlyContinue
      $codeBin = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"
      if (Test-Path $codeBin) {
        $machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')
        if (-not (($machinePath -split ';') -contains $codeBin)) {
          [System.Environment]::SetEnvironmentVariable('Path', $machinePath + ';' + $codeBin, 'Machine')
        }
      }
      END
    ]
  }

  # ===== OpenCode, OpenCodeReview, OpenChamber web UI =====
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      # EAP=Continue, not Stop: this script runs many native commands
      # (schtasks, npm, openchamber) whose stderr lines become terminating
      # errors under Stop in Windows PowerShell 5.1 (the 2>$null / 2>&1
      # native-stderr bug). All failure handling is explicit below.
      $ErrorActionPreference = 'Continue'
      $ProgressPreference = 'SilentlyContinue'
      # The image ships with Windows' default Restricted execution policy —
      # every build-time powershell invocation passes -ExecutionPolicy
      # Bypass, so nothing is persisted. But opencode/ocr are npm shims
      # (opencode.ps1 in %APPDATA%\npm): a Restricted shell refuses to run
      # them ("running scripts is disabled on this system"). Bake in
      # RemoteSigned machine-wide (this provisioner runs elevated, so the
      # LocalMachine scope persists in the image) and keep the runners'
      # runtime set as a fallback for images built before this change.
      # The build passes -ExecutionPolicy Bypass at Process scope, so
      # setting only LocalMachine triggers Set-ExecutionPolicy's "overridden
      # by a more specific scope" notice, which Windows PowerShell 5.1 under
      # WinRM surfaces as a terminating error that aborts the build even
      # though the machine policy was updated fine (observed). Set the
      # Process scope first (no override, no notice), then the machine.
      try {
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force -ErrorAction SilentlyContinue
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine -Force -ErrorAction SilentlyContinue
      } catch {
        Write-Warning "Set-ExecutionPolicy failed: $($_.Exception.Message)"
      }
      Write-Host "PowerShell execution policy: $(Get-ExecutionPolicy -Scope LocalMachine)"
      $machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')
      $env:Path = $machinePath + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      # The openchamber scheduled task launches at logon and locks its
      # node_modules — kill it before reinstalling, and retry npm installs
      # (the guest's NAT networking drops large transfers).
      try { schtasks /End /TN dev.openchamber.web 2>&1 | Out-Null } catch {}
      Stop-Process -Name node -Force -ErrorAction SilentlyContinue
      function Invoke-NpmRetry([string]$argsLine) {
        for ($try = 1; $try -le 3; $try++) {
          cmd /c "npm $argsLine" 2>&1 | Out-Null
          if ($LASTEXITCODE -eq 0) { return }
          Write-Host "npm $argsLine attempt $try failed ($LASTEXITCODE); retrying"
          Start-Sleep -Seconds 10
        }
        throw "npm $argsLine failed after 3 attempts"
      }
      Invoke-NpmRetry "install -g opencode-ai"
      # Package managers for frontend/Node projects — parity with the
      # mac/Ubuntu sandboxes (npm globals in %APPDATA%\npm, already on the
      # machine PATH through the toolchain provisioner's $toolPaths).
      Invoke-NpmRetry "install -g pnpm yarn"
      New-Item -ItemType Directory -Force -Path C:\npm-global | Out-Null
      Invoke-NpmRetry "install -g --prefix C:\npm-global --ignore-scripts @alibaba-group/open-code-review@${var.open_code_review_version}"
      foreach ($toolPath in @('C:\npm-global')) {
        if ((Test-Path $toolPath) -and -not (($machinePath -split ';') -contains $toolPath)) {
          $machinePath = $machinePath + ';' + $toolPath
        }
      }
      [System.Environment]::SetEnvironmentVariable('Path', $machinePath, 'Machine')
      Invoke-NpmRetry "install -g @openchamber/web"
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      opencode --version
      ocr --version
      # Web UI as a native service (Windows: scheduled task). Snapshot the
      # absolute opencode path like the macOS template does.
      $opencodeBin = (Get-Command opencode -ErrorAction Stop).Source
      $env:OPENCODE_BINARY = $opencodeBin
      # openchamber's own `startup enable` writes startup.env but then fails
      # to register the task — its schtasks /TR command exceeds the 261-char
      # limit and the failure aborts the whole provisioner. So: let it write
      # the env file, ignore the failure, and register a compact task that
      # runs a small wrapper script instead of a giant inline command.
      try {
        openchamber startup enable --port ${var.openchamber_port} --lan --ui-password "${var.openchamber_ui_password}" 2>$null | Out-Null
      } catch {}
      $LASTEXITCODE = 0
      $envFile = 'C:\Users\Administrator\.config\openchamber\startup.env'
      if (-not (Test-Path $envFile)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $envFile) | Out-Null
        @"
OPENCHAMBER_UI_PASSWORD='${var.openchamber_ui_password}'
OPENCODE_BINARY='$opencodeBin'
"@ | Set-Content -Path $envFile -Encoding UTF8
      }
      New-Item -ItemType Directory -Force -Path C:\tools | Out-Null
      $wrapper = @'
$envFile = 'C:\Users\Administrator\.config\openchamber\startup.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
      $v = $matches[2]
      if ($v.StartsWith("'") -and $v.EndsWith("'")) {
        $v = $v.Substring(1, $v.Length - 2).Replace("'\''", "'")
      }
      [Environment]::SetEnvironmentVariable($matches[1], $v, 'Process')
    }
  }
}
# npm globals land next to the extracted node.exe (the node zip's
      # default global prefix is its own dir, not %APPDATA%\npm), so the
      # cli.js path must follow the shim, never a hardcoded install dir.
      $openChamberShim = (Get-Command openchamber -ErrorAction SilentlyContinue).Source
      if (-not $openChamberShim) { throw 'openchamber shim not found on PATH' }
      & $openChamberShim serve --foreground --port ${var.openchamber_port} --host 0.0.0.0
'@
      Set-Content -Path C:\tools\openchamber-startup.ps1 -Value $wrapper -Encoding UTF8
      # Register the logon task. schtasks.exe from the elevated WinRM
      # session can be flaky (silent /Create failures, /Run "file not
      # found"); fall back to the PowerShell-native Register-ScheduledTask
      # (same mechanism the build-agent-images repo uses). Never fail the
      # build here — worst case the web UI starts at first login.
      $taskRegistered = $false
      try {
        schtasks /Create /TN dev.openchamber.web /SC ONLOGON /RL LIMITED /F /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\tools\openchamber-startup.ps1" 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
          schtasks /Run /TN dev.openchamber.web 2>&1 | Out-Null
          if ($LASTEXITCODE -eq 0) { $taskRegistered = $true }
        }
        $LASTEXITCODE = 0
      } catch {
        Write-Warning "schtasks registration failed ($($_.Exception.Message)); trying Register-ScheduledTask"
        $LASTEXITCODE = 0
      }
      if (-not $taskRegistered) {
        try {
          $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\tools\openchamber-startup.ps1'
          $trigger = New-ScheduledTaskTrigger -AtLogOn
          Register-ScheduledTask -TaskName 'dev.openchamber.web' -Action $action -Trigger $trigger -Force | Out-Null
          Start-ScheduledTask -TaskName 'dev.openchamber.web'
          $taskRegistered = $true
        } catch {
          Write-Warning "Register-ScheduledTask also failed: $($_.Exception.Message); the web UI will start at first login instead"
          $LASTEXITCODE = 0
        }
      }
      if ($taskRegistered) { Write-Host "OpenChamber task registered: $taskRegistered" }
      # Windows' firewall "TCP/UDP Query User" rules for node.exe default to
      # BLOCK when the allow prompt goes unanswered (headless build) — the
      # web UI then only answers on the guest loopback. Remove them and
      # allow the UI port explicitly so the host can reach it.
      Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like '*Query User*node.exe*' } |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
      New-NetFirewallRule -DisplayName 'OpenChamber' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${var.openchamber_port} -Profile Any -ErrorAction SilentlyContinue | Out-Null
      # openchamber's startup-enable provisions an UNPINNED
      # @alibaba-group/open-code-review at the default npm prefix (it gets
      # shadowed on PATH by the pinned C:\npm-global copy, but `npm ls -g`
      # then reports a non-pinned version). Remove it and re-assert the
      # pinned copy is what `ocr` resolves to — a rebuild must not ship an
      # ocr that is not the pinned version.
      npm uninstall -g @alibaba-group/open-code-review 2>$null
      if ($LASTEXITCODE -ne 0) { Write-Warning "open-code-review cleanup failed: $LASTEXITCODE" }
      $LASTEXITCODE = 0
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
      $ocrBin = (Get-Command ocr -ErrorAction SilentlyContinue).Source
      if (-not ($ocrBin -like 'C:\npm-global*')) { throw "ocr resolved to '$ocrBin' instead of the pinned C:\npm-global copy" }
      $ocrVersion = & ocr --version 2>$null | Select-Object -First 1
      if ($ocrVersion -notmatch "v${var.open_code_review_version}") {
        throw "ocr is '$ocrVersion' - expected the pinned v${var.open_code_review_version}"
      }
      Write-Host "ocr: $ocrVersion"
      $LASTEXITCODE = 0
      END
    ]
  }

  # ===== OpenChamber desktop app (win-arm64 NSIS installer) =====
  # Parity with the mac cask and the Ubuntu AppImage: the desktop app for
  # the guest desktop, hash-pinned from the GitHub releases. The installer
  # is electron-builder NSIS: /S silent, per-user install by default (the
  # sandbox account is the installing account); the Start Menu shortcut is
  # created by the installer itself.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    timeout           = "30m"
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      $installer = "$env:TEMP\openchamber-setup.exe"
      $url = "https://github.com/openchamber/openchamber/releases/download/v${var.openchamber_desktop_version}/OpenChamber-${var.openchamber_desktop_version}-win-arm64.exe"
      $downloaded = $false
      for ($try = 1; $try -le 3 -and -not $downloaded; $try++) {
        try {
          Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $installer -ErrorAction Stop
          $downloaded = $true
        } catch {
          Write-Host "openchamber desktop download attempt $try failed: $($_.Exception.Message)"
          if ($try -lt 3) { Start-Sleep -Seconds 10 }
        }
      }
      if (-not $downloaded) { throw "openchamber desktop download failed after 3 attempts" }
      $actual = (Get-FileHash -Path $installer -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne '${var.openchamber_desktop_sha256}') {
        throw "openchamber desktop checksum mismatch: expected ${var.openchamber_desktop_sha256}, got $actual"
      }
      # The NSIS win-arm64 installer can crash with 0xC0000005 (access
      # violation) on one attempt and succeed on the next (observed during
      # a rebuild) — retry the install, like the downloads above.
      $installOk = $false
      for ($try = 1; $try -le 3 -and -not $installOk; $try++) {
        $installerProc = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
        if ($installerProc.ExitCode -in 0, 3010) { $installOk = $true; break }
        Write-Host "openchamber desktop install attempt $try exited with code $($installerProc.ExitCode); retrying"
        if ($try -lt 3) { Start-Sleep -Seconds 10 }
      }
      if (-not $installOk) { throw "openchamber desktop installer exited with code $($installerProc.ExitCode)" }
      Remove-Item $installer -Force -ErrorAction SilentlyContinue
      # The electron-builder NSIS install dir is derived from the npm
      # package name, not productName (observed 2026-09-03: 1.22.0 installed
      # to "%LOCALAPPDATA%\Programs\@openchamberelectron" because the package
      # is "@openchamber/electron") — never hardcode it. Search every
      # standard per-user / per-machine install root for OpenChamber.exe,
      # then fall back to the uninstall registry InstallLocation.
      # Start-Process -Wait can return while the NSIS child still writes the
      # app files (observed 2026-09-04: the checksum passed and the search
      # still came up empty) — poll briefly, then give up with diagnostics.
      $roots = @()
      foreach ($u in @("$env:LOCALAPPDATA\Programs", "$env:USERPROFILE\AppData\Local\Programs", 'C:\Program Files', 'C:\Program Files (x86)')) {
        if ($u -and (Test-Path $u)) { $roots += $u }
      }
      $roots += Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'AppData\Local\Programs' } |
        Where-Object { (Test-Path $_) -and -not ($roots -contains $_) }
      $exe = $null
      for ($try = 0; $try -lt 10 -and -not $exe; $try++) {
        if ($try -gt 0) { Start-Sleep -Seconds 2 }
        foreach ($root in $roots) {
          $exe = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'openchamber' } |
            ForEach-Object { Get-ChildItem $_.FullName -Filter 'OpenChamber.exe' -Recurse -ErrorAction SilentlyContinue } |
            Select-Object -First 1
          if ($exe) { break }
        }
      }
      if (-not $exe) {
        foreach ($regKey in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
          $entry = Get-ChildItem $regKey -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
            Where-Object { $_.DisplayName -like '*OpenChamber*' -and $_.InstallLocation } |
            Select-Object -First 1
          if ($entry) {
            $exe = Get-ChildItem $entry.InstallLocation -Filter 'OpenChamber.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($exe) { break }
          }
        }
      }
      if (-not $exe) { throw "OpenChamber desktop exe not found after install (searched: $($roots -join '; '))" }
      Write-Host "OpenChamber desktop installed at $($exe.FullName)"
      END
    ]
  }

  # ===== OpenSSH Server + RDP =====
  # sshd gives the host a management channel (agent-dev-env run windows-vmware
  # connects to the guest's NAT IP on port 22); RDP gives a desktop session.
  # Password auth is enabled for the Administrator account so the fixed
  # sandbox credentials from the vars file work.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      # Note: Add-WindowsCapability is a cmdlet — it does NOT set
      # $LASTEXITCODE (a stale $null made the old `if ($LASTEXITCODE -ne 0)`
      # check false-fire and abort the build even on success). Failures
      # surface as terminating errors via -ErrorAction Stop instead.
      Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction Stop
      Set-Service -Name sshd -StartupType Automatic
      $cfg = 'C:\ProgramData\ssh\sshd_config'
      if (Test-Path $cfg) {
        (Get-Content $cfg) -replace '#PasswordAuthentication yes','PasswordAuthentication yes' `
          -replace 'Match Group administrators','#Match Group administrators' `
          -replace '       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys','#       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys' `
          | Set-Content $cfg
      }
      # PowerShell as the default SSH shell
      New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
      New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
      Start-Service sshd
      # RDP
      Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
      Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'
      END
    ]
  }

  # ===== Bridge tooling: socat + npiperelay (best-effort) =====
  # Used by the SSH-agent bridge on the host side of the sandbox runner
  # (see docs/windows-vmware.md). Not load-bearing for the image itself, so
  # a download failure only warns.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      try {
        New-Item -ItemType Directory -Force -Path C:\tools | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/jstarks/npiperelay/releases/download/v0.1.0/npiperelay_windows_amd64.zip' -OutFile "$env:TEMP\npiperelay.zip"
        Expand-Archive "$env:TEMP\npiperelay.zip" -DestinationPath C:\tools -Force
        Remove-Item "$env:TEMP\npiperelay.zip" -Force
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/valorisa/socat-1.8.0.1_for_Windows/raw/main/socat.exe' -OutFile 'C:\tools\socat.exe'
        $machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine').TrimEnd(';')
        if (-not (($machinePath -split ';') -contains 'C:\tools')) {
          [System.Environment]::SetEnvironmentVariable('Path', $machinePath + ';C:\tools', 'Machine')
        }
        Write-Host 'Bridge tooling installed: C:\tools\npiperelay.exe, C:\tools\socat.exe'
      } catch {
        Write-Warning "Bridge tooling install failed (bridges will be unavailable): $($_.Exception.Message)"
      }
      END
    ]
  }

  # ===== Performance & privacy hardening =====
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      # --- Disable Defender realtime scanning (speed + flakiness) ---
      Set-MpPreference -DisableRealtimeMonitoring $true
      reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows Defender' /v DisableAntiSpyware /t REG_DWORD /d 1 /f
      # --- Disable heavyweight / telemetry services ---
      $disableServices = @(
        'WSearch',       # Windows Search indexer
        'SysMain',       # Superfetch
        'DiagTrack',     # Diagnostics Tracking (telemetry)
        'dmwappushservice',
        'MapsBroker',    # Downloaded Maps Manager
        'lfsvc',         # Geolocation
        'RetailDemo',
        'wisvc'          # Windows Insider
      )
      foreach ($svc in $disableServices) {
        $s = Get-Service $svc -ErrorAction SilentlyContinue
        if ($s) {
          Stop-Service $svc -Force -ErrorAction SilentlyContinue
          Set-Service $svc -StartupType Disabled -ErrorAction SilentlyContinue
        }
      }
      # --- Scheduled telemetry tasks ---
      @(
        '\\Microsoft\\Windows\\Application Experience\\',
        '\\Microsoft\\Windows\\Customer Experience Improvement Program\\'
      ) | ForEach-Object {
        Get-ScheduledTask -TaskPath $_ -ErrorAction SilentlyContinue | Disable-ScheduledTask -ErrorAction SilentlyContinue | Out-Null
      }
      # --- Filesystem + boot + power ---
      fsutil behavior set disablelastaccess 1 | Out-Null
      fsutil behavior set disable8dot3 1 | Out-Null
      bcdedit /timeout 0 | Out-Null
      powercfg /h off | Out-Null
      Set-TimeZone -Id 'UTC'
      END
    ]
  }

  # ===== Final verification & cleanup =====
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      Write-Host '=== Versions ==='
      $os = Get-CimInstance Win32_OperatingSystem
      Write-Host "Windows: $($os.Caption) build $($os.BuildNumber)"
      Write-Host "PowerShell execution policy: $(Get-ExecutionPolicy -Scope LocalMachine)"
      node --version
      npm --version
      pnpm --version
      yarn --version
      python --version
      git --version
      git lfs version
      gh --version
      rg --version
      jq --version
      ninja --version
      conan --version
      java -version
      opencode --version
      ocr --version
      openchamber --version
      docker --version
      docker compose version
      # New toolchains: check-and-warn. A missing helper must never fail
      # the build — e.g. llvm-config is not shipped by every LLVM Windows
      # build, and choco packages do not shim every binary.
      $checkTools = @(
        @('go', 'version'),
        @('rustc', '--version'),
        @('cargo', '--version'),
        @('protoc', '--version'),
        @('nasm', '--version'),
        @('clang', '--version'),
        @('x86_64-w64-mingw32-gcc', '--version')
      )
      foreach ($tool in $checkTools) {
        $cmd = Get-Command $tool[0] -ErrorAction SilentlyContinue
        if ($cmd) {
          & $cmd.Source $tool[1]
          if ($LASTEXITCODE -ne 0) { Write-Warning "$($tool[0]) --version failed ($LASTEXITCODE)" }
        } else {
          Write-Warning "$($tool[0]) not found on PATH"
        }
      }
      if (Test-Path 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC') {
        Write-Host "MSVC: $('C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC')"
      }
      # VMware Tools are load-bearing for the sandbox runner: vmrun
      # getGuestIPAddress (guest IP discovery) and HGFS shared folders
      # need the vmtoolsd service. The ARM64 tools MSI ships no VMCI
      # driver (Fusion's windows.iso carries vmxnet3 + vm3d +
      # vmusbmouse only), so the tools installer skips its own service
      # registration and a plain install lands with vmtoolsd.exe present
      # but no service (observed as the runner stuck at "Waiting for the
      # guest IP" for 15 min). Register it here, in the final
      # verification — NOT in autounattend.xml's FirstLogonCommands: a
      # longer tools CommandLine (service registration inline) broke
      # Windows Setup at first boot ("Windows could not complete the
      # installation", Pre-OOBE windeploy 0x80220005, build hung on
      # "Waiting for WinRM"), so the unattend command must stay small.
      # Fail hard when the service still did not come up — such an image
      # is not runnable, so a build that ships it must fail instead.
      $vmtoolsExe = 'C:\Program Files\VMware\VMware Tools\vmtoolsd.exe'
      $vmtoolsSvc = Get-Service 'VMware Tools' -ErrorAction SilentlyContinue
      if ((Test-Path $vmtoolsExe) -and -not $vmtoolsSvc) {
        Write-Host "Registering 'VMware Tools' service (ARM64 tools skip the VMCI driver)"
        New-Service -Name 'VMware Tools' -DisplayName 'VMware Tools' `
          -BinaryPathName "\"$vmtoolsExe\"" -StartupType Automatic | Out-Null
        $vmtoolsSvc = Get-Service 'VMware Tools' -ErrorAction SilentlyContinue
      }
      if ($vmtoolsSvc -and $vmtoolsSvc.Status -ne 'Running') {
        Start-Service 'VMware Tools' -ErrorAction SilentlyContinue
        $vmtoolsSvc = Get-Service 'VMware Tools' -ErrorAction SilentlyContinue
      }
      $vmtoolsd = Test-Path $vmtoolsExe
      if (-not $vmtoolsd -or -not $vmtoolsSvc -or $vmtoolsSvc.Status -ne 'Running') {
        # ASCII-only error message: non-ASCII characters in inline
        # PowerShell string literals are mangled in the WinRM transfer
        # (the em-dash came back as a smart quote, which closed the
        # string early and killed the whole script's parse).
        throw "VMware Tools are not fully installed - vmtoolsd.exe present: $vmtoolsd; 'VMware Tools' service: $($vmtoolsSvc). The sandbox runner needs the Tools service (vmrun getGuestIPAddress, HGFS); check the autounattend tools step."
      }
      Write-Host "VMware Tools: vmtoolsd.exe present, 'VMware Tools' service running ($($vmtoolsSvc.Status))"
      Write-Host "Chrome: $(Test-Path 'C:\Program Files\Google\Chrome\Application\chrome.exe')"
      Write-Host "Firefox: $(Test-Path 'C:\Program Files\Mozilla Firefox\firefox.exe')"
      Write-Host "VS Code: $(Test-Path "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd")"
      Write-Host "OpenChamber desktop: $(Test-Path "$env:LOCALAPPDATA\Programs\OpenChamber")"
      Write-Host "Long paths: $(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LongPathsEnabled)"
      # Cleanup — must never fail the build: choco cleanup can exit non-zero
      # (locked files etc.) and that $LASTEXITCODE would otherwise propagate
      # as the script's exit code even though everything succeeded. The
      # redirect happens inside cmd so PowerShell 5.1 never turns choco's
      # stderr into a terminating error under $ErrorActionPreference='Stop'.
      cmd /c "choco cleanup -y > NUL 2>&1"
      $LASTEXITCODE = 0
      Remove-Item -Path $env:TEMP\* -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host 'Windows sandbox image complete'
      END
    ]
  }

  # Image identity — the image records its own name/version inside the
  # guest (%USERPROFILE%\.config\agent-dev-env\image.json, the
  # green-field guest marker dir), so any clone of it can answer "which
  # image am I" without host-side provenance records. ASCII-only string
  # literals: non-ASCII is mangled in the WinRM transfer.
  provisioner "powershell" {
    elevated_user     = var.winrm_username
    elevated_password = var.winrm_password
    inline = [<<-END
      $ErrorActionPreference = 'Stop'
      $identityDir = Join-Path $env:USERPROFILE '.config\agent-dev-env'
      New-Item -ItemType Directory -Force -Path $identityDir | Out-Null
      $identity = @"
{
  "image": "sandbox-windows-${var.windows_version}-arm64-vmware",
  "image_version": "${var.image_version}",
  "platform": "windows-vmware",
  "windows_version": "${var.windows_version}"
}
"@
      Set-Content -Path (Join-Path $identityDir 'image.json') -Value $identity -Encoding Ascii
      Get-Content (Join-Path $identityDir 'image.json')
      END
    ]
  }
}
