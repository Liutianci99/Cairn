import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

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

const doneCount = (p: Project) => p.milestones.filter((m) => m.done).length;
const isComplete = (p: Project) =>
  p.milestones.length > 0 && p.milestones.every((m) => m.done);

// ====================================================================
// Widget mode — the main desktop panel
// ====================================================================
let projects: Project[] = [];

async function reload() {
  projects = await invoke<Project[]>("list_projects");
  render();
}

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
        await reload();
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

  app.appendChild(el("div", "backdrop"));

  const ordered = [...projects].sort(
    (a, b) => Number(isComplete(a)) - Number(isComplete(b)),
  );
  const activeCount = projects.filter((p) => !isComplete(p)).length;
  const doneProjects = projects.length - activeCount;

  const dragStrip = el("div", "draghandle-strip");
  dragStrip.setAttribute("data-tauri-drag-region", "");
  dragStrip.appendChild(el("div", "draghandle"));
  app.appendChild(dragStrip);

  const header = el("div", "header");
  const titles = el("div", "titles");
  titles.appendChild(el("div", "title", "项目"));
  titles.appendChild(
    el("div", "subtitle", `进行中 ${activeCount} · 已完成 ${doneProjects}`),
  );

  const add = el("button", "add-btn", "+");
  add.type = "button";
  add.title = "新建项目";
  add.addEventListener("click", () => void openEditor());

  header.appendChild(titles);
  header.appendChild(add);
  app.appendChild(header);

  const list = el("div", "list");
  for (const p of ordered) list.appendChild(buildRow(p));
  app.appendChild(list);

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
    void openEditor(p);
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

// Open the create/edit form as a separate window pinned just left of the widget.
async function openEditor(existing?: Project) {
  try {
    const old = await WebviewWindow.getByLabel("editor");
    if (old) await old.close();
  } catch {
    /* ignore */
  }

  const main = getCurrentWindow();
  let x = 100;
  let y = 100;
  try {
    const [pos, scale] = await Promise.all([
      main.outerPosition(),
      main.scaleFactor(),
    ]);
    const wPhys = Math.round(380 * scale);
    const gapPhys = Math.round(16 * scale);
    x = pos.x - wPhys - gapPhys;
    y = pos.y;
  } catch (e) {
    console.error("could not read widget position", e);
  }

  const url =
    "index.html?mode=editor&x=" +
    x +
    "&y=" +
    y +
    (existing ? "&id=" + encodeURIComponent(existing.id) : "");

  const win = new WebviewWindow("editor", {
    url,
    width: 380,
    height: 320,
    decorations: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: false,
    shadow: true,
    visible: false,
    title: "Cairn 编辑",
  });
  win.once("tauri://error", (e) => console.error("editor window error", e));
}

// ====================================================================
// Editor mode — the standalone create/edit window
// ====================================================================
async function setupEditor(paramsIn: URLSearchParams) {
  const id = paramsIn.get("id");
  const px = Number(paramsIn.get("x"));
  const py = Number(paramsIn.get("y"));

  let existing: Project | undefined;
  if (id) {
    try {
      const all = await invoke<Project[]>("list_projects");
      existing = all.find((p) => p.id === id);
    } catch (e) {
      console.error("load project failed", e);
    }
  }

  renderEditor(existing);

  const win = getCurrentWindow();
  await fitWindow();
  try {
    if (!Number.isNaN(px) && !Number.isNaN(py)) {
      await win.setPosition(new PhysicalPosition(px, py));
    }
    await win.show();
    await win.setFocus();
  } catch (e) {
    console.error("position/show editor failed", e);
  }
}

async function fitWindow() {
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
  );
  const root = document.querySelector<HTMLElement>(".editor-root");
  const h = root ? root.offsetHeight : 360;
  try {
    await getCurrentWindow().setSize(new LogicalSize(380, h));
  } catch (e) {
    console.error("setSize failed", e);
  }
}

function renderEditor(existing?: Project) {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  app.className = "editor-app";
  app.innerHTML = "";

  const isEdit = !!existing;
  let priority: Priority = existing?.priority ?? "normal";
  const nodes: { id: string | null; title: string }[] = existing
    ? existing.milestones.map((m) => ({ id: m.id, title: m.title }))
    : [
        { id: null, title: "节点 1" },
        { id: null, title: "节点 2" },
        { id: null, title: "节点 3" },
      ];

  const root = el("div", "editor-root");
  root.appendChild(el("div", "backdrop"));
  app.appendChild(root);

  root.appendChild(el("div", "dialog-title", isEdit ? "编辑项目" : "新建项目"));

  // name
  const nameWrap = el("div", "field");
  nameWrap.appendChild(el("label", "field-label", "名称"));
  const nameInput = document.createElement("input");
  nameInput.className = "text-input";
  nameInput.type = "text";
  nameInput.placeholder = "项目名称";
  nameInput.value = existing?.title ?? "";
  nameWrap.appendChild(nameInput);
  root.appendChild(nameWrap);

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
  root.appendChild(prioWrap);

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
  root.appendChild(countWrap);

  // node names
  const namesWrap = el("div", "field");
  namesWrap.appendChild(el("label", "field-label", "节点命名"));
  const nodesContainer = el("div", "node-inputs");
  namesWrap.appendChild(nodesContainer);
  root.appendChild(namesWrap);

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
    void fitWindow();
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
  const confirm = el("button", "btn-primary", "确认");
  confirm.type = "button";
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  root.appendChild(actions);

  const closeWin = () => void getCurrentWindow().close();
  cancel.addEventListener("click", closeWin);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeWin();
  });

  confirm.addEventListener("click", async () => {
    const title = nameInput.value.trim() || (isEdit ? existing!.title : "新项目");
    const named = nodes.map((n, i) => ({
      id: n.id,
      title: n.title.trim() || "节点 " + (i + 1),
    }));
    try {
      if (isEdit) {
        await invoke("update_project", {
          id: existing!.id,
          title,
          priority,
          milestones: named,
        });
      } else {
        await invoke("create_project", {
          title,
          priority,
          milestones: named.map((n) => n.title),
        });
      }
      await emit("projects-changed");
      closeWin();
    } catch (e) {
      console.error("save project failed", e);
    }
  });

  nameInput.focus();
}

// ====================================================================
// Boot
// ====================================================================
document.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  if (params.get("mode") === "editor") {
    void setupEditor(params);
  } else {
    void reload();
    void listen("projects-changed", () => void reload());
  }
});
