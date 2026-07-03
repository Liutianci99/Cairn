import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

type Priority = "high" | "normal";
type Page = "projects" | "todos";

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
  note?: string;
  position?: number;
  milestones: Milestone[];
}

interface Todo {
  id: string;
  text: string;
  done: boolean;
  position?: number;
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
// Right-pointing chevron; CSS rotates it 90° to point down when the card is open.
const CHEVRON =
  '<svg width="8" height="13" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 1.5 L6 6.5 L2 11.5"/></svg>';

const isComplete = (p: Project) =>
  p.milestones.length > 0 && p.milestones.every((m) => m.done);

// ====================================================================
// Widget mode — the main desktop panel (two pages: 项目 / 待办)
// ====================================================================
let projects: Project[] = [];
let todos: Todo[] = [];
let activePage: Page = "projects";
const expanded = new Set<string>(); // ids of project cards whose drawer is open

// --- Window auto-fit -------------------------------------------------
// The panel fills the window (height:100vh) and the list scrolls, so opening a
// drawer used to just clip/scroll inside a fixed window (the 待办 got sliced in
// half). Instead, only when opening a drawer would overflow the list do we grow
// the window by exactly the overflow; it shrinks back when the drawer collapses.
let baseHeight = 0; // resting height (user's grip size) — the floor we return to
let expectedH = 0; // last height WE set — lets us tell our resizes from the grip

function maxWindowHeight(): number {
  const avail = window.screen?.availHeight || 1200;
  const top = window.screenY || 0;
  return Math.max(320, avail - top - 8);
}

async function applyWindowHeight(h: number) {
  const target = Math.round(h);
  if (Math.abs(target - window.innerHeight) < 2) return; // already there
  expectedH = target;
  try {
    await getCurrentWindow().setSize(new LogicalSize(window.innerWidth, target));
  } catch {
    /* not running under Tauri */
  }
}

// Resize only when the list actually overflows. We force open drawers to their
// full height (transitions off) and read the list's scrollHeight vs its visible
// height: a positive delta = content is clipped, so grow the window by exactly
// that much (capped at the screen bottom, past which the list scrolls). A
// negative delta = slack; on collapse/rebuild we shrink it away, never below the
// resting height. When it already fits, the window doesn't move at all.
function refitWindow(opening = false) {
  const panel = document.querySelector<HTMLElement>(".panel");
  const list = document.querySelector<HTMLElement>(".list");
  if (!panel || !list) return;
  panel.classList.add("measuring-drawers");
  const overflow = list.scrollHeight - list.clientHeight;
  panel.classList.remove("measuring-drawers");
  const cur = window.innerHeight;
  let target = cur;
  if (overflow > 1) {
    target = Math.min(cur + overflow, maxWindowHeight()); // clipped → extend to fit
  } else if (!opening && overflow < -1) {
    target = Math.max(cur + overflow, baseHeight); // slack on collapse → shrink back
  }
  void applyWindowHeight(target);
}

function initAutoFit() {
  baseHeight = window.innerHeight;
  expectedH = window.innerHeight;
  // A resize we didn't initiate = the user dragged the grip; adopt it as the new
  // resting height so a collapse returns here instead of the old value.
  window.addEventListener("resize", () => {
    if (Math.abs(window.innerHeight - expectedH) > 2) {
      baseHeight = window.innerHeight;
      expectedH = window.innerHeight;
    }
  });
}

async function reloadProjects() {
  projects = await invoke<Project[]>("list_projects");
  render();
}
async function reloadTodos() {
  todos = await invoke<Todo[]>("list_todos");
  render();
}

// A project card: a header row (arrow + name + 待办 count) and a collapsible
// drawer listing the project's 待办事项. The drawer animates open/closed via CSS
// (grid-template-rows 0fr↔1fr), so the arrow toggles a class rather than
// re-rendering; expanding pushes the cards below it down (accordion).
function buildRow(p: Project): HTMLElement {
  const complete = isComplete(p);
  const open = expanded.has(p.id);
  const row = el(
    "div",
    "row" + (complete ? " completed" : "") + (open ? " expanded" : ""),
  );
  row.dataset.id = p.id;

  const head = el("div", "row-head");

  const arrow = el("button", "arrow-btn");
  arrow.type = "button";
  arrow.innerHTML = CHEVRON;
  arrow.title = open ? "收起" : "展开待办";
  arrow.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowOpen = row.classList.toggle("expanded");
    if (nowOpen) expanded.add(p.id);
    else expanded.delete(p.id);
    arrow.title = nowOpen ? "收起" : "展开待办";
    if (nowOpen) {
      // grow the window now — but only if the drawer won't fit as-is — so it
      // animates into real space instead of being clipped by a too-short window
      refitWindow(true);
    } else {
      // shrink only after the drawer has finished collapsing, so the content is
      // gone before the window contracts (avoids a clipped frame on the way down)
      const d = row.querySelector<HTMLElement>(".drawer");
      const onEnd = (ev: TransitionEvent) => {
        if (ev.propertyName !== "grid-template-rows") return;
        d?.removeEventListener("transitionend", onEnd);
        refitWindow();
      };
      d?.addEventListener("transitionend", onEnd);
    }
  });
  head.appendChild(arrow);

  head.appendChild(el("span", "row-title", p.title));
  head.appendChild(el("span", "count", `${p.milestones.length} 待办`));
  row.appendChild(head);

  // drawer
  const drawer = el("div", "drawer");
  const inner = el("div", "drawer-inner");
  const dtodos = el("div", "drawer-todos");
  for (const m of p.milestones) {
    const trow = el("div", "todo-row" + (m.done ? " done" : ""));
    const check = el("button", "todo-check");
    check.type = "button";
    check.addEventListener("click", async (e) => {
      e.stopPropagation();
      m.done = !m.done; // optimistic
      trow.classList.toggle("done", m.done);
      row.classList.toggle("completed", isComplete(p));
      try {
        await invoke("set_milestone_done", { milestoneId: m.id, done: m.done });
      } catch (err) {
        console.error("set_milestone_done failed", err);
        await reloadProjects();
      }
    });
    trow.appendChild(check);
    trow.appendChild(el("span", "todo-text", m.title));
    dtodos.appendChild(trow);
  }
  inner.appendChild(dtodos);
  drawer.appendChild(inner);
  row.appendChild(drawer);

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, p);
  });

  return row;
}

