import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '1mb' }));

  // 内存存储当前的路径数据 (生产环境建议用数据库)
  let currentRoute: any = null;

  // 接口 1: Web 端同步路径
  app.post("/api/sync-route", (req, res) => {
    currentRoute = req.body;
    console.log("Route synced from web. Points:", currentRoute?.points?.length);
    res.json({ status: "success", message: "路径已同步到云端" });
  });

  // 接口 2: ESP32 获取路径
  app.get("/api/device-route", (req, res) => {
    if (!currentRoute) {
      return res.status(404).json({ status: "error", message: "没有待处理的路径" });
    }
    res.json(currentRoute);
  });

  // Vite 插件集成
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist/index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
