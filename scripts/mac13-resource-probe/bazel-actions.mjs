/** Bounded effective-action references shared by the pinned Mac voice build proofs. */
const check = (value, message) => { if (!value) throw new Error(message); };

export function actionRows(value) {
  check(Array.isArray(value) && value.length <= 50_000, 'Mac voice action graph list is missing or excessive');
  return value;
}

export function actionIds(value) {
  return actionRows(value ?? []).map(id => {
    check(/^[1-9]\d{0,12}$/.test(String(id)), 'Mac voice action graph id refused');
    return String(id);
  });
}

export function actionIndex(value) {
  const result = new Map();
  for (const row of actionRows(value)) {
    const [id] = actionIds([row.id]);
    check(!result.has(id), 'Mac voice action graph has duplicate ids');
    result.set(id, row);
  }
  return result;
}

export function actionRequired(map, id) {
  const value = map.get(String(id));
  check(value, 'Mac voice action graph reference is missing');
  return value;
}

export function actionPath(fragments, id) {
  const segments = [];
  const seen = new Set();
  while (id && String(id) !== '0') {
    check(!seen.has(String(id)) && seen.size < 128, 'Mac voice artifact path cycle or depth refused');
    seen.add(String(id));
    const row = actionRequired(fragments, id);
    check(typeof row.label === 'string' && /^[A-Za-z0-9_+~.@-]+$/.test(row.label) && !['.', '..'].includes(row.label), 'Mac voice artifact path segment refused');
    segments.unshift(row.label);
    id = row.parentId;
  }
  return segments.join('/');
}
