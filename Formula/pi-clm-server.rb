class PiClmServer < Formula
  desc "Native MLX server for the CLM (Contrastive Language Model) classifier"
  homepage "https://github.com/jborkowski/pi-clm"
  url "https://github.com/jborkowski/pi-clm.git",
      tag: "v0.1.0", revision: "ccfe2d09b9c8f65d440e121f1955c8bcc935a41f"
  version "0.1.0"

  # MLX/Metal require Apple Silicon; Swift build needs Xcode + Metal toolchain
  depends_on arch: :arm64
  depends_on :macos
  depends_on :xcode => ["13.0", :build]

  def install
    cd "native/clm-server" do
      # SPM fetches dependencies at build time; brew's sandbox denies that,
      # hence the documented --no-sandbox.
      system "swift", "build", "-c", "release", "--product", "CLMServer"
      libexec.install ".build/out/Products/Release/CLMServer" => "clm-server"
      libexec.install ".build/out/Products/Release/mlx-swift_Cmlx.bundle"
    end
    # The MLX runtime loads mlx-swift_Cmlx.bundle from the executable's own
    # directory, so the real binary lives in libexec behind a wrapper.
    (bin / "pi-clm-server").write <<~EOS
      #!/bin/bash
      exec "#{libexec}/clm-server" "$@"
    EOS
  end

  def caveats
    <<~EOS
      Requires the Metal toolchain once per Xcode:
        xcodebuild -downloadComponent MetalToolchain

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