// Left-press-and-drag a project card to reorder the list. The card lifts out of
// flow and follows the cursor while a dashed placeholder marks where it will
// drop; the new order is persisted (reorder_projects). A movement threshold
// keeps plain clicks — the arrow, drawer todos, right-click — from being read as
// a drag.
function wireDrag(list: HTMLElement) {
  let candidate: HTMLElement | null = null;
  let dragging: HTMLElement | null = null;
  let placeholder: HTMLElement | null = null;
  let startY = 0;
  let grabOffsetY = 0;
  let started = false;

  const positionCard = (clientY: number) => {
    if (!dragging || !placeholder) return;
    dragging.style.top = clientY - grabOffsetY + "px";
    let target: HTMLElement | null = null;
    for (const other of list.querySelectorAll<HTMLElement>(".row")) {
      if (other === dragging) continue;
      const r = other.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        target = other;
        break;
      }
    }
    list.insertBefore(placeholder, target);
  };

  const beginDrag = (r: HTMLElement, e: MouseEvent) => {
    started = true;
    dragging = r;
    const rect = r.getBoundingClientRect();
    grabOffsetY = e.clientY - rect.top;
    placeholder = document.createElement("div");
    placeholder.className = "row-placeholder";
    placeholder.style.height = rect.height + "px";
    list.insertBefore(placeholder, r);
    r.classList.add("dragging");
    r.style.position = "fixed";
    r.style.width = rect.width + "px";
    r.style.left = rect.left + "px";
    r.style.pointerEvents = "none";
    positionCard(e.clientY);
  };

  const onMove = (e: MouseEvent) => {
    if (!candidate) return;
    if (!started) {
      if (Math.abs(e.clientY - startY) < 5) return;
      beginDrag(candidate, e);
    } else {
      e.preventDefault();
      positionCard(e.clientY);
    }
  };

  const onUp = async () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const didDrag = started;
    if (dragging && placeholder) {
      list.insertBefore(dragging, placeholder);
      placeholder.remove();
      dragging.classList.remove("dragging");
      dragging.removeAttribute("style");
    }
    candidate = null;
    dragging = null;
    placeholder = null;
    started = false;
    if (!didDrag) return;
    const ids = [...list.querySelectorAll<HTMLElement>(".row")].map(
      (r) => r.dataset.id!,
    );
    try {
      await invoke("reorder_projects", { orderedIds: ids });
    } catch (e) {
      console.error("reorder_projects failed", e);
    }
    await reloadProjects();
  };

  list.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".arrow-btn") || t.closest(".drawer")) return; // let those interactions work
    const row = t.closest<HTMLElement>(".row");
    if (!row) return;
    candidate = row;
    startY = e.clientY;
    started = false;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function buildHeader(): HTMLElement {
  const header = el("div", "header");

  const tabs = el("div", "tabs");
  const mkTab = (key: Page, label: string) => {
    const t = el("button", "tab" + (activePage === key ? " active" : ""), label);
    t.type = "button";
    t.addEventListener("click", () => {
      if (activePage === key) return;
      activePage = key;
      if (key === "todos") void reloadTodos();
      else void reloadProjects();
    });
    return t;
  };
  tabs.appendChild(mkTab("projects", "项目"));
  tabs.appendChild(mkTab("todos", "待办"));

  const add = el("button", "add-btn", "+");
  add.type = "button";
  add.title = activePage === "projects" ? "新建项目" : "新增日常待办";
  add.addEventListener("click", () => {
    if (activePage === "projects") void openEditor();
    else addTodoInline();
  });

  header.appendChild(tabs);
  header.appendChild(add);
  return header;
}

