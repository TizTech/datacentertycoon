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
  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  try {
    const { key, save } = req.body || {};
    if (!key || typeof key !== "string" || key.length > 128) {
      return json(res, 400, { error: "invalid_key" });
    }
    if (!save || typeof save !== "object") {
      return json(res, 400, { error: "invalid_save_payload" });
    }

    const value = Buffer.from(JSON.stringify(save), "utf8").toString("base64");
    await kvCommand("set", [`save:${key}`, value]);
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 500, { error: "save_failed" });
  }
};
