# frozen_string_literal: true

# Homebrew formula for the CLM native MLX server.
#
# In-repo local-tap pattern: this repo is itself the tap (jborkowski/pi-clm).
# Builds from a `make pack` source tarball in the local tap, or from the
# tagged release cloned over SSH — no external tap, no release assets.
class PiClmServer < Formula
  desc "Native MLX server for the CLM (Contrastive Language Model) classifier"
  homepage "https://github.com/jborkowski/pi-clm"
  version "0.3.0"

  # Dual-source pattern (private-repo variant): prefer the source tarball that
  # `make pack` drops into the local tap, so an install builds the packed tree
  # with zero network access to this repo; otherwise build the tagged release
  # cloned over SSH. No bottles, no release assets, no external tap repos —
  # this repo is itself the tap (jborkowski/pi-clm).
  local_tarball = begin
    Tap.fetch("jborkowski/pi-clm").path/"pi-clm-server-src.tar.gz"
  rescue
    nil
  end

  if local_tarball&.exist?
    url "file://#{local_tarball}"
    sha256 local_tarball.sha256
  else
    # SSH, not HTTPS: Homebrew clones with the invoking user's git/SSH config,
    # so anyone with repo read access can build — no token, no release download.
    url "git@github.com:jborkowski/pi-clm.git",
        tag: "v#{version}"
  end

  # Swift 6 toolchain (swift-tools-version:6.0, macOS 15) plus the Metal
  # compiler: MLX's Metal kernels are an Xcode-only build step.
  depends_on xcode: ["16.0", :build]
  depends_on arch: :arm64
  depends_on :macos

  def install
    # `make pack` wraps sources in build-src/; a git checkout of the tag does not.
    root = (buildpath/"build-src").directory? ? buildpath/"build-src" : buildpath

    cd root/"native/clm-server" do
      # --disable-sandbox turns off SwiftPM's internal sandbox-exec, which
      # cannot nest inside Homebrew's build sandbox. SwiftPM resolves the
      # public SPM dependencies (mlx-swift, swift-transformers, hummingbird)
      # itself per Package.resolved.
      system "swift", "build", "-c", "release", "--product", "CLMServer",
             "--disable-sandbox"

      # SwiftPM never compiles MLX's Metal kernels (Xcode-only step), so the
      # server dies at MLX init with "Failed to load the default metallib"
      # unless we build mlx.metallib and ship it next to the binary (MLX's
      # first lookup path). Kernel sources are the files mlx-swift prepares
      # for Xcode builds in its Cmlx resource dir; the remaining kernels are
      # JIT-compiled from source embedded in the Cmlx target at runtime.
      # Flags mirror mlx's metal kernels CMakeLists.txt.
      metal_dir = ".build/checkouts/mlx-swift/Source/Cmlx/mlx-generated/metal"
      kernels = %w[
        arg_reduce conv dot layer_norm random rms_norm rope
        scaled_dot_product_attention searchsorted steel/attn/kernels/steel_attention
      ]
      air_dir = buildpath/"metal-air"
      air_dir.mkpath
      kernels.each do |kernel|
        system "xcrun", "-sdk", "macosx", "metal", "-x", "metal", "-fno-fast-math",
               "-Wno-c++17-extensions", "-Wno-c++20-extensions", "-Wmetal-addr-spaces",
               "-c", "#{metal_dir}/#{kernel}.metal", "-I", metal_dir,
               "-o", air_dir/"#{File.basename(kernel)}.air"
      end
      system "xcrun", "-sdk", "macosx", "metal", *Dir[air_dir/"*.air"],
             "-o", air_dir/"mlx.metallib"

      # The MLX runtime loads its resource bundles and mlx.metallib from the
      # executable's own directory, so the real binary, all *.bundle and
      # mlx.metallib live in libexec and a thin wrapper is exposed on PATH.
      # Plain `swift build` puts products under the triple dir (with a
      # .build/release convenience symlink); prefer the real dir when present.
      spmp = ".build/arm64-apple-macosx/release"
      release = File.exist?("#{spmp}/CLMServer") ? spmp : ".build/release"
      libexec.install "#{release}/CLMServer" => "clm-server"
      Dir["#{release}/*.bundle"].each { |bundle| libexec.install bundle }
      libexec.install air_dir/"mlx.metallib"
    end
    (bin/"pi-clm-server").write <<~EOS
      #!/bin/bash
      exec "#{libexec}/clm-server" "$@"
    EOS
  end

  service do
    run [opt_bin/"pi-clm-server", "--port", "8700", "--model-path", var/"pi-clm/model"]
    keep_alive true
    process_type :background
    log_path var/"log/pi-clm-server.log"
    error_log_path var/"log/pi-clm-server.err.log"
    environment_variables PATH: std_service_path_env,
                          HOME: Dir.home
  end

  def caveats
    <<~EOS
      Building from source requires full Xcode with the Metal toolchain:
        xcodebuild -downloadComponent MetalToolchain

      brew services runs the server against a model snapshot linked to
        $(brew --prefix)/var/pi-clm/model
      Set it up and start:
        mkdir -p "$(brew --prefix)/var/pi-clm"
        ln -sfn <model-snapshot-dir> "$(brew --prefix)/var/pi-clm/model"
        brew services start jborkowski/pi-clm/pi-clm-server

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
