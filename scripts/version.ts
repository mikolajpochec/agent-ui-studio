// Version of this skill and the update check against the latest GitHub release (cached for a day).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const REPO = "mikolajpochec/agent-ui-studio";
export const SKILL_ROOT = join(import.meta.dir, "..");
const CACHE_DIR = join(homedir(), ".cache", "ui-studio"); // not ~/.ui-studio: that holds only session folders
const CACHE = join(CACHE_DIR, "update-check.json");
const DAY = 24 * 60 * 60 * 1000;

export const version = (): string => {
  try { return readFileSync(join(SKILL_ROOT, "VERSION"), "utf8").trim(); } catch { return "0.0.0"; }
};

// -1, 0 or 1, comparing "1.2.3" style versions (a leading "v" is ignored).
export function compare(a: string, b: string) {
  const p = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export type Update = { current: string; latest: string; url: string } | null;

// Never slows a start by more than ~3s and never fails it; UI_STUDIO_NO_UPDATE_CHECK=1 turns it off.
export async function checkForUpdate(force = false): Promise<Update> {
  if (process.env.UI_STUDIO_NO_UPDATE_CHECK) return null;
  const current = version();
  let cache: any = null;
  try { cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch {}
  if (force || !cache || Date.now() - cache.checkedAt > DAY) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "ui-studio" },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const j: any = await r.json();
        cache = { checkedAt: Date.now(), latest: String(j.tag_name || "").replace(/^v/, ""), url: j.html_url };
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(CACHE, JSON.stringify(cache));
      }
    } catch {}
  }
  if (!cache?.latest || compare(cache.latest, current) <= 0) return null;
  return { current, latest: cache.latest, url: cache.url || `https://github.com/${REPO}/releases` };
}

export function clearUpdateCache() { try { writeFileSync(CACHE, "{}"); } catch {} }

// Changelog sections newer than `since`, for "what's new" after an update.
export function changesSince(since: string) {
  let text = "";
  try { text = readFileSync(join(SKILL_ROOT, "CHANGELOG.md"), "utf8"); } catch { return ""; }
  const out: string[] = [];
  for (const sec of text.split(/^(?=## )/m)) {
    const m = sec.match(/^## (\d+\.\d+\.\d+)/);
    if (m && compare(m[1], since) > 0) out.push(sec.trim());
  }
  return out.join("\n\n");
}


