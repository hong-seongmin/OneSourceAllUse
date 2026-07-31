const SOURCE_KEY = /^source_[1-9]\d*$/u;

export function qualifiedSourceHandle(sourceKey, positionLabel) {
  const key = String(sourceKey || '').trim();
  const position = String(positionLabel || '').trim();
  if (!SOURCE_KEY.test(key) || !position) {
    throw new TypeError('A persisted source key and position label are required.');
  }
  return `${key}::${position}`;
}

export function atomSourceHandle(atom) {
  const explicit = String(atom?.handle || '').trim();
  if (explicit) return explicit;
  const position = String(atom?.position_label || '').trim();
  if (!position) return '';
  return atom?.source_key
    ? qualifiedSourceHandle(atom.source_key, position)
    : position;
}

export function withSourceHandle(atom) {
  return {
    ...atom,
    handle: atomSourceHandle(atom)
  };
}

export function sourceFingerprintKey(atom) {
  const fingerprint = String(atom?.fingerprint || '').trim();
  if (!fingerprint) return '';
  const sourceItemId = String(atom?.source_item_id || '').trim();
  return sourceItemId ? `${sourceItemId}::${fingerprint}` : fingerprint;
}
