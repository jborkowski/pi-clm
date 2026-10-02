class PiClmServer < Formula
  desc "Native MLX server for the CLM (Contrastive Language Model) classifier"
  homepage "https://github.com/jborkowski/pi-clm"

  # In-repo local tap: `make pack` snapshots the *current working tree* into this
  # tap as pi-clm-server-<version>-src.tar.gz, with <version> from `git describe`.
  # A local install therefore always builds the latest repo state (including
  # uncommitted edits). Without a packed tarball we build the repo's main branch,
  # which likewise tracks the latest changes.
  tap_path = begin
    Tap.fetch("jborkowski/pi-clm").path
  rescue LoadError, StandardError
    nil
  end

  local_tarball = tap_path&.glob("pi-clm-server-*-src.tar.gz")&.max_by(&:mtime)

  if local_tarball&.exist?
    url "file://#{local_tarball}"
    sha256 local_tarball.sha256
    version local_tarball.basename.to_s[/pi-clm-server-(.+)-src\.tar\.gz/, 1]
  else
    url "https://github.com/jborkowski/pi-clm.git", branch: "main"
    version "main"
  end

  # MLX/Metal require Apple Silicon; Swift build needs Xcode + Metal toolchain
  depends_on "git" => :build
  depends_on xcode: ["13.0", :build]
  depends_on arch: :arm64
  depends_on :macos

  # ---------------------------------------------------------------------------
  # Vendored SPM dependencies (mirrors native/clm-server/Package.resolved).
  # Every package is staged locally and Package.swift manifests are rewritten
  # to path-based dependencies, so the build never touches the network.
  # ---------------------------------------------------------------------------
  resource "mlx-swift" do
    url "https://github.com/ml-explore/mlx-swift.git", tag: "0.32.3"
  end

  resource "swift-transformers" do
    url "https://github.com/huggingface/swift-transformers.git", tag: "1.3.4"
  end

  resource "hummingbird" do
    url "https://github.com/hummingbird-project/hummingbird.git", tag: "2.27.0"
  end

  resource "async-http-client" do
    url "https://github.com/swift-server/async-http-client.git", tag: "1.36.2"
  end

  resource "eventsource" do
    url "https://github.com/mattt/EventSource.git", tag: "1.5.1"
  end

  resource "swift-algorithms" do
    url "https://github.com/apple/swift-algorithms.git", tag: "1.2.1"
  end

  resource "swift-asn1" do
    url "https://github.com/apple/swift-asn1.git", tag: "1.7.3"
  end

  resource "swift-async-algorithms" do
    url "https://github.com/apple/swift-async-algorithms.git", tag: "1.1.7"
  end

  resource "swift-atomics" do
    url "https://github.com/apple/swift-atomics.git", tag: "1.3.1"
  end

  resource "swift-certificates" do
    url "https://github.com/apple/swift-certificates.git", tag: "1.21.0"
  end

  resource "swift-collections" do
    url "https://github.com/apple/swift-collections.git", tag: "1.7.1"
  end

  resource "swift-configuration" do
    url "https://github.com/apple/swift-configuration.git", tag: "1.2.1"
  end

  resource "swift-crypto" do
    url "https://github.com/apple/swift-crypto.git", tag: "4.5.2"
  end

  resource "swift-distributed-tracing" do
    url "https://github.com/apple/swift-distributed-tracing.git", tag: "1.5.0"
  end

  resource "swift-http-structured-headers" do
    url "https://github.com/apple/swift-http-structured-headers.git", tag: "1.7.0"
  end

  resource "swift-http-types" do
    url "https://github.com/apple/swift-http-types.git", tag: "1.8.0"
  end

  resource "swift-huggingface" do
    url "https://github.com/huggingface/swift-huggingface.git", tag: "0.12.0"
  end

  resource "swift-jinja" do
    url "https://github.com/huggingface/swift-jinja.git", tag: "2.5.1"
  end

  resource "swift-log" do
    url "https://github.com/apple/swift-log.git", tag: "1.15.1"
  end

  resource "swift-metrics" do
    url "https://github.com/apple/swift-metrics.git", tag: "2.11.0"
  end

  resource "swift-nio" do
    url "https://github.com/apple/swift-nio.git", tag: "2.103.0"
  end

  resource "swift-nio-extras" do
    url "https://github.com/apple/swift-nio-extras.git", tag: "1.35.1"
  end

  resource "swift-nio-http2" do
    url "https://github.com/apple/swift-nio-http2.git", tag: "1.46.0"
  end

  resource "swift-nio-ssl" do
    url "https://github.com/apple/swift-nio-ssl.git", tag: "2.37.5"
  end

  resource "swift-nio-transport-services" do
    url "https://github.com/apple/swift-nio-transport-services.git", tag: "1.28.0"
  end

  resource "swift-numerics" do
    url "https://github.com/apple/swift-numerics.git", tag: "1.1.1"
  end

  resource "swift-service-context" do
    url "https://github.com/apple/swift-service-context.git", tag: "1.3.0"
  end

  resource "swift-service-lifecycle" do
    url "https://github.com/swift-server/swift-service-lifecycle.git", tag: "2.12.0"
  end

  resource "swift-system" do
    url "https://github.com/apple/swift-system.git", tag: "1.8.1"
  end

  resource "yyjson" do
    url "https://github.com/ibireme/yyjson.git", tag: "0.12.0"
  end

  # Maps SPM remote URLs to locally staged resource names so every
  # `.package(url: ...)` declaration can be rewritten to a path dependency.
  def spm_dep_urls
    {
      "https://github.com/ml-explore/mlx-swift"                 => "mlx-swift",
      "https://github.com/huggingface/swift-transformers"       => "swift-transformers",
      "https://github.com/hummingbird-project/hummingbird"      => "hummingbird",
      "https://github.com/swift-server/async-http-client"       => "async-http-client",
      "https://github.com/mattt/EventSource"                    => "eventsource",
      "https://github.com/apple/swift-algorithms"               => "swift-algorithms",
      "https://github.com/apple/swift-asn1"                     => "swift-asn1",
      "https://github.com/apple/swift-async-algorithms"         => "swift-async-algorithms",
      "https://github.com/apple/swift-atomics"                  => "swift-atomics",
      "https://github.com/apple/swift-certificates"             => "swift-certificates",
      "https://github.com/apple/swift-collections"              => "swift-collections",
      "https://github.com/apple/swift-configuration"            => "swift-configuration",
      "https://github.com/apple/swift-crypto"                   => "swift-crypto",
      "https://github.com/apple/swift-distributed-tracing"      => "swift-distributed-tracing",
      "https://github.com/apple/swift-http-structured-headers"  => "swift-http-structured-headers",
      "https://github.com/apple/swift-http-types"               => "swift-http-types",
      "https://github.com/huggingface/swift-huggingface"        => "swift-huggingface",
      "https://github.com/huggingface/swift-jinja"              => "swift-jinja",
      "https://github.com/apple/swift-log"                      => "swift-log",
      "https://github.com/apple/swift-metrics"                  => "swift-metrics",
      "https://github.com/apple/swift-nio"                      => "swift-nio",
      "https://github.com/apple/swift-nio-extras"               => "swift-nio-extras",
      "https://github.com/apple/swift-nio-http2"                => "swift-nio-http2",
      "https://github.com/apple/swift-nio-ssl"                  => "swift-nio-ssl",
      "https://github.com/apple/swift-nio-transport-services"   => "swift-nio-transport-services",
      "https://github.com/apple/swift-numerics"                 => "swift-numerics",
      "https://github.com/apple/swift-service-context"          => "swift-service-context",
      "https://github.com/swift-server/swift-service-lifecycle" => "swift-service-lifecycle",
      "https://github.com/apple/swift-system"                   => "swift-system",
      "https://github.com/ibireme/yyjson"                       => "yyjson",
    }
  end

  # Replace every `.package(url: "<known url>", ...)` with a local
  # `.package(path: ...)` so SwiftPM resolves fully offline.
  def rewrite_manifest(manifest, deps_root)
    rel = deps_root.relative_path_from(Pathname.new(manifest).dirname)
    content = File.read(manifest)
    spm_dep_urls.each do |url, name|
      escaped = Regexp.escape(url)
      # Match with or without a trailing ".git" and any version requirement
      # up to the manifest-statement closing paren. Requirements may contain
      # one level of nested parens (e.g. .upToNextMajor(from: "1.0.0")).
      content.gsub!(
        /\.package\(\s*url:\s*"#{escaped}(?:\.git)?"(?:\s*,\s*(?:\([^()]*\)|[^()])*)?\)/,
        ".package(path: \"#{rel}/#{name}\")",
      )
    end
    File.write(manifest, content)
  end

  def install
    # `make pack` wraps sources in build-src/; a plain git checkout does not.
    root = (buildpath/"build-src").directory? ? buildpath/"build-src" : buildpath

    deps_root = buildpath/"spm-deps"
    deps_root.mkpath
    resources.each do |r|
      r.stage(deps_root/r.name)
    end

    # Rewrite the root manifest and every vendored dependency's manifest (the
    # staged deps live in buildpath/spm-deps, outside `root`).
    manifests = Dir.glob(buildpath/"**/Package.swift")
                   .reject { |p| p.include?("/.build/") }
    manifests.each do |manifest|
      rewrite_manifest(manifest, deps_root)
    end

    cd root/"native/clm-server" do
      # Fully offline: all dependencies are local path packages.
      # --disable-sandbox turns off SwiftPM's *internal* sandbox-exec, which
      # cannot nest inside Homebrew's build sandbox ("sandbox_apply:
      # Operation not permitted"). Homebrew's own sandbox stays on; no
      # network is needed since all deps are vendored path packages.
      system "swift", "build", "-c", "release", "--product", "CLMServer",
             "--disable-sandbox"
      libexec.install ".build/release/CLMServer" => "clm-server"
      libexec.install Dir[".build/**/mlx-swift_Cmlx.bundle"].first => "mlx-swift_Cmlx.bundle"
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
