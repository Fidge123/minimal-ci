const { Webhooks, createNodeMiddleware } = require("@octokit/webhooks");
const { readFileSync } = require("fs");
const cp = require("child_process");
const { promisify } = require("util");

const exec = promisify(cp.exec);

const webhooks = new Webhooks({
  secret: process.env.SECRET,
});

const configurations = JSON.parse(
  readFileSync("config.json", { encoding: "utf-8" })
);

webhooks.on("push", async ({ payload }) => {
  console.log("Event received!");
  console.log("Repo:", payload.repository.full_name);

  const config = configurations.find(
    (c) => c.repository === payload.repository.full_name
  );

  if (
    config &&
    payload.repository.default_branch === payload.ref.split("/")[2]
  ) {
    console.log("Pulling");
    await exec("git pull", { cwd: config.cwd });

    for (const { command, cwd } of config.commands) {
      console.log(`Executing ${command} at ${cwd}`);
      await exec(command, { cwd });
    }
    console.log("All done!");
  }
});

require("http")
  .createServer(
    createNodeMiddleware(webhooks, {
      path: process.env.URLPATH || "/",
      onUnhandledRequest(req, res) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            request: {
              url: req.url,
              method: req.method,
              headers: req.headers,
              body: req.body,
            },
            error: "Unhandled request",
          })
        );
      },
    })
  )
  .listen(process.env.PORT || 8080);
