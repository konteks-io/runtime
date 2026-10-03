// A session a person starts directly keeps the agent's own title; Konteks only
// puts "[konteks] " ahead of it, once. Both ACP bridge patches inline this
// function's source, so it must stay self-contained.

export function konteksPrefixedName(prefix, title, max = 160) {
  if (prefix !== "[konteks]") return null;
  const text = String(title ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const named = /^\[konteks[\]/]/u.test(text) ? text : text ? `${prefix} ${text}` : prefix;
  if (named.length <= max) return named;
  let cut = named.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space > prefix.length) cut = cut.slice(0, space);
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
