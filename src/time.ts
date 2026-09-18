// 时间工具：把 Date 渲染成“参考 ISO 字符串”所在时区的带偏移时间串，
// 让复诊时间线里同一事件的通知/升级时间与传感器原始时间保持同一时区显示。

export function offsetOf(referenceIso: string): string {
  const m = /([zZ]|[+-]\d{2}:\d{2})$/.exec(referenceIso);
  if (!m) return "Z";
  const z = m[1]!;
  return z === "Z" || z === "z" ? "Z" : z;
}

function offsetMinutes(offset: string): number {
  if (offset === "Z") return 0;
  const sign = offset[0] === "-" ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return sign * (hours * 60 + minutes);
}

function pad(n: number, width = 2): string {
  return String(Math.trunc(Math.abs(n))).padStart(width, "0");
}

/** 将 date 按 referenceIso 的 UTC 偏移格式化为 ISO 字符串 */
export function formatInOffset(date: Date, referenceIso: string): string {
  const offset = offsetOf(referenceIso);
  const shifted = new Date(date.getTime() + offsetMinutes(offset) * 60_000);
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1);
  const d = pad(shifted.getUTCDate());
  const h = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  const se = pad(shifted.getUTCSeconds());
  const ms = shifted.getUTCMilliseconds();
  const msPart = ms === 0 ? "" : `.${pad(ms, 3)}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}${msPart}${offset}`;
}
