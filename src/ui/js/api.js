async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.details = Array.isArray(data?.errors) ? data.errors : null;
    throw error;
  }

  return data;
}

export const api = {
  get(path) {
    return request("GET", path);
  },
  post(path, body) {
    return request("POST", path, body ?? {});
  },
  put(path, body) {
    return request("PUT", path, body);
  },
  patch(path, body) {
    return request("PATCH", path, body);
  },
  del(path) {
    return request("DELETE", path);
  },
};