function renderProjectsPage(app: HTMLElement) {
  const ordered = [...projects].sort(
    (a, b) => Number(isComplete(a)) - Number(isComplete(b)),
  );
  const list = el("div", "list");
  if (ordered.length === 0) {
    list.appendChild(el("div", "empty-hint", "还没有项目,点右上角 + 新建"));
  }
  for (const p of ordered) list.appendChild(buildRow(p));
  app.appendChild(list);
  wireDrag(list);
}

function renderTodosPage(app: HTMLElement) {
  const list = el("div", "list todos-list");
  list.appendChild(el("div", "todos-cap", "与开发无关的日常事项"));
  if (todos.length === 0) {
    list.appendChild(el("div", "empty-hint", "还没有日常待办,点右上角 + 添加"));
  }
  for (const t of todos) {
    const trow = el("div", "todo-row daily" + (t.done ? " done" : ""));
    trow.dataset.id = t.id;
    const check = el("button", "todo-check");
    check.type = "button";
    check.addEventListener("click", async () => {
      t.done = !t.done;
      trow.classList.toggle("done", t.done);
      try {
        await invoke("set_todo_done", { todoId: t.id, done: t.done });
      } catch (e) {
        console.error("set_todo_done failed", e);
        await reloadTodos();
      }
    });
    trow.appendChild(check);
    trow.appendChild(el("span", "todo-text", t.text));
    trow.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTodoMenu(e.clientX, e.clientY, t);
    });
    list.appendChild(trow);
  }
  app.appendChild(list);
}

function render() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;
  app.className = "panel";
  app.innerHTML = "";

  app.appendChild(el("div", "backdrop"));

  const dragStrip = el("div", "draghandle-strip");
  dragStrip.setAttribute("data-tauri-drag-region", "");
  dragStrip.appendChild(el("div", "draghandle"));
  app.appendChild(dragStrip);

  app.appendChild(buildHeader());

  if (activePage === "projects") renderProjectsPage(app);
  else renderTodosPage(app);

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

  // keep window height matched to content after a rebuild (add/delete/reorder,
  // page switch). Collapsed → resting height; a still-open drawer keeps its room.
  refitWindow();
}

