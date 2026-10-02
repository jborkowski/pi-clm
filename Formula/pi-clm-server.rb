class PiClmServer < Formula
  desc "Native MLX server for the CLM (Contrastive Language Model) classifier"
  homepage "https://github.com/jborkowski/pi-clm"

  version "0.2.0"

  # Prebuilt distribution: binary tarball as the stable source URL, plus a
  # bottle so `brew install` pours the bottle instead of compiling Swift
  # (which would require the full Xcode Metal toolchain on this machine).
  # The repo is private; GitHub release assets require `gh auth` (gh CLI
  # authenticated as a collaborator) so curl can fetch them.
  url "https://github.com/jborkowski/pi-clm/releases/download/v#{version}/clm-server-#{version}-macos-arm64.tar.gz"
  sha256 "57332fe31ee25aa5ad45f6b57b56954bf7b20f7aa8d8f46befce948d52441469"

  bottle do
    root_url "https://github.com/jborkowski/pi-clm/releases/download/v#{version}"
    sha256 cellar: :any, arm64_tahoe: "93a025d5553db310fdc0067feb46cb38ef3efa8e2cf4b03cfb7f91579ebd561f"
  end

  # MLX/Metal require Apple Silicon
  depends_on arch: :arm64
  depends_on :macos

  def install
    # The MLX runtime loads the SwiftPM resource bundles from the executable's
    # own directory, so the real binary and all *.bundle live in libexec and a
    # thin wrapper is exposed on PATH.
    libexec.install "clm-server"
    libexec.install Dir["*.bundle"]
    (bin / "pi-clm-server").write <<~EOS
      #!/bin/bash
      exec "#{libexec}/clm-server" "$@"
    EOS
  end

  def caveats
    <<~EOS
      This formula pours a prebuilt bottle; no Xcode or Command Line Tools
      build is needed. Fetching release assets from the private repo requires
      an authenticated `gh` CLI (run `gh auth login` once).

      Use with the pi-clm Pi extension:
        export PI_CLM_SERVER_BIN=#{bin}/pi-clm-server

      Serve directly (model snapshot downloads to the HF hub cache on first use):
        pi-clm-server --port 8700 --model-path <model-snapshot-dir>
    EOS
  end

  test do
    assert_match(/--model-path is required/, shell_output("#{bin}/pi-clm-server 2>&1", 2))
  end
end
