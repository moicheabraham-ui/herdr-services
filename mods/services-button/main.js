import { View, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, focused, machines, readTextFile, run, setShared, shared, spaces, theme } from "herdr";
import { mkdir, readdir, unlink } from "fs/promises";

// The status-bar shortcut and the one fetcher of the Services dialog. It reads the dashboard the
// server serves (through the Herdr machine, so no port has to be open to this computer) and keeps
// the result in shared state for the dialog. When the focused terminal is a Claude Code
// conversation on the server, it works out which project folder that conversation is about and
// shows that project's service, linked. Everything about the server is set in
// mods/services/config.json.

const CONFIG = "mods/services/config.json";
const DEFAULTS = {
  machine: "", // the Herdr machine the services run on (`hc machine ls`); "" = the first one
  host: "", // the address links and icon lookups use; "" = ask the machine for its LAN address
  dashboardPort: 7500, // the port of the dashboard whose /api/services this mod reads
  devRoot: "Development", // the folder under the machine's home that holds your projects
  refreshSeconds: 10,
  demo: false, // sample data instead of a server, for screenshots
};
/** The settings in force: DEFAULTS, then config.json. Read again on every refresh. */
let cfg = { ...DEFAULTS };

const TICK_MS = 5 * 1000;
const KEY_DATA = "services.data";
const KEY_REFRESH = "services.refresh";
const KEY_CURRENT = "services.current";
const ICONS = "mods/services/icons";
const GLYPHS = new Set(["desktop", "network", "docker"]);
// How many of the newest project paths in the conversation decide, and how much of its end is read.
const MENTIONS = 80;
const TAIL_BYTES = 400000;

/** The Herdr machine the services run on, or null. */
const serverMachine = () => cfg.machine || machines().find((m) => m.name)?.name || null;

const dashboard = (path) => `http://127.0.0.1:${cfg.dashboardPort}${path}`;
const devPath = () => new RegExp(`/${cfg.devRoot}/([^/\\s]+)`);

/** Reads config.json over DEFAULTS. A missing file is fine; a broken one is reported. */
async function readConfig() {
  const text = await readTextFile(`${appHome()}/${CONFIG}`).catch(() => null);
  let user = {};
  let error = null;
  if (text !== null) {
    try {
      user = JSON.parse(text);
    } catch (e) {
      error = `config.json: ${String(e?.message ?? e)}`;
    }
  }
  const next = { ...DEFAULTS, ...user };
  // Each value goes into a command or a URL, so only plain spellings are accepted.
  if (!/^[\w.-]+$/.test(next.devRoot)) next.devRoot = DEFAULTS.devRoot;
  if (next.host !== "" && !/^[\w.:-]+$/.test(next.host)) next.host = DEFAULTS.host;
  if (!Number.isInteger(next.dashboardPort) || next.dashboardPort < 1 || next.dashboardPort > 65535) next.dashboardPort = DEFAULTS.dashboardPort;
  if (!(next.refreshSeconds >= 2)) next.refreshSeconds = DEFAULTS.refreshSeconds;
  cfg = next;
  return error;
}

// Prints the project paths in the end of the Claude Code conversation whose process is $1, oldest
// first. Claude keeps one transcript per session id.
const mentionsScript = () => `
id=$(sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions/$1.json" 2>/dev/null)
[ -n "$id" ] || exit 0
f=$(ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$id".jsonl 2>/dev/null | head -1)
[ -n "$f" ] || exit 0
tail -c ${TAIL_BYTES} "$f" | grep -o '/${cfg.devRoot}/[A-Za-z0-9._-]*' | tail -${MENTIONS}
`;

async function getJson(machine, path) {
  const r = await exec("curl", ["-sf", "-m", "6", dashboard(path)], { on: machine });
  if (r.code !== 0) throw new Error(`dashboard ${path}: curl exit ${r.code} (is it running on port ${cfg.dashboardPort}?)`);
  return JSON.parse(r.stdout);
}

