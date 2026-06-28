import { getCurrentWindow } from "@tauri-apps/api/window";

type Priority = "high" | "normal";

interface Milestone {
  title: string;
  done: boolean;
}

interface Project {
  id: string;
  title: string;
  priority: Priority;
  milestones: Milestone[];
}

// --- sample data (standalone, in-memory for now) ---
function ms(titles: string[], doneCount: number): Milestone[] {
  return titles.map((title, i) => ({ title, done: i < doneCount }));
}

let projects: Project[] = [
  {
    id: "p1",
    title: "Momento 多端同步",
    priority: "high",
    milestones: ms(["立项", "数据层", "同步协议", "客户端", "联调"], 3),
  },
  {
    id: "p2",
    title: "毕业设计论文",
    priority: "high",
    milestones: ms(["选题", "需求分析", "系统设计", "实现"], 1),
  },
  {
    id: "p3",
    title: "个人网站后端",
    priority: "normal",
    milestones: ms(["接口设计", "md 同步", "问答 agent"], 1),
  },
  {
    id: "p4",
    title: "实习中台需求",
    priority: "high",
    milestones: ms(["评审", "联调", "测试", "上线", "复盘"], 4),
  },
  {
    id: "p5",
    title: "Verba 迁移腾讯云",
    priority: "normal",
    milestones: ms(["盘点", "打包", "迁移", "验证"], 1),
  },
  {
    id: "p6",
    title: "Momento V3 改版",
    priority: "normal",
    milestones: ms(["设计", "落代码", "自测", "发布"], 4),
  },
];

const doneCount = (p: Project) => p.milestones.filter((m) => m.done).length;
const isComplete = (p: Project) => p.milestones.every((m) => m.done);

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
    node.addEventListener("click", () => {
      p.milestones[i].done = !p.milestones[i].done;
      render();
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
  add.addEventListener("click", () => {
    projects.push({
      id: "p" + (projects.length + 1),
      title: "新项目",
      priority: "normal",
      milestones: ms(["节点 1", "节点 2", "节点 3"], 0),
    });
    render();
  });

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

window.addEventListener("DOMContentLoaded", render);