// Inline "add daily todo": lift the window so it can take keystrokes, drop an
// input at the top of the list, create on Enter (and reopen for rapid entry),
// dismiss on Escape/blur.
function addTodoInline() {
  const list = document.querySelector<HTMLElement>(".todos-list");
  if (!list) return;
  const existingInput = list.querySelector<HTMLInputElement>(".todo-add-input");
  if (existingInput) {
    existingInput.focus();
    return;
  }

  const wrap = el("div", "todo-row daily adding");
  wrap.appendChild(el("span", "todo-check ghost"));
  const input = document.createElement("input");
  input.className = "todo-add-input";
  input.type = "text";
  input.placeholder = "新日常待办,回车添加";
  wrap.appendChild(input);
  const cap = list.querySelector(".todos-cap");
  list.insertBefore(wrap, cap ? cap.nextSibling : list.firstChild);

  void invoke("set_editing", { editing: true }).catch(() => {});
  input.focus();

  const done = () => void invoke("set_editing", { editing: false }).catch(() => {});
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      try {
        await invoke("create_todo", { text });
        await reloadTodos();
        addTodoInline(); // reopen for the next entry
      } catch (err) {
        console.error("create_todo failed", err);
      }
    } else if (e.key === "Escape") {
      done();
      wrap.remove();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== input) {
        done();
        wrap.remove();
      }
    }, 120);
  });
}

function showTodoMenu(x: number, y: number, t: Todo) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = el("div", "ctx-menu");
  const del = el("div", "ctx-item danger");
  const ico = el("span", "ctx-ico");
  ico.innerHTML = ICON_DELETE;
  del.appendChild(ico);
  del.appendChild(el("span", undefined, "删除"));
  menu.appendChild(del);
  document.body.appendChild(menu);

  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc);
  };
  const onDoc = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  setTimeout(() => document.addEventListener("mousedown", onDoc), 0);

  del.addEventListener("click", async () => {
    close();
    try {
      await invoke("delete_todo", { todoId: t.id });
      todos = todos.filter((x) => x.id !== t.id);
      render();
    } catch (e) {
      console.error("delete_todo failed", e);
    }
  });
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
    alwaysOnTop: false,
    skipTaskbar: true,
    focus: false,
    shadow: false,
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
    : [{ id: null, title: "待办事项 1" }];

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

  // 便签 — a per-project memo that grows in height with its content
  const memoWrap = el("div", "field");
  memoWrap.appendChild(el("label", "field-label", "便签"));
  const memo = document.createElement("textarea");
  memo.className = "text-area";
  memo.placeholder = "写点便签…";
  memo.value = existing?.note ?? "";
  memo.rows = 3;
  const growMemo = () => {
    memo.style.height = "auto";
    memo.style.height = memo.scrollHeight + "px";
    void fitWindow();
  };
  memo.addEventListener("input", growMemo);
  memoWrap.appendChild(memo);
  root.appendChild(memoWrap);

  // 待办事项 count
  const countWrap = el("div", "field");
  countWrap.appendChild(el("label", "field-label", "待办事项数量"));
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

  // 待办事项 names
  const namesWrap = el("div", "field");
  namesWrap.appendChild(el("label", "field-label", "待办事项命名"));
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
      inp.placeholder = "待办事项 " + (i + 1);
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
    const note = memo.value;
    const named = nodes.map((n, i) => ({
      id: n.id,
      title: n.title.trim() || "待办事项 " + (i + 1),
    }));
    try {
      if (isEdit) {
        await invoke("update_project", {
          id: existing!.id,
          title,
          priority,
          note,
          milestones: named,
        });
      } else {
        await invoke("create_project", {
          title,
          priority,
          note,
          milestones: named.map((n) => n.title),
        });
      }
      await emit("projects-changed");
      closeWin();
    } catch (e) {
      console.error("save project failed", e);
    }
  });

  growMemo();
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
    initAutoFit();
    void reloadProjects();
    void listen("projects-changed", () => void reloadProjects());
  }
});
