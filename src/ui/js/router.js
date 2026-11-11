export const VIEWS = ["models", "rank", "usage", "live", "events", "settings"];

const LEGACY = {
  overview: "models",
  chain: "models",
  callers: "usage",
  catalog: "models",
};

/**
 * 解析 hash 路由。返回 canonical 时表示需要把地址替换成规范路径。
 */
export function parseRoute(hash = window.location.hash) {
  const raw = String(hash || "").replace(/^#\/?/, "").trim();
  if (!raw) {
    return { view: "models", section: null, openAdd: false, canonical: "#/models" };
  }

  const parts = raw.split("/").filter(Boolean);
  const name = decodeURIComponent(parts[0] || "").toLowerCase();
  const section = parts[1] ? decodeURIComponent(parts[1]) : null;

  if (name === "catalog") {
    return { view: "models", section: null, openAdd: true, canonical: "#/models" };
  }

  if (LEGACY[name]) {
    const view = LEGACY[name];
    return { view, section: null, openAdd: false, canonical: `#/${view}` };
  }

  if (!VIEWS.includes(name)) {
    return { view: "models", section: null, openAdd: false, canonical: "#/models" };
  }

  return { view: name, section, openAdd: false, canonical: null };
}

export function currentPath(route) {
  return route.section ? `#/${route.view}/${route.section}` : `#/${route.view}`;
}

export function replaceRoute(path) {
  if (window.location.hash === path) return;
  window.history.replaceState(null, "", path);
}