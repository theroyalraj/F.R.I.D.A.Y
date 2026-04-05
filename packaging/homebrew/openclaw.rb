# Homebrew Cask (example) — replace OWNER/repo and SHA256 after publishing release artifacts.
cask "openclaw" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/OWNER/openclaw/releases/download/v#{version}/OpenClaw_#{version}_aarch64.dmg",
      verified: "github.com/OWNER/openclaw/"
  name "OpenClaw"
  desc "Voice-forward local agent (Friday / OpenClaw)"
  homepage "https://github.com/OWNER/openclaw"

  app "OpenClaw.app"

  zap trash: [
    "~/.openclaw",
  ]
end