const optional = (p) => p.catch(() => null);

function iconOf(s) {
  return GLYPHS.has(s.icon) ? { glyph: `${ICONS}/${s.icon}.svg` } : {};
}

/** Made-up services, so the mod can be shown and tried without a server. */
function demo() {
  const ip = cfg.host || "192.168.1.10";
  const at = (port) => [{ label: "Open", url: `http://${ip}:${port}` }];
  const dev = (name, port, status, desc) => ({
    key: `dev-${port}`, name, category: "Development", desc, port, status, links: at(port), project: name,
  });
  const app = (key, name, category, port, status, desc, extra = {}) => ({
    key, name, category, desc, port, status, links: port ? at(port) : [], project: null, ...extra,
  });
  return {
    at: Date.now(), ip, error: null, demo: true,
    items: [
      app("grafana", "Grafana", "Applications", 3000, "up", "Dashboards and alerts for the whole network"),
      app("nextcloud", "Nextcloud", "Applications", 8081, "up", "Files, calendar and contacts"),
      app("photos", "Photo Library", "Applications", 2283, "down", "Self-hosted photo backup"),
      app("llm", "Local LLM", "AI", 11434, "up", "Language-model runtime with an HTTP API"),
      app("chat", "Chat UI", "AI", 3002, "up", "Browser chat interface for the local models"),
      app("proxy", "Reverse Proxy", "Infrastructure", 80, "up", "Edge routing for local and public domains", { glyph: `${ICONS}/network.svg` }),
      app("docker", "Docker Engine", "Infrastructure", null, "up", "Container runtime", { glyph: `${ICONS}/docker.svg` }),
      app("vnc", "Remote Desktop", "Management", 5902, "up", "Graphical session on display :2", { glyph: `${ICONS}/desktop.svg` }),
      dev("web-shop", 3100, "up", "Reachable from the network · node · ~/Development/web-shop"),
      dev("billing-api", 3200, "up", "Reachable from the network · node · ~/Development/billing-api"),
      dev("admin-panel", 4000, "up", "Reachable from the network · vite · ~/Development/admin-panel"),
      dev("docs-site", 4321, "local", "Only reachable from this machine (bound to localhost). Start it with host 0.0.0.0"),
    ],
  };
}

async function load(machine) {
  if (cfg.demo) return demo();
  const [svc, dev, health, route] = await Promise.all([
    getJson(machine, "/api/services"),
    optional(getJson(machine, "/api/dev-services")),
    optional(getJson(machine, "/api/health")),
    cfg.host ? null : optional(exec("ip", ["-4", "route", "get", "1.1.1.1"], { on: machine })),
  ]);
  // The address links use: the configured one, else the server's own LAN address, asked every time
  // so links follow an IP change.
  const ip = cfg.host || /\bsrc (\d+\.\d+\.\d+\.\d+)/.exec(route?.stdout ?? "")?.[1] || "";
  const fix = (u) => (ip ? u.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost)/, `$1${ip}`) : u);
  const up = new Map((health ?? []).map((h) => [h.id, h.online]));
  const links = (s) => (s.urls ?? []).map((u) => ({ label: u.label, url: fix(u.url) }));
  const curated = svc.map((s) => ({
    key: s.id, name: s.name, category: s.category, desc: s.description, port: s.port ?? null,
    status: !up.has(s.id) ? "unknown" : up.get(s.id) ? "up" : "down", links: links(s), project: null, iconUrl: s.iconUrl ?? null, ...iconOf(s),
  }));
  const dev_ = (dev ?? []).map((s) => ({
    key: s.id, name: s.name, category: "Development", desc: s.description, port: s.port,
    status: s.loopbackOnly ? "local" : "up", links: links(s), project: s.name,
  }));
  return { at: Date.now(), ip, items: [...curated, ...dev_], error: null };
}

