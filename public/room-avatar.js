export const AVATAR_COLORS = [
  '#2f5d43',
  '#4a6fa5',
  '#a5673f',
  '#7a5c8e',
  '#5c8a72',
  '#a5544a',
];

export function avatarColor(name) {
  const s = String(name || '?');
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

export function avatarInitial(name) {
  const trimmed = String(name || '').trim();
  return (trimmed[0] || '?').toUpperCase();
}

export function avatarHtml(name, sizeClass, escape) {
  const bg = avatarColor(name);
  const initial = escape(avatarInitial(name));
  return `<span class="room-avatar ${sizeClass}" style="background-color:${bg}" aria-hidden="true">${initial}</span>`;
}
