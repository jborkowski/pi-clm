class PiClmServer < Formula
  desc "Native MLX server for the CLM (Contrastive Language Model) classifier"
  homepage "https://github.com/jborkowski/pi-clm"
  url "https://github.com/jborkowski/pi-clm/releases/download/v__VERSION__/clm-server-__VERSION__-macos-arm64.tar.gz"
  sha256 "__SHA256__"
  version "__VERSION__"

  # MLX/Metal require Apple Silicon
  depends_on arch: :arm64
  depends_on :macos

  def install
    libexec.install "clm-server", "mlx-swift_Cmlx.bundle"
    # The MLX runtime loads mlx-swift_Cmlx.bundle from the executable's own
    # directory, so keep the real binary in libexec and expose a wrapper.
    (bin / "pi-clm-server").write <<~EOS
      #!/bin/bash
      exec "#{libexec}/clm-server" "$@"
    EOS
  end

  def caveats
    <<~EOS
      Use with the pi-clm Pi extension by pointing it at the brew-installed binary:

        export PI_CLM_SERVER_BIN=#{bin}/pi-clm-server

      The model snapshot (~8.6 GB) is downloaded automatically to the standard
      Hugging Face hub cache on first use, or serve it directly:

        pi-clm-server --port 8700 --model-path <model-snapshot-dir>
    EOS
  end

  test do
    assert_match(/--model-path is required/, shell_output("#{bin}/pi-clm-server 2>&1", 2))
  end
end
