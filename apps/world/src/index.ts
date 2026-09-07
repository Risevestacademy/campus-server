import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/", async () => {
  return { hello: "world" };
});

const port = Number(process.env.PORT ?? 3001);

async function start(): Promise<void> {
  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
