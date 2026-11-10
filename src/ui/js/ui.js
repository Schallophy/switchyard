import { esc } from "./format.js";

let menuNode = null;
let menuCleanup = null;

export function toast(message, tone = "ok", title = "") {
  const host = document.getElementById("toasts");
  if (!host) return;

  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;
  node.setAttribute("role", tone === "bad" ? "alert" : "status");
  node.innerHTML = `${title ? `<strong>${esc(title)}</strong>` : ""}<span>${esc(message)}</span>`;
  host.append(node);

  const life = tone === "bad" ? 6200 : 3600;
  window.setTimeout(() => {
    node.classList.add("is-out");
    window.setTimeout(() => node.remove(), 180);
  }, life);
}

/**
 * 通用对话框。返回 dialog 元素，调用 close() 后自动从 DOM 移除。
 */
export function openDialog({ title, body, footer = "", className = "", onMount }) {
  const dialog = document.createElement("dialog");
  if (className) dialog.className = className;
  dialog.setAttribute("aria-labelledby", "dialog-title");

  dialog.innerHTML = `
    <div class="dialog-head">
      <h2 class="dialog-title" id="dialog-title">${esc(title)}</h2>
      <button class="icon-btn" type="button" data-close aria-label="关闭">✕</button>
    </div>
    <div class="dialog-body">${body}</div>
    ${footer ? `<div class="dialog-foot">${footer}</div>` : ""}
  `;

  document.body.append(dialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove(), { once: true });

  dialog.showModal();
  onMount?.(dialog);
  return dialog;
}

export function confirmDialog({
  title = "确认操作",
  message = "",
  confirmText = "确认",
  cancelText = "取消",
  tone = "",
}) {
  return new Promise((resolve) => {
    let settled = false;

    const dialog = openDialog({
      title,
      body: `<p class="muted">${esc(message)}</p>`,
      footer: `
        <button class="btn" type="button" data-act="cancel">${esc(cancelText)}</button>
        <button class="btn ${tone === "danger" ? "danger" : "primary"}" type="button" data-act="ok">${esc(confirmText)}</button>
      `,
      onMount(node) {
        node.querySelector('[data-act="cancel"]').addEventListener("click", () => node.close());
        node.querySelector('[data-act="ok"]').addEventListener("click", () => {
          settled = true;
          resolve(true);
          node.close();
        });
        node.addEventListener(
          "close",
          () => {
            if (!settled) resolve(false);
          },
          { once: true },
        );
      },
    });

    return dialog;
  });
}

/**
 * 锚定在按钮旁的浮层菜单。items: { label, action, danger, disabled, separator }
 */
export function openMenu(anchor, items) {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");

  for (const item of items) {
    if (item.separator) {
      const line = document.createElement("div");
      line.className = "menu-sep";
      menu.append(line);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    if (item.danger) button.classList.add("menu-danger");
    button.addEventListener("click", () => {
      closeMenu();
      item.action?.();
    });
    menu.append(button);
  }

  document.body.append(menu);
  menuNode = menu;

  const rect = anchor.getBoundingClientRect();
  const width = 188;
  const height = menu.offsetHeight;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  const top =
    rect.bottom + 4 + height <= window.innerHeight - 8
      ? rect.bottom + 4
      : Math.max(8, rect.top - height - 4);

  menu.style.width = `${width}px`;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onPointerDown = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closeMenu();
  };
  const onScroll = () => closeMenu();

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  menuCleanup = () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
  };

  return menu;
}

export function closeMenu() {
  menuCleanup?.();
  menuCleanup = null;
  menuNode?.remove();
  menuNode = null;
}