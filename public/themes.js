export const WORKBENCH_THEMES = [
  { id: "porcelain", name: "青花", palette: "瓷白 · 靛蓝", description: "留白如瓷，书页清明。", seal: "青" },
  { id: "bamboo", name: "竹影", palette: "竹青 · 米白", description: "竹窗疏影，一卷闲书。", seal: "竹" },
  { id: "paper", name: "宋笺", palette: "宣纸 · 朱砂", description: "墨落纸上，朱印藏书。", seal: "笺" },
  { id: "lamplight", name: "灯下", palette: "墨夜 · 暖金", description: "灯火温存，长夜可读。", seal: "灯" },
];
const storageKey = "xxg:theme";
const resolveTheme = (id) => WORKBENCH_THEMES.find((theme) => theme.id === id) || WORKBENCH_THEMES[0];
const currentTheme = () => resolveTheme(document.documentElement.dataset.workbenchTheme);
export function themeButton() {
  return `<button class="theme-trigger" data-theme-trigger aria-haspopup="dialog" aria-controls="theme-dialog" aria-label="切换视觉主题，当前${currentTheme().name}"><span class="theme-mark" aria-hidden="true"></span><span data-theme-name>${currentTheme().name}</span><span class="theme-trigger-caption">主题</span></button>`;
}
export function initThemes() {
  const dialog = document.createElement("dialog");
  dialog.id = "theme-dialog"; dialog.className = "theme-dialog";
  dialog.setAttribute("aria-labelledby", "theme-title");
  dialog.innerHTML = `<div class="dialog-head"><div><p class="eyebrow">瀟湘四景</p><h2 id="theme-title">换一方书斋</h2></div><button class="icon-button" data-theme-close aria-label="关闭主题选择">×</button></div>
    <fieldset class="theme-choices"><legend class="sr-only">工作台视觉主题</legend>${WORKBENCH_THEMES.map((theme) => `<label class="theme-choice" data-workbench-theme="${theme.id}">
      <input type="radio" name="workbench-theme" value="${theme.id}"/><span class="theme-choice-title">${theme.name}<small>${theme.palette}</small></span>
      <span class="theme-specimen" aria-hidden="true"><span class="specimen-rail">瀟湘館<i></i><i></i></span><span class="specimen-page"><span class="specimen-heading">山水有清音</span><span class="specimen-lines"></span><span class="specimen-seal">${theme.seal}</span></span></span>
      <span class="theme-choice-description">${theme.description}</span></label>`).join("")}</fieldset>
    <div class="theme-dialog-foot"><p id="theme-status" role="status" aria-live="polite"></p><button data-theme-close class="primary">回到书页</button></div><p class="theme-footnote">即时生效 · 记住你的选择。阅读纸张也可在「阅读设置」中单独调整。</p>`;
  document.body.append(dialog);
  const syncControls = (theme) => {
    document.querySelectorAll("[data-theme-trigger]").forEach((button) => {
      button.querySelector("[data-theme-name]").textContent = theme.name;
      button.setAttribute("aria-label", `切换视觉主题，当前${theme.name}`);
    });
    dialog.querySelectorAll("input").forEach((input) => { input.checked = input.value === theme.id; });
  };
  const apply = (id, persist = true) => {
    const theme = resolveTheme(id);
    window.dispatchEvent(new Event("workbench-theme-beforechange"));
    document.documentElement.dataset.workbenchTheme = theme.id;
    let saved = true;
    if (persist) try { localStorage.setItem(storageKey, theme.id); } catch { saved = false; }
    syncControls(theme);
    dialog.querySelector("#theme-status").textContent = `已选${theme.name}${saved ? "" : " · 仅本次生效"}`;
    window.dispatchEvent(new Event("workbench-themechange"));
  };
  document.querySelector(".top-actions").insertAdjacentHTML("afterbegin", themeButton());
  syncControls(currentTheme());
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-theme-trigger]")) {
      syncControls(currentTheme());
      dialog.querySelector("#theme-status").textContent = `已选${currentTheme().name}`;
      dialog.showModal(); dialog.querySelector("input:checked").focus();
    }
    if (event.target.closest("[data-theme-close]")) dialog.close();
  });
  dialog.addEventListener("change", (event) => { if (event.target.name === "workbench-theme") apply(event.target.value); });
  window.addEventListener("storage", (event) => { if (event.key === storageKey || event.key === null) apply(event.newValue, false); });
}
