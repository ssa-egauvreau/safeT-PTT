import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "security-radio-api" });
});

app.get("/v1/channels", (_req, res) => {
  const channels = Array.from({ length: 16 }, (_, index) => ({
    id: index + 1,
    name: `CH ${String(index + 1).padStart(2, "0")}`,
  }));
  res.json({ channels });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`Security Radio API listening on ${port}`);
});
