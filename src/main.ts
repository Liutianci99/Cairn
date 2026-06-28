import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

type Priority = "high" | "normal";

interface Milestone {
  id: string;
  title: string;
  done: boolean;
  position?: number;
}

interface Project {
  id: string;
  title: string;
  priority: Priority;
  position?: number;
  milestones: Milestone[];
}

// Projects live in the local SQLite database (via Tauri commands). This array is
// just an in-memory cache: mutations update it optimistically and persist in the
// background, falling back to a reload if a write fails.
let projects: Project[] = [];

async function reload() {
  projects = await invoke<Project[]>("list_projects");
  render();
}

const doneCount = (p: Project) => p.milestones.filter((m) => m.done).length;
const isComplete = (p: Project) =>
  p.milestones.length > 0 && p.milestones.every((m) => m.done);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const ICON_EDIT =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>';
const ICON_DELETE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';

function buildStepper(p: Project, complete: boolean): HTMLElement {
  const done = doneCount(p);
  const total = p.milestones.length;
  const stepper = el("div", "stepper");
  for (let i = 0; i < total; i++) {
    const node = el("button", "node");
    node.type = "button";
    node.title = p.milestones[i].title;
    if (p.milestones[i].done) node.classList.add("done");
    else if (i === done && !complete) node.classList.add("current");
    if (complete) node.classList.add("mint");
    node.addEventListener("click", async () => {
      const m = p.milestones[i];
      m.done = !m.done; // optimistic
      render();
      try {
        await invoke("set_milestone_done", { milestoneId: m.id, done: m.done });
      } catch (e) {
        console.error("set_milestone_done failed", e);
        await reload(); // fall back to the persisted truth
      }
    });
    stepper.appendChild(node);
    if (i < total - 1) {
      const conn = el("div", "conn");
      if (p.milestones[i].done && p.milestones[i + 1].done)
        conn.classList.add("done");
      if (complete) conn.classList.add("mint");
      stepper.appendChild(conn);
    }
  }
  return stepper;
}

function buildRow(p: Project): HTMLElement {
  const complete = isComplete(p);
  const row = el("div", "row" + (complete ? " completed" : ""));

  const top = el("div", "row-top");
  const left = el("div", "row-left");
  if (complete) {
    left.appendChild(el("span", "check", "✓"));
  } else {
    left.appendChild(el("span", "dot " + p.priority));
  }
  left.appendChild(el("span", "row-title", p.title));
  top.appendChild(left);
  top.appendChild(el("span", "count", `${doneCount(p)}/${p.milestones.length}`));

  row.appendChild(top);
  row.appendChild(buildStepper(p, complete));

  // right-click → edit / delete menu
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, p);
  });

  return row;
}

function render() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  app.innerHTML = "";

  // blurred-wallpaper backdrop (fakes frosted glass; see .backdrop in styles.css)
  app.appendChild(el("div", "backdrop"));

  const ordered = [...projects].sort(
    (a, b) => Number(isComplete(a)) - Number(isComplete(b)),
  );
  const activeCount = projects.filter((p) => !isComplete(p)).length;
  const doneProjects = projects.length - activeCount;

  // top-center drag handle
  const dragStrip = el("div", "draghandle-strip");
  dragStrip.setAttribute("data-tauri-drag-region", "");
  dragStrip.appendChild(el("div", "draghandle"));
  app.appendChild(dragStrip);

  // header
  const header = el("div", "header");
  const titles = el("div", "titles");
  const t = el("div", "title", "项目");
  const sub = el(
    "div",
    "subtitle",
    `进行中 ${activeCount} · 已完成 ${doneProjects}`,
  );
  titles.appendChild(t);
  titles.appendChild(sub);

  const add = el("button", "add-btn", "+");
  add.type = "button";
  add.title = "新建项目";
  add.addEventListener("click", () => openProjectDialog());

  header.appendChild(titles);
  header.appendChild(add);
  app.appendChild(header);

  // list
  const list = el("div", "list");
  for (const p of ordered) list.appendChild(buildRow(p));
  app.appendChild(list);

  // resize grip (bottom-right)
  const grip = el("div", "grip");
  grip.title = "拖拽调整大小";
  grip.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    try {
      await getCurrentWindow().startResizeDragging("SouthEast");
    } catch {
      /* not running under Tauri */
    }
  });
  app.appendChild(grip);
}

// ---------- right-click context menu ----------
function showContextMenu(x: number, y: number, p: Project) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());

  const menu = el("div", "ctx-menu");
  const item = (icon: string, label: string, danger?: boolean) => {
    const it = el("div", "ctx-item" + (danger ? " danger" : ""));
    const ico = el("span", "ctx-ico");
    ico.innerHTML = icon;
    it.appendChild(ico);
    it.appendChild(el("span", undefined, label));
    return it;
  };
  const edit = item(ICON_EDIT, "编辑");
  const del = item(ICON_DELETE, "删除", true);
  menu.appendChild(edit);
  menu.appendChild(del);
  document.body.appendChild(menu);

  // clamp into the viewport
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc);
    document.removeEventListener("keydown", onKey);
  };
  const onDoc = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
  }, 0);

  edit.addEventListener("click", () => {
    close();
    openProjectDialog(p);
  });
  del.addEventListener("click", async () => {
    close();
    try {
      await invoke("delete_project", { id: p.id });
      projects = projects.filter((x) => x.id !== p.id);
      render();
    } catch (e) {
      console.error("delete_project failed", e);
    }
  });
}

