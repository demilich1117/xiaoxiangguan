// Fixed SVG shapes keep statuses distinct across fonts, themes and color vision.
const states = {
  not_started: ["未开始", '<circle cx="10" cy="10" r="6.5"/>'],
  extracting: ["提取中", '<path d="M10 2v10m-3-3 3 3 3-3M3 13v4h14v-4"/>'],
  extracted: ["已提取", '<path d="M5 2.5h7l3 3V17.5H5zM12 2.5v4h3M8 10h4M8 13h4"/>'],
  translating: ["翻译中", '<path d="M3 6h13m-3-3 3 3-3 3M17 14H4m3-3-3 3 3 3"/>'],
  drafted: ["已初译", '<path d="M5 2.5h7l3 3V17.5H5zM12 2.5v4h3M7.5 12l2 2 3.5-4"/>'],
  review: ["待校订", '<path d="m12.5 3.5 4 4M3 17l1-5L13.5 2.5a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2L8 16z"/>'],
  approved: ["已批准", '<circle cx="10" cy="10" r="7"/><path d="m6.5 10 2.5 2.5 4.5-5"/>'],
  failed: ["失败", '<path d="m10 2 8 15H2zM10 7v4m0 3v.2"/>'],
  queued: ["排队中", '<circle cx="10" cy="10" r="7"/><path d="M10 5.5V10l3 2"/>'],
  completed: ["已完成", '<path d="m2 10 4 4L14 6m-4 7 1 1 7-8"/>'],
  paused: ["已暂停", '<rect x="5" y="3" width="3" height="14" rx=".5"/><rect x="12" y="3" width="3" height="14" rx=".5"/>'],
  running: ["运行中", '<path d="m6 3 11 7-11 7z"/>'],
  cancelled: ["已取消", '<circle cx="10" cy="10" r="7"/><path d="m7.5 7.5 5 5m0-5-5 5"/>'],
  suggested: ["待确认", '<circle cx="10" cy="10" r="7"/><path d="M7.5 7.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 1.5-2.5 3m0 3v.2"/>'],
  open: ["待处理", '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M10 6v5m0 3v.2"/>'],
  resolved: ["已解决", '<path d="m3 10 5 5L17 5"/>']
};
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function statusIcon(value) {
  const shape = (Object.hasOwn(states, value) ? states[value] : states.not_started)[1];
  return `<svg class="status-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shape}</svg>`;
}
export function statusBadge(value, label) {
  const known = Object.hasOwn(states, value);
  const defaultLabel = known ? states[value][0] : value;
  return `<span class="status ${known ? value : "unknown"}">${statusIcon(value)}<span>${escape(label ?? defaultLabel)}</span></span>`;
}
