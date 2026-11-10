export const store = {
  data: null,
  config: null,
  connection: false,
  lastError: null,
  loadedAt: 0,
};

export function setOverview(data) {
  store.data = data;
  store.loadedAt = Date.now();
}

export function setConfig(meta) {
  store.config = meta;
}

export function hasModelData() {
  return Boolean(store.data?.chain?.models);
}