// ---------- create / edit dialog ----------
function openProjectDialog(existing?: Project) {
  const isEdit = !!existing;
  let priority: Priority = existing?.priority ?? "normal";
  // working node list; existing milestones keep their id so done is preserved
  const nodes: { id: string | null; title: string }[] = existing
    ? existing.milestones.map((m) => ({ id: m.id, title: m.title }))
    : [
        { id: null, title: "节点 1" },
        { id: null, title: "节点 2" },
        { id: null, title: "节点 3" },
      ];

  const overlay = el("div", "dialog-overlay");
  const dialog = el("div", "dialog");
  overlay.appendChild(dialog);

  dialog.appendChild(el("div", "dialog-title", isEdit ? "编辑项目" : "新建项目"));

  // name
  const nameWrap = el("div", "field");
  nameWrap.appendChild(el("label", "field-label", "名称"));
  const nameInput = document.createElement("input");
  nameInput.className = "text-input";
  nameInput.type = "text";
  nameInput.placeholder = "项目名称";
  nameInput.value = existing?.title ?? "";
  nameWrap.appendChild(nameInput);
  dialog.appendChild(nameWrap);

  // priority
  const prioWrap = el("div", "field");
  prioWrap.appendChild(el("label", "field-label", "优先级"));
  const seg = el("div", "seg");
  const makePill = (val: Priority, label: string) => {
    const pill = el(
      "button",
      "seg-pill " + val + (priority === val ? " active" : ""),
    );
    pill.type = "button";
    pill.appendChild(el("span", "seg-dot " + val));
    pill.appendChild(el("span", undefined, label));
    pill.addEventListener("click", () => {
      priority = val;
      seg
        .querySelectorAll(".seg-pill")
        .forEach((x) => x.classList.remove("active"));
      pill.classList.add("active");
    });
    return pill;
  };
  seg.appendChild(makePill("normal", "普通"));
  seg.appendChild(makePill("high", "重要"));
  prioWrap.appendChild(seg);
  dialog.appendChild(prioWrap);

  // node count
  const countWrap = el("div", "field");
  countWrap.appendChild(el("label", "field-label", "节点数量"));
  const stepperRow = el("div", "stepper-row");
  const minus = el("button", "step-btn", "−");
  minus.type = "button";
  const countNum = el("span", "step-num", String(nodes.length));
  const plus = el("button", "step-btn", "+");
  plus.type = "button";
  stepperRow.appendChild(minus);
  stepperRow.appendChild(countNum);
  stepperRow.appendChild(plus);
  countWrap.appendChild(stepperRow);
  dialog.appendChild(countWrap);

  // node names
  const namesWrap = el("div", "field");
  namesWrap.appendChild(el("label", "field-label", "节点命名"));
  const nodesContainer = el("div", "node-inputs");
  namesWrap.appendChild(nodesContainer);
  dialog.appendChild(namesWrap);

  function renderNodes() {
    countNum.textContent = String(nodes.length);
    nodesContainer.innerHTML = "";
    nodes.forEach((n, i) => {
      const inp = document.createElement("input");
      inp.className = "text-input";
      inp.type = "text";
      inp.placeholder = "节点 " + (i + 1);
      inp.value = n.title;
      inp.addEventListener("input", () => {
        n.title = inp.value;
      });
      nodesContainer.appendChild(inp);
    });
  }
  renderNodes();

  minus.addEventListener("click", () => {
    if (nodes.length > 1) {
      nodes.pop();
      renderNodes();
    }
  });
  plus.addEventListener("click", () => {
    nodes.push({ id: null, title: "" });
    renderNodes();
  });

  // actions
  const actions = el("div", "dialog-actions");
  const cancel = el("button", "btn-ghost", "取消");
  cancel.type = "button";
  const save = el("button", "btn-primary", "保存");
  save.type = "button";
  actions.appendChild(cancel);
  actions.appendChild(save);
  dialog.appendChild(actions);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    // drop the window back to the desktop bottom layer
    void invoke("set_editing", { editing: false }).catch(() => {});
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  cancel.addEventListener("click", close);

  save.addEventListener("click", async () => {
    const title = nameInput.value.trim() || (isEdit ? existing!.title : "新项目");
    const named = nodes.map((n, i) => ({
      id: n.id,
      title: n.title.trim() || "节点 " + (i + 1),
    }));
    try {
      if (isEdit) {
        const updated = await invoke<Project>("update_project", {
          id: existing!.id,
          title,
          priority,
          milestones: named,
        });
        const idx = projects.findIndex((p) => p.id === updated.id);
        if (idx >= 0) projects[idx] = updated;
        else projects.push(updated);
      } else {
        const created = await invoke<Project>("create_project", {
          title,
          priority,
          milestones: named.map((n) => n.title),
        });
        projects.push(created);
      }
      close();
      render();
    } catch (e) {
      console.error("save project failed", e);
    }
  });

  // lift the window forward + make it focusable so the text fields accept input
  void invoke("set_editing", { editing: true }).catch(() => {});
  document.body.appendChild(overlay);
  nameInput.focus();
}

// suppress the default browser context menu app-wide; rows show a custom one
document.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("DOMContentLoaded", () => {
  void reload();
});
