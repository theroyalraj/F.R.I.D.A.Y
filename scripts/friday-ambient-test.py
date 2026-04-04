#!/usr/bin/env python3
"""Quick smoke test for cricket/IPL ambient lines."""
import importlib.util, os, sys, random

os.environ["FRIDAY_AMBIENT"] = "true"
os.environ["PYTHONIOENCODING"] = "utf-8"
sys.stdout.reconfigure(encoding="utf-8")

spec = importlib.util.spec_from_file_location(
    "friday_ambient",
    os.path.join(os.path.dirname(__file__), "friday-ambient.py"),
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

r = mod.connect_redis()
mod._refresh_live_data(r)
print("IPL speech allowed:", mod._ipl_speech_on)

print("=" * 60)
print("LIVE CRICKET (combined: score + headline when configured)")
print("=" * 60)
combo = mod.fetch_cricket_combined(r)
print(combo or "(none — outside IPL window or no feeds)")
print()
print("English RSS headline:", mod.fetch_cricket_news() or "(none)")
print("Hindi RSS headline:", mod.fetch_cricket_news_hindi() or "(none)")

print()
print("=" * 60)
print("AI-GENERATED CRICKET LINE  (mode=cricket)")
print("=" * 60)
live = mod.get_live_data(r)
topic, line = mod.generate_line_ai(r, "cricket", None, None, live)
print("Topic:", topic)
print()
print(line)

print()
print("=" * 60)
print("FALLBACK TEMPLATES  (when no AI)")
print("=" * 60)
cl = live.get("cricket") or "Rizvi aces another tricky chase as Delhi Capitals floor Mumbai Indians"
wraps = [
    f"Just caught this on Cricinfo — {cl}. Should be an interesting one to watch.",
    f"There's some cricket news coming through, sir. {cl}. Worth keeping an eye on.",
    f"On the cricket front — {cl}. The IPL season never disappoints.",
    f"Quick cricket update for you — {cl}. Thought you'd want to know.",
    f"Right, so on the cricket side of things — {cl}. Exciting times.",
]
for i, w in enumerate(wraps, 1):
    print(f"  [{i}] {w}")
