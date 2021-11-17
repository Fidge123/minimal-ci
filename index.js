const { Webhooks, createNodeMiddleware } = require("@octokit/webhooks");
const { request } = require("@octokit/request");
const { readFileSync, writeFileSync } = require("fs");
const cp = require("child_process");
const nodemailer = require("nodemailer");
const { promisify } = require("util");

const requestWithAuth = request.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
});

const exec = promisify(cp.exec);

const webhooks = new Webhooks({
  secret: process.env.SECRET,
});

const configurations = JSON.parse(
  readFileSync("config.json", { encoding: "utf-8" })
);

for (const config of configurations) {
  webhooks.on(config.on, processEvent);
}

async function processEvent({ payload }) {
  console.log("Event received!");
  console.log("Repo:", payload.repository.full_name);

  if (
    config.repository === payload.repository.full_name &&
    (payload.repository.default_branch === payload.ref?.split("/")[2] ||
      payload.repository.default_branch === payload.workflow_run?.head_branch)
  ) {
    try {
      for (const { command, cwd, timeout } of config.commands) {
        if (command === "downloadArtifact") {
          const res = await requestWithAuth(
            "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
            {
              owner: payload.repository.owner.login,
              repo: payload.repository.name,
              run_id: payload.workflow_run.id,
            }
          );
          for (const artifact of res.data.artifacts) {
            const artifactRes = await requestWithAuth(
              "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
              {
                owner: payload.repository.owner.login,
                repo: payload.repository.name,
                artifact_id: artifact.id,
                archive_format: "zip",
              }
            );
            writeFileSync(
              path.resolve(cwd, "build.zip"),
              Buffer.from(artifactRes.data)
            );
          }
        } else {
          console.log(`Executing ${command} at ${cwd}`);
          const timeoutInMinutes = timeout * 1000 * 60;
          await exec(command, { cwd, timeout: timeoutInMinutes });
        }
      }
      console.log("All done!");
    } catch (err) {
      console.error(err);
      const t = await createTransport();
      t.sendMail({
        from: {
          name: "Minimal CI",
          address: "admin@6v4.de",
        },
        to: config.email,
        subject: "Build failed",
        text: `Build failed at ${new Date().toISOString()}. Please check the logs for more details.`,
      });
      console.error("Build failed");
    }
  }
}

async function createTransport() {
  return nodemailer.createTransport({
    host: "localhost",
    port: 25,
    tls: { servername: "6v4.de" },
  });
}

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
