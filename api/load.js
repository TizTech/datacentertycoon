function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function kvCommand(command, args) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("kv_env_missing");
  }

  const response = await fetch(`${baseUrl}/${command}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });

  if (!response.ok) {
    throw new Error(`kv_${command}_${response.status}`);
  }

  return response.json();
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  try {
    const key = String(req.query?.key || "");
    if (!key || key.length > 128) {
      return json(res, 400, { error: "invalid_key" });
    }

    const response = await kvCommand("get", [`save:${key}`]);
    const encoded = response?.result;
    if (!encoded) {
      return json(res, 404, { error: "not_found" });
    }

    const decoded = Buffer.from(String(encoded), "base64").toString("utf8");
    const save = JSON.parse(decoded);
    return json(res, 200, { ok: true, save });
  } catch (err) {
    return json(res, 500, { error: "load_failed" });
  }
};
