const { Webhooks, createNodeMiddleware } = require("@octokit/webhooks");
const { readFileSync } = require("fs");
const { spawnSync } = require("child_process");

const webhooks = new Webhooks({
  secret: process.env.SECRET,
});

const configurations = JSON.parse(
  readFileSync("config.json", { encoding: "utf-8" })
);

webhooks.onAny(({ payload }) => {
  console.log("Event received!");
  console.log("Ref:", payload.ref);
  console.log("Repo:", payload.repository.full_name);

  const config = configurations.find(
    (c) => c.repository === payload.repository.full_name
  );

  if (
    config &&
    payload.repository.default_branch === payload.ref.split("/")[2]
  ) {
    console.log("Pulling");
    spawnSync("git", ["pull"], { cwd: config.cwd });

    for (const { command, args, cwd } of config.commands) {
      console.log(`Executing ${command} ${args.join(" ")} at ${cwd}`);
      spawnSync(command, args, { cwd });
    }
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