// ---- Icons: found on the service itself, once, and kept on disk. ----
const CACHE = "data/service-icons";
const RETRY_MS = 60 * 60 * 1000;
const HUNT_STALE_MS = 3 * 60 * 1000;
const TYPES = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
// The best format first: a vector or a large PNG beats a 16px .ico.
const RANK = { svg: 0, png: 1, webp: 2, jpg: 3, ico: 4 };
const GUESSES = ["/favicon.svg", "/apple-touch-icon.png", "/favicon.png", "/favicon.ico"];

const iconKey = (item) => (item.project ? `dev-${item.project}` : item.key).toLowerCase().replace(/[^a-z0-9._-]/g, "_");

/** Resolves an href found in a page against the page's address. */
function resolve(href, base) {
  if (/^https?:\/\//i.test(href)) return href;
  const m = /^(https?:)\/\/([^/]+)(\/[^?#]*)?/i.exec(base);
  if (!m) return null;
  if (href.startsWith("//")) return `${m[1]}${href}`;
  if (href.startsWith("/")) return `${m[1]}//${m[2]}${href}`;
  const dir = (m[3] ?? "/").replace(/[^/]*$/, "");
  return `${m[1]}//${m[2]}${dir}${href}`;
}

/** Downloads url into the cache when it is an image; returns the cached path or null. */
async function download(url, key) {
  const file = `${appHome()}/${CACHE}/${key}.tmp`;
  const r = await exec("curl", ["-sSL", "-m", "4", "--max-filesize", "600000", "-o", file, "-w", "%{http_code} %{content_type}", url]).catch(() => null);
  const [code, type] = (r?.stdout ?? "").trim().split(/\s+/);
  const ext = TYPES[(type ?? "").split(";")[0].toLowerCase()];
  if (r?.code !== 0 || code !== "200" || !ext) {
    await unlink(file).catch(() => {});
    return null;
  }
  const final = `${CACHE}/${key}.${ext}`;
  // Copied to its final name, since the format is only known once the download is over.
  const moved = await exec("curl", ["-s", `file:///${file.replace(/\\/g, "/")}`, "-o", `${appHome()}/${final}`]).catch(() => null);
  await unlink(file).catch(() => {});
  return moved?.code === 0 ? final : null;
}

/** The icon links a page declares, best first. */
async function declared(page) {
  const r = await exec("curl", ["-sSL", "-m", "4", "--max-filesize", "300000", page]).catch(() => null);
  const html = r?.code === 0 ? r.stdout : "";
  const found = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel=["'][^"']*icon[^"']*["']/i.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    const url = href && resolve(href, page);
    if (!url) continue;
    const ext = /\.(svg|png|webp|jpe?g|ico)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "ico";
    found.push([RANK[ext] ?? 5, url]);
  }
  return found.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

/** Looks for a service's icon: the dashboard's own file, what its page declares, then the usual places. */
async function findIcon(item, ip) {
  const key = iconKey(item);
  const pages = [];
  if (item.port && ip) pages.push(`http://${ip}:${item.port}/`);
  for (const l of item.links) if (/^https?:\/\//i.test(l.url)) pages.push(l.url);
  const urls = [];
  if (item.iconUrl && ip) urls.push(`http://${ip}:${cfg.dashboardPort}${item.iconUrl}`);
  for (const page of [...new Set(pages)]) {
    urls.push(...(await declared(page)));
    const origin = /^https?:\/\/[^/]+/i.exec(page)?.[0];
    if (origin) urls.push(...GUESSES.map((g) => origin + g));
  }
  for (const url of [...new Set(urls)]) {
    const found = await download(url, key);
    if (found) return found;
  }
  return null;
}

/** The project folder this terminal's conversation is about, or null. */
async function projectOf(terminal, projects, machine) {
  const info = JSON.parse((await exec("hc", ["get", terminal])).stdout);
  const inCwd = devPath().exec(info.foreground?.cwd ?? info.cwd ?? "")?.[1];
  if (inCwd) return inCwd;
  const pid = info.foreground?.pid;
  if (!pid || info.status?.app !== "claude-code") return null;
  const out = (await exec("sh", ["-c", mentionsScript(), "sh", String(pid)], { on: machine })).stdout;
  // The project named most often among the newest paths wins; the latest breaks a tie.
  const names = out.split("\n").map((l) => devPath().exec(l)?.[1]?.toLowerCase()).filter((n) => n && projects.has(n));
  const count = new Map();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const top = Math.max(0, ...count.values());
  const last = [...names].reverse().find((n) => count.get(n) === top);
  return top ? projects.get(last) : null;
}

/** The service of a project: its network-reachable dev port first, then the lowest port. */
function serviceOf(data, project) {
  if (!data || !project) return null;
  const p = project.toLowerCase();
  const hits = data.items.filter((i) => i.links.length && (i.project?.toLowerCase() === p
    || (!i.project && (i.key === p || p.includes(i.key) || i.name.toLowerCase().includes(p)))));
  const local = (i) => (i.status === "local" ? 1 : 0);
  return hits.sort((a, b) => local(a) - local(b) || (a.port ?? 0) - (b.port ?? 0))[0] ?? null;
}

const hue = (name, t) => {
  const palette = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
};

function badge(t, item) {
  const box = h_flex().flex_none().size(18).rounded(5).items_center().justify_center().bg(t.raised);
  if (item.logo) return box.child(image(item.logo).size(13));
  if (item.glyph) return box.child(svg(item.glyph).size(12).text_color(t.accent));
  return box.text_size(10.5).font_semibold().text_color(hue(item.name, t)).child(item.name.slice(0, 1).toUpperCase());
}

export default class ServicesButton extends View {
  init(_props, cx) {
    Object.assign(this, { busy: false, detecting: false, hunting: false, huntedAt: 0, terminal: null, project: null, loadedAt: 0, logos: new Map(), tried: new Map() });
    this.seen = shared(KEY_REFRESH) ?? 0;
    if (checking()) return;
    cx.spawn(async (later) => {
      // Icons found on an earlier run stay on disk; start from those.
      try {
        await mkdir(`${appHome()}/${CACHE}`, { recursive: true });
        for (const f of await readdir(`${appHome()}/${CACHE}`)) {
          const m = /^(.+)\.(svg|png|webp|jpg|ico)$/.exec(f);
          if (m) this.logos.set(m[1], `${CACHE}/${f}`);
        }
      } catch {}
      this.refresh(later);
    });
    cx.timer.every(TICK_MS, (next) => {
      if (Date.now() - this.loadedAt >= cfg.refreshSeconds * 1000) this.refresh(next);
      this.detect(next);
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (later) => {
      const configError = await readConfig();
      const machine = serverMachine();
      let next;
      try {
        if (!cfg.demo && !machine) throw new Error('No server machine. Add one in Herdr, or set "machine" in mods/services/config.json.');
        next = await load(machine);
        if (configError) next.error = configError;
      } catch (e) {
        // Keep the last good list and say why it is stale; the next tick simply tries again.
        const last = shared(KEY_DATA);
        next = { ...(last ?? { at: 0, ip: "", items: [] }), error: configError ?? String(e?.message ?? e) };
      }
      this.busy = false;
      this.loadedAt = Date.now();
      this.withLogos(next);
      setShared(KEY_DATA, next);
      this.detect(later);
      this.hunt(later, next);
      later.notify();
    });
  }

  /** Gives every service the icon found for it, when there is one. */
  withLogos(data) {
    for (const i of data.items) i.logo ??= this.logos.get(iconKey(i));
  }

  /** Looks, in the background and a few at a time, for the icons the services still lack. */
  hunt(cx, data) {
    // A search that never finished (its task dropped or a request hung) must not block icons for
    // good: after HUNT_STALE_MS a new one may start.
    if ((this.hunting && Date.now() - this.huntedAt < HUNT_STALE_MS) || !data.ip || data.demo) return;
    const now = Date.now();
    const seen = new Set();
    const todo = data.items.filter((i) => {
      const key = iconKey(i);
      if (i.logo || seen.has(key) || now - (this.tried.get(key) ?? 0) < RETRY_MS) return false;
      seen.add(key);
      return true;
    });
    if (!todo.length) return;
    this.hunting = true;
    const run = (this.huntedAt = Date.now());
    cx.spawn(async (later) => {
      try {
      for (let n = 0; n < todo.length; n += 4) {
        await Promise.all(todo.slice(n, n + 4).map(async (item) => {
          const key = iconKey(item);
          this.tried.set(key, Date.now());
          const found = await findIcon(item, data.ip).catch(() => null);
          if (found) this.logos.set(key, found);
        }));
        const current = shared(KEY_DATA);
        if (current) { this.withLogos(current); setShared(KEY_DATA, { ...current }); }
      }
      } finally {
        if (this.huntedAt === run) this.hunting = false;
      }
      later.notify();
    });
  }

  /** Asks which project the focused conversation is about, when it is on the server. */
  detect(cx) {
    const data = shared(KEY_DATA);
    if (cfg.demo && data) {
      // The demo has no server to ask: pretend the conversation is about one of its projects.
      const project = data.items.find((i) => i.project)?.project ?? null;
      if (project !== this.project) { this.project = project; cx.notify(); }
      return;
    }
    const f = focused();
    const space = f && spaces().find((s) => s.id === f.space);
    const machine = serverMachine();
    const terminal = machine && space?.machine === machine ? f.terminal : null;
    if (terminal !== this.terminal) Object.assign(this, { terminal, project: null });
    if (!terminal || !data || this.detecting) return;
    this.detecting = true;
    const projects = new Map(data.items.filter((i) => i.project).map((i) => [i.project.toLowerCase(), i.project]));
    for (const i of data.items) if (!i.project) projects.set(i.key, i.name);
    cx.spawn(async (later) => {
      const project = await projectOf(terminal, projects, machine).catch(() => null);
      this.detecting = false;
      if (terminal === this.terminal && project !== this.project) { this.project = project; later.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    const asked = shared(KEY_REFRESH) ?? 0;
    if (asked !== this.seen) { this.seen = asked; this.refresh(cx); }
    if (focused()?.terminal !== this.terminal) this.detect(cx);
    const data = shared(KEY_DATA);
    const now = serviceOf(data, this.project);
    const key = now?.key ?? null;
    if ((shared(KEY_CURRENT) ?? null) !== key) setShared(KEY_CURRENT, key);
    const open = () => run("mod.open", { name: "services" });
    const bar = () => h_flex().size_full().min_w(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted).items_center();
    const hover = (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground));
    if (!now) {
      return hover(bar().id("svc-all").px(10).gap(6).cursor_pointer().justify_center().on_click(open))
        .child(svg(`${ICONS}/generic.svg`).size(12).text_color(data?.error ? t.ansi3 : t.muted))
        .child("Services");
    }
    const colour = now.status === "up" ? t.ansi2 : now.status === "down" ? t.ansi1 : t.ansi3;
    const url = now.links[0].url;
    return bar()
      .child(hover(h_flex().id("svc-open").flex_1().min_w(0).h_full().px(10).gap(7).items_center().cursor_pointer()
        .on_click((_e, c) => c.open_url(url)))
        .child(badge(t, now))
        .child(v_flex().min_w(0).truncate().text_color(t.foreground).font_semibold().child(now.name))
        .child(v_flex().flex_none().text_color(t.dim).child(now.port ? `:${now.port}` : ""))
        .child(h_flex().flex_none().size(6).rounded(3).bg(colour))
        .child(v_flex().flex_none().text_color(t.accent).child("↗")))
      .child(hover(h_flex().id("svc-all").flex_none().h_full().px(9).items_center().cursor_pointer().on_click(open))
        .child(svg(`${ICONS}/generic.svg`).size(12)));
  }
}
