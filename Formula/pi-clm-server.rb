class PiClmServer < Formula
  desc "Native MLX server for the CLM (Contrastive Language Model) classifier"
  homepage "https://github.com/jborkowski/pi-clm"

  version "0.2.1"

  # Prebuilt distribution: binary tarball as the stable source URL, plus a
  # bottle so `brew install` pours the bottle instead of compiling Swift
  # (which would require the full Xcode Metal toolchain on this machine).
  url "https://github.com/jborkowski/pi-clm/releases/download/v#{version}/clm-server-#{version}-macos-arm64.tar.gz"
  sha256 "ab3a9197bee8707a8b08aed083ffe67784557542800b44e3255fbed017532936"

  # Compute the release URL in class scope: the `bottle do ... end` block is
  # instance_eval'd against BottleSpecification, which has no `version`
  # method, so interpolating it inside the block makes the formula unloadable.
  bottle_root_url = "https://github.com/jborkowski/pi-clm/releases/download/v#{version}"
  bottle do
    root_url bottle_root_url
    sha256 cellar: :any, arm64_tahoe: "8c3503006e68a87d1085a4fbc4429cc0878708765d7d455ab725e4bf20f6e99e"
  end

  # MLX/Metal require Apple Silicon
  depends_on arch: :arm64
  depends_on :macos

  def install
    # The MLX runtime loads the SwiftPM resource bundles and its Metal kernels
    # (mlx.metallib) from the executable's own directory, so the real binary,
    # all *.bundle and mlx.metallib live in libexec and a thin wrapper is
    # exposed on PATH.
    binary = Dir["clm-server", "CLMServer"].first
    libexec.install binary => "clm-server"
    libexec.install Dir["*.bundle"]
    libexec.install "mlx.metallib"
    (bin / "pi-clm-server").write <<~EOS
      #!/bin/bash
      exec "#{libexec}/clm-server" "$@"
    EOS
  end

  def caveats
    <<~EOS
      This formula pours a prebuilt bottle; no Xcode or Command Line Tools
      build is needed.

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
